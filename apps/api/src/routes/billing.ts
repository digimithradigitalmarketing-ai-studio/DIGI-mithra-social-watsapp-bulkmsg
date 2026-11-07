/* eslint-disable @typescript-eslint/no-explicit-any */
import { Router } from 'express';
import { checkoutSchema } from '@socialpilot/shared';
import type { Deps } from '../deps';
import { withService, withUser } from '../db/context';
import { HttpError, notFound } from '../lib/errors';
import { clientInfo, iso, parse } from '../lib/http';
import { loadSubscription } from '../lib/mappers';
import { randomToken } from '../lib/crypto';
import { writeAudit } from '../lib/audit';
import { enqueue } from '../jobs/queue';
import { createBillingProvider } from '../billing/razorpay';
import { cancelSubscription, startCheckout } from '../billing/service';
import { currentMembership, currentUser, requireAuth, requireMembership, requirePermission } from '../middleware/auth';

export function billingRouter(deps: Deps): Router {
  const r = Router();
  const guard = [requireAuth(deps), requireMembership(deps)];
  const provider = createBillingProvider(deps.config);

  r.get('/businesses/:businessId/billing', ...guard, requirePermission('billing.read'), async (req, res) => {
    const m = currentMembership(req);
    const data = await withUser(deps.db, currentUser(req), async (tx) => {
      const subscription = await loadSubscription(tx, m.businessId);
      const pending = (await tx.query<any>(
        `select s.pending_billing_cycle, s.cancel_at_period_end, p.code as pending_plan_code
         from public.subscriptions s left join public.subscription_plans p on p.id = s.pending_plan_id where s.business_id = $1`,
        [m.businessId],
      )).rows[0];
      const invoices = (await tx.query<any>(
        `select number, status, currency, total_paise, period_start, period_end, paid_at, created_at
         from public.invoices where business_id = $1 order by created_at desc limit 20`,
        [m.businessId],
      )).rows;
      const payments = (await tx.query<any>(
        `select status, amount_paise, currency, method, failure_reason, captured_at, created_at
         from public.payments where business_id = $1 order by created_at desc limit 20`,
        [m.businessId],
      )).rows;
      return {
        mode: provider.mode,
        subscription,
        pendingPlanCode: pending?.pending_plan_code ?? null,
        pendingBillingCycle: pending?.pending_billing_cycle ?? null,
        cancelAtPeriodEnd: !!pending?.cancel_at_period_end,
        invoices: invoices.map((i) => ({ number: i.number, status: i.status, currency: i.currency, totalPaise: Number(i.total_paise), periodStart: iso(i.period_start), periodEnd: iso(i.period_end), paidAt: iso(i.paid_at), createdAt: iso(i.created_at)! })),
        payments: payments.map((p) => ({ status: p.status, amountPaise: Number(p.amount_paise), currency: p.currency, method: p.method, failureReason: p.failure_reason, capturedAt: iso(p.captured_at), createdAt: iso(p.created_at)! })),
      };
    });
    res.json({ data });
  });

  r.post('/businesses/:businessId/billing/checkout', ...guard, requirePermission('billing.manage'), async (req, res) => {
    const m = currentMembership(req);
    const input = parse(checkoutSchema, req.body);
    const user = currentUser(req);
    const data = await withService(deps.db, (tx) =>
      startCheckout(tx, provider, { businessId: m.businessId, actorUserId: user.sub, planCode: input.planCode, billingCycle: input.billingCycle, ...clientInfo(req) }),
    );
    res.status(201).json({ data });
  });

  r.post('/businesses/:businessId/billing/cancel', ...guard, requirePermission('billing.manage'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    await withService(deps.db, (tx) => cancelSubscription(tx, provider, { businessId: m.businessId, actorUserId: user.sub, ...clientInfo(req) }));
    res.json({ data: { cancelAtPeriodEnd: true } });
  });

  /**
   * Mock mode only: simulates Razorpay's subscription.charged webhook for the pending checkout.
   * The event goes through the same webhook_events queue as a real Razorpay delivery, so the processing path is identical.
   */
  r.post('/businesses/:businessId/billing/mock/complete', ...guard, requirePermission('billing.manage'), async (req, res) => {
    if (deps.config.BILLING_PROVIDER !== 'mock') throw notFound('Not available');
    const m = currentMembership(req);
    const user = currentUser(req);
    await withService(deps.db, async (tx) => {
      const row = (await tx.query<any>(
        `select s.razorpay_subscription_id, s.pending_billing_cycle, p.code as plan_code, p.monthly_price_paise, p.annual_price_paise
         from public.subscriptions s join public.subscription_plans p on p.id = s.pending_plan_id where s.business_id = $1`,
        [m.businessId],
      )).rows[0];
      if (!row?.razorpay_subscription_id) throw new HttpError(409, 'no_pending_checkout', 'Start a checkout first');
      const cycle = row.pending_billing_cycle === 'annual' ? 'annual' : 'monthly';
      const amount = cycle === 'annual' ? Number(row.annual_price_paise) : Number(row.monthly_price_paise);
      const now = Math.floor(Date.now() / 1000);
      const event = {
        event: 'subscription.charged',
        payload: {
          subscription: { entity: { id: row.razorpay_subscription_id, notes: { business_id: m.businessId, plan_code: row.plan_code, billing_cycle: cycle }, current_start: now, current_end: now + (cycle === 'annual' ? 365 : 31) * 86400 } },
          payment: { entity: { id: `pay_mock_${randomToken(10)}`, amount, currency: 'INR', status: 'captured', method: 'upi', subscription_id: row.razorpay_subscription_id, notes: { business_id: m.businessId } } },
        },
      };
      const eventId = `mock_evt_${randomToken(12)}`;
      const ins = await tx.query<{ id: string }>(
        `insert into public.webhook_events (provider, event_id, business_id, signature_valid, payload) values ('razorpay', $1, $2, true, $3) returning id`,
        [eventId, m.businessId, JSON.stringify(event)],
      );
      await enqueue(tx, 'webhook.process', { webhookEventId: ins.rows[0]!.id }, { dedupeKey: `wh:${ins.rows[0]!.id}`, maxAttempts: 8 });
      await writeAudit(tx, { businessId: m.businessId, actorUserId: user.sub, action: 'billing.mock_payment_simulated', targetType: 'subscription', targetId: row.razorpay_subscription_id, ...clientInfo(req) });
    });
    res.status(202).json({ data: { queued: true } });
  });

  return r;
}
