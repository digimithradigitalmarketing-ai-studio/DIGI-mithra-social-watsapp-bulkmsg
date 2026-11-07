/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from 'node:crypto';
import type { AppConfig } from '../config';
import type { Queryable } from '../db';
import { writeAudit } from '../lib/audit';
import { HttpError, notFound } from '../lib/errors';
import type { BillingProvider } from './razorpay';

const PAID_PLAN_STATES = ['active', 'past_due'];

/** Creates a Razorpay subscription for the chosen plan. The current plan stays in effect until the first charge is confirmed by webhook. */
export async function startCheckout(
  tx: Queryable,
  provider: BillingProvider,
  input: { businessId: string; actorUserId: string; planCode: string; billingCycle: 'monthly' | 'annual'; ip?: string | null; userAgent?: string | null },
) {
  const planRes = await tx.query<any>('select * from public.subscription_plans where code = $1 and is_active', [input.planCode]);
  const plan = planRes.rows[0];
  if (!plan) throw notFound('Plan not found');
  if (plan.monthly_price_paise === 0 && plan.annual_price_paise === 0) throw new HttpError(400, 'free_plan', 'The free plan does not need a payment');

  const current = await tx.query<any>('select status, cancel_at_period_end from public.subscriptions where business_id = $1', [input.businessId]);
  const sub = current.rows[0];
  if (!sub) throw notFound('Subscription not found');
  if (PAID_PLAN_STATES.includes(sub.status) && !sub.cancel_at_period_end)
    throw new HttpError(409, 'already_subscribed', 'This workspace already has an active paid plan. Plan changes are handled by DigiMithra for now.');

  const razorpayPlanId = (input.billingCycle === 'annual' ? plan.razorpay_plan_id_annual : plan.razorpay_plan_id_monthly) || null;
  const planId = razorpayPlanId ?? (provider.mode === 'mock' ? `mock_plan_${plan.code}_${input.billingCycle}` : null);
  if (!planId) throw new HttpError(409, 'plan_not_configured', 'This plan is not yet linked to a Razorpay plan.');

  const created = await provider.createSubscription({
    planId,
    totalCount: input.billingCycle === 'annual' ? 10 : 120,
    notes: { business_id: input.businessId, plan_code: plan.code, billing_cycle: input.billingCycle },
  });

  await tx.query(
    `update public.subscriptions set razorpay_subscription_id = $2, pending_plan_id = $3, pending_billing_cycle = $4, cancel_at_period_end = false
     where business_id = $1`,
    [input.businessId, created.id, plan.id, input.billingCycle],
  );
  await writeAudit(tx, {
    businessId: input.businessId, actorUserId: input.actorUserId, action: 'billing.checkout_started', targetType: 'subscription', targetId: created.id,
    metadata: { planCode: plan.code, billingCycle: input.billingCycle, mode: provider.mode }, ip: input.ip, userAgent: input.userAgent,
  });
  return { mode: provider.mode, keyId: provider.keyId, subscriptionId: created.id, shortUrl: created.shortUrl, planCode: plan.code, billingCycle: input.billingCycle };
}

export async function cancelSubscription(
  tx: Queryable,
  provider: BillingProvider,
  input: { businessId: string; actorUserId: string; ip?: string | null; userAgent?: string | null },
) {
  const r = await tx.query<any>('select razorpay_subscription_id, status from public.subscriptions where business_id = $1', [input.businessId]);
  const sub = r.rows[0];
  if (!sub?.razorpay_subscription_id || ['cancelled', 'expired'].includes(sub.status))
    throw new HttpError(409, 'nothing_to_cancel', 'There is no active subscription to cancel');
  await provider.cancelSubscription(sub.razorpay_subscription_id, true);
  await tx.query('update public.subscriptions set cancel_at_period_end = true where business_id = $1', [input.businessId]);
  await writeAudit(tx, { businessId: input.businessId, actorUserId: input.actorUserId, action: 'billing.cancel_requested', targetType: 'subscription', targetId: sub.razorpay_subscription_id, metadata: { mode: provider.mode }, ip: input.ip, userAgent: input.userAgent });
}

const toDate = (unix: unknown) => (typeof unix === 'number' && unix > 0 ? new Date(unix * 1000) : null);

/**
 * Applies one Razorpay webhook event. Runs inside a service transaction.
 * Events for a subscription other than the business's current one are ignored, so late or replayed events cannot move a workspace backwards.
 */
export async function applyRazorpayEvent(tx: Queryable, event: { event: string; payload: any }): Promise<'applied' | 'ignored'> {
  const subEntity = event.payload?.subscription?.entity;
  const paymentEntity = event.payload?.payment?.entity;
  const invoiceEntity = event.payload?.invoice?.entity;
  const notes = subEntity?.notes ?? paymentEntity?.notes ?? {};
  const businessId = typeof notes.business_id === 'string' ? notes.business_id : null;
  if (!businessId) return 'ignored';

  const subId: string | null = subEntity?.id ?? paymentEntity?.subscription_id ?? null;
  const sRes = await tx.query<any>(
    `select s.*, p.monthly_price_paise, p.annual_price_paise from public.subscriptions s join public.subscription_plans p on p.id = s.plan_id where s.business_id = $1`,
    [businessId],
  );
  const row = sRes.rows[0];
  if (!row || !subId || row.razorpay_subscription_id !== subId) return 'ignored';

  let applied = true;
  switch (event.event) {
    case 'subscription.activated':
    case 'subscription.charged': {
      // First charge after checkout switches to the pending plan; renewals keep the current one.
      const planId = row.pending_plan_id ?? row.plan_id;
      const cycle = row.pending_billing_cycle ?? row.billing_cycle;
      await tx.query(
        `update public.subscriptions set plan_id = $2, billing_cycle = $3, status = 'active', trial_ends_at = null,
           current_period_start = coalesce($4, current_period_start), current_period_end = coalesce($5, current_period_end),
           cancel_at_period_end = false, razorpay_customer_id = coalesce($6, razorpay_customer_id),
           pending_plan_id = null, pending_billing_cycle = null
         where business_id = $1`,
        [businessId, planId, cycle, toDate(subEntity.current_start), toDate(subEntity.current_end), subEntity.customer_id ?? null],
      );
      const plan = (await tx.query<any>('select limits from public.subscription_plans where id = $1', [planId])).rows[0];
      for (const [key, value] of Object.entries<any>(plan?.limits ?? {})) {
        await tx.query(
          `insert into public.subscription_entitlements (business_id, key, limit_value, source) values ($1, $2, $3, 'plan')
           on conflict (business_id, key) do update set limit_value = excluded.limit_value, source = 'plan'
           where public.subscription_entitlements.source = 'plan'`,
          [businessId, key, Number(value)],
        );
      }
      if (event.event === 'subscription.charged' && paymentEntity?.id) {
        await recordPayment(tx, {
          businessId, providerPaymentId: paymentEntity.id, status: 'captured', amountPaise: Number(paymentEntity.amount ?? (cycle === 'annual' ? row.annual_price_paise : row.monthly_price_paise)),
          currency: paymentEntity.currency ?? 'INR', method: paymentEntity.method ?? null, failureReason: null, capturedAt: new Date(), periodStart: toDate(subEntity.current_start), periodEnd: toDate(subEntity.current_end),
          invoiceRazorpayId: invoiceEntity?.id ?? null,
        });
      }
      break;
    }
    case 'subscription.halted':
    case 'subscription.pending':
      await tx.query(`update public.subscriptions set status = 'past_due' where business_id = $1 and status in ('active', 'past_due')`, [businessId]);
      break;
    case 'payment.failed':
      if (paymentEntity?.id)
        await recordPayment(tx, { businessId, providerPaymentId: paymentEntity.id, status: 'failed', amountPaise: Number(paymentEntity.amount ?? 0), currency: paymentEntity.currency ?? 'INR', method: paymentEntity.method ?? null, failureReason: paymentEntity.error_description ?? null, capturedAt: null, periodStart: null, periodEnd: null, invoiceRazorpayId: null });
      await tx.query(`update public.subscriptions set status = 'past_due' where business_id = $1 and status = 'active'`, [businessId]);
      break;
    case 'subscription.paused':
      await tx.query(`update public.subscriptions set status = 'paused' where business_id = $1`, [businessId]);
      break;
    case 'subscription.cancelled':
      await tx.query(`update public.subscriptions set status = 'cancelled', cancel_at_period_end = false where business_id = $1`, [businessId]);
      break;
    case 'subscription.completed':
      await tx.query(`update public.subscriptions set status = 'expired' where business_id = $1`, [businessId]);
      break;
    default:
      applied = false;
  }
  if (!applied) return 'ignored';
  await writeAudit(tx, { businessId, actorType: 'integration', action: `billing.${event.event}`, targetType: 'subscription', targetId: subId, metadata: { paymentId: paymentEntity?.id ?? null } });
  return 'applied';
}

async function recordPayment(
  tx: Queryable,
  p: { businessId: string; providerPaymentId: string; status: 'captured' | 'failed'; amountPaise: number; currency: string; method: string | null; failureReason: string | null; capturedAt: Date | null; periodStart: Date | null; periodEnd: Date | null; invoiceRazorpayId: string | null },
) {
  const exists = await tx.query('select 1 from public.payments where provider_payment_id = $1', [p.providerPaymentId]);
  if (exists.rows.length) return; // replayed event
  let invoiceId: string | null = null;
  if (p.status === 'captured') {
    const number = `DM-${new Date().toISOString().slice(0, 7).replace('-', '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const inv = await tx.query<any>(
      `insert into public.invoices (business_id, number, status, currency, amount_paise, tax_paise, total_paise, period_start, period_end, razorpay_invoice_id, issued_at, paid_at)
       values ($1, $2, 'paid', $3, $4, 0, $4, $5, $6, $7, now(), now()) returning id`,
      [p.businessId, number, p.currency, p.amountPaise, p.periodStart, p.periodEnd, p.invoiceRazorpayId],
    );
    invoiceId = inv.rows[0].id;
  }
  await tx.query(
    `insert into public.payments (business_id, invoice_id, provider, provider_payment_id, amount_paise, currency, status, method, failure_reason, captured_at)
     values ($1, $2, 'razorpay', $3, $4, $5, $6, $7, $8, $9)`,
    [p.businessId, invoiceId, p.providerPaymentId, p.amountPaise, p.currency, p.status, p.method, p.failureReason, p.capturedAt],
  );
}
