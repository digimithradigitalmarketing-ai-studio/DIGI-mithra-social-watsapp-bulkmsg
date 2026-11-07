import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeTestApp, signup, createBusiness, addMember, bearer } from './helpers';
import { createWorker, type Worker } from '../src/jobs/worker';
import { verifyWebhookSignature } from '../src/billing/razorpay';

const WEBHOOK_SECRET = 'whsec_test_123';
const sign = (raw: string) => crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');

describe('Razorpay webhook signature (unit)', () => {
  it('accepts only the HMAC-SHA256 of the exact raw body', () => {
    const raw = Buffer.from('{"event":"subscription.charged"}');
    expect(verifyWebhookSignature(raw, sign(raw.toString()), WEBHOOK_SECRET)).toBe(true);
    expect(verifyWebhookSignature(raw, sign(raw.toString()), 'other-secret')).toBe(false);
    expect(verifyWebhookSignature(Buffer.from('{"event":"x"}'), sign(raw.toString()), WEBHOOK_SECRET)).toBe(false);
    expect(verifyWebhookSignature(raw, undefined, WEBHOOK_SECRET)).toBe(false);
    expect(verifyWebhookSignature(raw, 'short', WEBHOOK_SECRET)).toBe(false);
  });
});

describe('Phase 6: billing (mock provider + Razorpay webhooks)', () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let worker: Worker;
  let owner: { token: string; userId: string };
  let manager: { token: string; userId: string };
  let other: { token: string; userId: string };
  let biz: string;
  let biz2: string;
  const api = () => request(ctx.app);
  const b = (p: string) => `/v1/businesses/${biz}${p}`;
  const q = <T = any>(sql: string, p: unknown[] = []) => ctx.deps.db.query<T>(sql, p).then((r) => r.rows);
  const checkout = (token: string, bizId: string, planCode = 'growth', billingCycle = 'monthly') =>
    api().post(`/v1/businesses/${bizId}/billing/checkout`).set(bearer(token)).send({ planCode, billingCycle });
  const sendWebhook = (event: object, eventId: string, signature = sign(JSON.stringify(event))) =>
    api().post('/v1/webhooks/razorpay').set('content-type', 'application/json').set('x-razorpay-event-id', eventId).set('x-razorpay-signature', signature).send(JSON.stringify(event));

  beforeAll(async () => {
    ctx = await makeTestApp({ RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET });
    worker = createWorker(ctx.deps);
    owner = await signup(ctx.app, 'owner@billing.in', 'Owner');
    biz = await createBusiness(ctx.app, owner.token, 'Gold Fitness Kengeri');
    manager = await addMember(ctx.app, owner.token, biz, 'manager@billing.in', 'manager');
    other = await signup(ctx.app, 'other@billing.in', 'Other Owner');
    biz2 = await createBusiness(ctx.app, other.token, 'Other Gym');
  });
  afterAll(async () => {
    await ctx.deps.db.close();
  });

  it('shows the trial and the mock mode label', async () => {
    const res = await api().get(b('/billing')).set(bearer(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data.mode).toBe('mock');
    expect(res.body.data.subscription.status).toBe('trialing');
    expect(res.body.data.invoices).toEqual([]);
  });

  it('only owners can start a checkout', async () => {
    const res = await checkout(manager.token, biz);
    expect(res.status).toBe(403);
  });

  it('rejects unknown plans and checkouts from another workspace', async () => {
    expect((await checkout(owner.token, biz, 'platinum')).status).toBe(404);
    const cross = await checkout(other.token, biz);
    expect(cross.status).toBe(404);
  });

  it('creates a Razorpay subscription without changing the current plan yet', async () => {
    const res = await checkout(owner.token, biz, 'growth', 'annual');
    expect(res.status).toBe(201);
    expect(res.body.data.mode).toBe('mock');
    expect(res.body.data.subscriptionId).toMatch(/^mock_sub_/);
    expect(res.body.data.keyId).toBeNull(); // no key in mock mode
    const [sub] = await q(`select s.status, s.billing_cycle, s.razorpay_subscription_id, s.pending_billing_cycle, p.code as plan_code,
                                  pp.code as pending_code
                           from public.subscriptions s join public.subscription_plans p on p.id = s.plan_id
                           left join public.subscription_plans pp on pp.id = s.pending_plan_id where s.business_id = $1`, [biz]);
    expect(sub.plan_code).toBe('starter');
    expect(sub.status).toBe('trialing');
    expect(sub.pending_code).toBe('growth');
    expect(sub.pending_billing_cycle).toBe('annual');
    expect(sub.razorpay_subscription_id).toBe(res.body.data.subscriptionId);
  });

  it('mock payment activates the pending plan, syncs entitlements and writes the invoice and payment', async () => {
    expect((await api().post(b('/billing/mock/complete')).set(bearer(owner.token))).status).toBe(202);
    await worker.drain();
    const res = await api().get(b('/billing')).set(bearer(owner.token));
    expect(res.body.data.subscription.status).toBe('active');
    expect(res.body.data.subscription.plan.code).toBe('growth');
    expect(res.body.data.subscription.billingCycle).toBe('annual');
    expect(res.body.data.pendingPlanCode).toBeNull();
    expect(res.body.data.invoices).toHaveLength(1);
    expect(res.body.data.invoices[0].status).toBe('paid');
    expect(res.body.data.invoices[0].totalPaise).toBeGreaterThan(0); // the plan's annual price in paise, GST not yet added
    expect(res.body.data.payments[0]).toMatchObject({ status: 'captured', currency: 'INR' });
    const [ent] = await q(`select limit_value from public.subscription_entitlements where business_id = $1 and key = 'contacts'`, [biz]);
    expect(Number(ent.limit_value)).toBe(5000); // growth plan limit
  });

  it('refuses a second paid checkout while the plan is active', async () => {
    const res = await checkout(owner.token, biz, 'business');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('already_subscribed');
  });

  it('cancel marks the subscription to end at period end', async () => {
    const res = await api().post(b('/billing/cancel')).set(bearer(owner.token));
    expect(res.status).toBe(200);
    const billing = await api().get(b('/billing')).set(bearer(owner.token));
    expect(billing.body.data.cancelAtPeriodEnd).toBe(true);
    expect(billing.body.data.subscription.status).toBe('active'); // access continues to period end
  });

  it('Razorpay webhooks: rejects bad signatures, applies valid events once, ignores stale subscriptions', async () => {
    const owner2 = await signup(ctx.app, 'owner2@billing.in', 'Second Owner');
    const biz3 = await createBusiness(ctx.app, owner2.token, 'Pilot Gym');
    const co = await checkout(owner2.token, biz3, 'business', 'monthly');
    const subId = co.body.data.subscriptionId as string;
    const now = Math.floor(Date.now() / 1000);
    const charged = {
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: subId, notes: { business_id: biz3 }, current_start: now, current_end: now + 2592000 } },
        payment: { entity: { id: 'pay_test_1', amount: 399900, currency: 'INR', status: 'captured', method: 'card', subscription_id: subId, notes: {} } },
      },
    };
    // No / wrong signature is rejected before anything is stored.
    const unsigned = await api().post('/v1/webhooks/razorpay').set('content-type', 'application/json').send(JSON.stringify(charged));
    expect(unsigned.status).toBe(401);
    const forged = await sendWebhook(charged, 'evt_forged', 'deadbeef'.repeat(8));
    expect(forged.status).toBe(401);

    const ok = await sendWebhook(charged, 'evt_charge_1');
    expect(ok.status).toBe(200);
    // Replayed delivery with the same event id is stored once.
    await sendWebhook(charged, 'evt_charge_1');
    await worker.drain();

    const [sub] = await q(`select status, plan_id from public.subscriptions where business_id = $1`, [biz3]);
    expect(sub.status).toBe('active');
    const [{ n: invoices }] = await q(`select count(*)::int as n from public.invoices where business_id = $1`, [biz3]);
    expect(invoices).toBe(1);
    const [{ n: events }] = await q(`select count(*)::int as n from public.webhook_events where provider = 'razorpay' and event_id = 'evt_charge_1'`);
    expect(events).toBe(1);

    // An event for a superseded subscription id cannot change the workspace.
    const stale = { event: 'subscription.halted', payload: { subscription: { entity: { id: 'sub_old_999', notes: { business_id: biz3 } } } } };
    await sendWebhook(stale, 'evt_stale_1');
    await worker.drain();
    const [after] = await q(`select status from public.subscriptions where business_id = $1`, [biz3]);
    expect(after.status).toBe('active');

    // A payment failure for the current subscription puts it past due.
    const halted = { event: 'subscription.halted', payload: { subscription: { entity: { id: subId, notes: { business_id: biz3 } } } } };
    await sendWebhook(halted, 'evt_halt_1');
    await worker.drain();
    const [pd] = await q(`select status from public.subscriptions where business_id = $1`, [biz3]);
    expect(pd.status).toBe('past_due');
  });

  it('isolates billing data between workspaces', async () => {
    const res = await api().get(`/v1/businesses/${biz2}/billing`).set(bearer(owner.token));
    expect(res.status).toBe(404);
    const mine = await api().get(`/v1/businesses/${biz2}/billing`).set(bearer(other.token));
    expect(mine.status).toBe(200);
    expect(mine.body.data.invoices).toEqual([]);
  });
});
