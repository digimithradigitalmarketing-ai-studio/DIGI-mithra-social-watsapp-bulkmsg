import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeTestApp, signup, createBusiness, addMember, bearer } from './helpers';
import { createWorker, type Worker } from '../src/jobs/worker';
import { classifyMetaError } from '../src/whatsapp/errors';
import { buildComponents, resolveAll } from '../src/whatsapp/templates';
import { toPositional } from '@socialpilot/shared';

const sign = (body: string) => 'sha256=' + crypto.createHmac('sha256', 'test-app-secret').update(body).digest('hex');

describe('template variable mapping', () => {
  it('converts named placeholders to Meta positional format and back', () => {
    expect(toPositional('Hi {{customer_name}}, your {{plan}} ends {{membership_expiry}}. Bye {{customer_name}}')).toEqual({
      text: 'Hi {{1}}, your {{2}} ends {{3}}. Bye {{1}}', mapping: { 1: 'customer_name', 2: 'plan', 3: 'membership_expiry' },
    });
    const { components, mapping } = buildComponents({ body: 'Hi {{customer_name}} from {{business_name}}!', examples: { customer_name: 'Ravi', business_name: 'Gold Fitness' } });
    expect(components[0]).toMatchObject({ type: 'BODY', text: 'Hi {{1}} from {{2}}!', example: { body_text: [['Ravi', 'Gold Fitness']] } });
    const r = resolveAll({ variable_mapping: mapping }, { contact: { name: '', phone_e164: '+91', custom_fields: {} }, businessName: 'Gold', defaults: {} });
    expect(r.missing).toEqual(['customer_name']);
  });
  it('classifies Meta errors', () => {
    expect(classifyMetaError(400, { error: { code: 130429 } }).retryable).toBe(true);
    expect(classifyMetaError(400, { error: { code: 131026 } }).retryable).toBe(false);
    expect(classifyMetaError(400, { error: { code: 131050 } }).effect).toBe('opt_out');
    expect(classifyMetaError(401, { error: { code: 190 } }).effect).toBe('channel_auth');
    expect(classifyMetaError(503, {}).retryable).toBe(true);
  });
});

describe('WhatsApp MVP end-to-end (mock provider)', () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let worker: Worker;
  let owner: { token: string; userId: string };
  let agent: { token: string; userId: string };
  let biz: string;
  let templateId: string;
  let phoneNumberId: string;
  const api = () => request(ctx.app);
  const b = (path: string) => `/v1/businesses/${biz}${path}`;

  beforeAll(async () => {
    ctx = await makeTestApp();
    worker = createWorker(ctx.deps);
    owner = await signup(ctx.app, 'owner@gold.in', 'Gold Owner');
    biz = await createBusiness(ctx.app, owner.token, 'Gold Fitness Kengeri');
    agent = await addMember(ctx.app, owner.token, biz, 'agent@gold.in', 'agent');
  });
  afterAll(async () => { await ctx.deps.db.close(); });

  it('connects a mock WhatsApp channel (owner only)', async () => {
    expect((await api().post(b('/channels/whatsapp')).set(bearer(agent.token)).send({ mode: 'mock' })).status).toBe(403);
    const res = await api().post(b('/channels/whatsapp')).set(bearer(owner.token)).send({ mode: 'mock', displayPhoneNumber: '98450 00000' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ mode: 'mock', status: 'connected' });
    phoneNumberId = res.body.data.phoneNumbers[0].phoneNumberId;
    expect((await api().post(b('/channels/whatsapp')).set(bearer(owner.token)).send({ mode: 'mock' })).status).toBe(409);
  });

  it('creates contacts with E.164 normalisation, consent records and duplicate detection', async () => {
    const tag = await api().post(b('/tags')).set(bearer(owner.token)).send({ name: 'Members' });
    expect(tag.status).toBe(201);
    const c = await api().post(b('/contacts')).set(bearer(owner.token)).send({
      name: 'Ravi Kumar', phone: '98765 43210', tagIds: [tag.body.data.id], customFields: { membership_expiry: '30 Nov' },
      consent: { marketing: true, source: 'Reception paper form' },
    });
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ phone: '+919876543210', marketingOptIn: true, marketingConsentSource: 'Reception paper form' });
    expect((await api().post(b('/contacts')).set(bearer(owner.token)).send({ phone: '+91 98765-43210' })).status).toBe(409);
    expect((await api().post(b('/contacts')).set(bearer(owner.token)).send({ phone: '123' })).status).toBe(422);
    expect((await api().post(b('/contacts')).set(bearer(agent.token)).send({ phone: '9876500001' })).status).toBe(403);
    const consentNoSource = await api().post(b('/contacts')).set(bearer(owner.token)).send({ phone: '9876500002', consent: { marketing: true, source: '' } });
    expect(consentNoSource.status).toBe(422);
  });

  it('imports CSV: dedupes, validates phones, records consent, tags, custom fields', async () => {
    const csv = [
      'Full Name,Mobile,Plan Expiry,Groups',
      'Asha,9876500011,15 Dec,Members;Morning batch',
      'Bharath,+91 98765 00012,,Members',
      'Chitra,98765 00013,20 Dec,Members',
      'Asha again,9876500011,,',
      'Broken,12345,,',
      'Deepa (undeliverable),9876500000,1 Jan,Members',
      'Ekta (rate limited),9876509999,1 Jan,Members',
      '"Farhan, ""Fit""",9876505050,1 Jan,Members',
    ].join('\n');
    const res = await api().post(b('/contacts/import')).set(bearer(owner.token)).send({
      csv, mapping: { 'Full Name': 'name', Mobile: 'phone', 'Plan Expiry': 'custom:membership_expiry', Groups: 'tags' },
      consent: { marketing: true, source: 'Gym enquiry form (Apps Script)', confirmed: true },
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ totalRows: 8, created: 6, skipped: 2 });
    expect(res.body.data.errors.map((e: { message: string }) => e.message).join(' ')).toMatch(/Duplicate.*Invalid phone|Invalid phone.*Duplicate/s);
    const unconfirmed = await api().post(b('/contacts/import')).set(bearer(owner.token)).send({ csv, mapping: { Mobile: 'phone' }, consent: { marketing: true, source: 'x', confirmed: false } });
    expect(unconfirmed.status).toBe(422);
    const list = await api().get(b('/contacts?consent=marketing&pageSize=100')).set(bearer(owner.token));
    expect(list.body.meta.total).toBe(7);
    const farhan = list.body.data.find((c: { phone: string }) => c.phone === '+919876505050');
    expect(farhan.name).toBe('Farhan, "Fit"');
    expect(farhan.customFields.membership_expiry).toBe('1 Jan');
    const tags = await api().get(b('/tags')).set(bearer(owner.token));
    expect(tags.body.data.find((t: { name: string }) => t.name === 'Members').contactCount).toBe(7);
  });

  it('adds contacts that must be excluded: no consent, opted out, suppressed', async () => {
    const members = (await api().get(b('/tags')).set(bearer(owner.token))).body.data.find((t: { name: string }) => t.name === 'Members').id;
    await api().post(b('/contacts')).set(bearer(owner.token)).send({ name: 'No Consent', phone: '9876500020', tagIds: [members], customFields: { membership_expiry: 'x' } });
    const opted = await api().post(b('/contacts')).set(bearer(owner.token)).send({ name: 'Opted Out', phone: '9876500022', tagIds: [members], customFields: { membership_expiry: 'x' }, consent: { marketing: true, source: 'form' } });
    const revoke = await api().post(b(`/contacts/${opted.body.data.id}/consents`)).set(bearer(owner.token)).send({ purpose: 'marketing', status: 'revoked', source: 'Customer asked at reception' });
    expect(revoke.status).toBe(201);
    const detail = await api().get(b(`/contacts/${opted.body.data.id}`)).set(bearer(owner.token));
    expect(detail.body.data.contact.optedOutAt).toBeTruthy();
    expect(detail.body.data.consents.map((c: { status: string }) => c.status)).toEqual(['revoked', 'granted']);
    // consent history is append-only
    await expect(ctx.deps.db.query(`update public.contact_consents set status = 'granted' where contact_id = $1`, [opted.body.data.id])).rejects.toThrow(/append-only/);
  });

  it('templates: create with named variables, mock review approves; unapproved templates cannot be scheduled', async () => {
    const bad = await api().post(b('/templates')).set(bearer(owner.token)).send({ name: 'renewal', language: 'en', category: 'MARKETING', body: 'Hi {{customer_name}}' });
    expect(bad.status).toBe(422); // missing example + ends with variable
    const t = await api().post(b('/templates')).set(bearer(owner.token)).send({
      name: 'membership_renewal', language: 'en', category: 'MARKETING',
      headerText: 'Membership reminder', body: 'Hi {{customer_name}}, your {{business_name}} membership expires on {{membership_expiry}}. Reply STOP to opt out.',
      footerText: 'Gold Fitness Kengeri', examples: { customer_name: 'Ravi', business_name: 'Gold Fitness', membership_expiry: '30 Nov' },
    });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    expect(t.body.data).toMatchObject({ status: 'DRAFT', variables: ['customer_name', 'business_name', 'membership_expiry'] });
    templateId = t.body.data.id;

    const draft = await api().post(b('/campaigns')).set(bearer(owner.token)).send({ name: 'Too early', templateId, audience: { type: 'all' } });
    const blocked = await api().post(b(`/campaigns/${draft.body.data.id}/schedule`)).set(bearer(owner.token)).send({});
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.message).toMatch(/approved/i);
    await api().delete(b(`/campaigns/${draft.body.data.id}`)).set(bearer(owner.token));

    const sub = await api().post(b(`/templates/${templateId}/submit`)).set(bearer(owner.token));
    expect(sub.body.data.status).toBe('PENDING');
    await worker.drain();
    const list = await api().get(b('/templates')).set(bearer(owner.token));
    expect(list.body.data.find((x: { id: string }) => x.id === templateId).status).toBe('APPROVED');
  });

  it('runs a full campaign: preview → schedule → paced send → receipts → reports → replies', async () => {
    const members = (await api().get(b('/tags')).set(bearer(owner.token))).body.data.find((t: { name: string }) => t.name === 'Members').id;
    const c = await api().post(b('/campaigns')).set(bearer(owner.token)).send({ name: 'November renewals', templateId, audience: { type: 'tags', tagIds: [members] } });
    expect(c.status).toBe(201);
    const id = c.body.data.id;
    // Bharath has no membership_expiry, so he is skipped until a campaign-level default is provided
    const before = await api().post(b(`/campaigns/${id}/preview`)).set(bearer(owner.token));
    expect(before.body.data).toMatchObject({ eligible: 6, skipped: { missing_variable: 1, no_consent: 1, opted_out: 1 } });
    await api().patch(b(`/campaigns/${id}`)).set(bearer(owner.token)).send({ variableDefaults: { membership_expiry: 'the end of this month' } });
    expect((await api().post(b(`/campaigns/${id}/schedule`)).set(bearer(agent.token)).send({})).status).toBe(403);

    const preview = await api().post(b(`/campaigns/${id}/preview`)).set(bearer(owner.token));
    expect(preview.status).toBe(200);
    // 7 opted-in + No Consent + Opted Out = 9 in audience
    expect(preview.body.data).toMatchObject({ audienceSize: 9, eligible: 7, skipped: { no_consent: 1, opted_out: 1 }, blockers: [] });
    expect(preview.body.data.sample[0].rendered).toMatch(/^Hi Ravi Kumar, your Gold Fitness Kengeri membership expires on 30 Nov/);

    const sched = await api().post(b(`/campaigns/${id}/schedule`)).set(bearer(owner.token)).send({});
    expect(sched.body.data.status).toBe('scheduled');
    // duplicate scheduling is rejected
    expect((await api().post(b(`/campaigns/${id}/schedule`)).set(bearer(owner.token)).send({})).status).toBe(409);

    await worker.drain();

    const done = await api().get(b(`/campaigns/${id}`)).set(bearer(owner.token));
    // 7 eligible: 0000 permanent fail, 9999 retries exhausted, 5050 accepted then failed webhook; 4 succeed
    expect(done.body.data.status).toBe('partially_completed');
    expect(done.body.data.stats).toMatchObject({ total: 9, skipped: 2, pending: 0, failed: 3, sent: 4, delivered: 4 });
    expect(done.body.data.stats.read).toBeGreaterThan(0);

    const failed = await api().get(b(`/campaigns/${id}/recipients?status=failed`)).set(bearer(owner.token));
    const codes = failed.body.data.map((r: { errorCode: string }) => r.errorCode).sort();
    expect(codes).toEqual(['130429', '131026', '131049']);
    expect(failed.body.data.find((r: { errorCode: string }) => r.errorCode === '130429').attempts).toBe(5);

    // Dead-letter queue contains the retry-exhausted send
    const dlq = await ctx.deps.db.query<{ kind: string; attempts: number }>(`select kind, attempts from public.scheduled_jobs where status = 'failed'`);
    expect(dlq.rows).toEqual([{ kind: 'message.send', attempts: 5 }]);

    // Dashboard reflects real delivery data
    const dash = await api().get(b('/dashboard')).set(bearer(owner.token));
    expect(dash.body.data.messages30d.delivered).toBe(4);
    expect(dash.body.data.messages30d.failed).toBe(3); // 0000 (rejected), 9999 (retries exhausted), 5050 (failed receipt)
    // CSV report
    const csv = await api().get(b(`/campaigns/${id}/report.csv`)).set(bearer(owner.token));
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toContain('skip_reason');

    // Customer reply (through the real webhook processor) marks the recipient as replied
    const reply = await api().post(b('/channels/whatsapp/mock/inbound')).set(bearer(owner.token)).send({ phone: '+919876543210', text: 'Yes, I want to renew!' });
    expect(reply.status).toBe(201);
    const after = await api().get(b(`/campaigns/${id}`)).set(bearer(owner.token));
    expect(after.body.data.stats.replied).toBe(1);
    const conv = await ctx.deps.db.query<{ unread_count: number; last_inbound_at: Date }>(
      `select unread_count, last_inbound_at from public.conversations c join public.contacts ct on ct.id = c.contact_id where ct.phone_e164 = '+919876543210'`);
    expect(conv.rows[0]!.unread_count).toBe(1);
    expect(conv.rows[0]!.last_inbound_at).toBeTruthy();
  });

  it('STOP keyword opts the customer out and suppresses future campaigns; START re-subscribes', async () => {
    await api().post(b('/channels/whatsapp/mock/inbound')).set(bearer(owner.token)).send({ phone: '+919876500011', text: 'stop' });
    const c = await ctx.deps.db.query<{ opted_out_at: Date | null; marketing_opt_in: boolean }>(`select opted_out_at, marketing_opt_in from public.contacts where phone_e164 = '+919876500011'`);
    expect(c.rows[0]).toMatchObject({ marketing_opt_in: false });
    expect(c.rows[0]!.opted_out_at).toBeTruthy();
    const sup = await ctx.deps.db.query(`select reason from public.suppression_lists where phone_e164 = '+919876500011'`);
    expect(sup.rows).toEqual([{ reason: 'stop_keyword' }]);
    await api().post(b('/channels/whatsapp/mock/inbound')).set(bearer(owner.token)).send({ phone: '+919876500011', text: 'START' });
    const c2 = await ctx.deps.db.query<{ opted_out_at: Date | null; marketing_opt_in: boolean }>(`select opted_out_at, marketing_opt_in from public.contacts where phone_e164 = '+919876500011'`);
    expect(c2.rows[0]).toMatchObject({ marketing_opt_in: true, opted_out_at: null });
  });

  it('pause, resume and cancel', async () => {
    const c = await api().post(b('/campaigns')).set(bearer(owner.token)).send({ name: 'Pause test', templateId, audience: { type: 'all' } });
    const id = c.body.data.id;
    await api().post(b(`/campaigns/${id}/schedule`)).set(bearer(owner.token)).send({});
    // run only the start job: materialise recipients but do not send yet
    await ctx.deps.db.query(`update public.scheduled_jobs set run_at = now() where kind = 'campaign.start' and status = 'pending'`);
    await ctx.deps.db.query(`update public.scheduled_jobs set run_at = now() + interval '1 hour' where kind = 'message.send' and status = 'pending'`);
    await worker.tick();
    await ctx.deps.db.query(`update public.scheduled_jobs set run_at = now() + interval '1 hour' where kind = 'message.send' and status = 'pending'`);
    expect((await api().get(b(`/campaigns/${id}`)).set(bearer(owner.token))).body.data.status).toBe('processing');
    expect((await api().post(b(`/campaigns/${id}/pause`)).set(bearer(owner.token))).body.data.status).toBe('paused');
    const pendingJobs = await ctx.deps.db.query<{ n: number }>(`select count(*)::int as n from public.scheduled_jobs where kind = 'message.send' and status = 'pending'`);
    expect(pendingJobs.rows[0]!.n).toBe(0);
    expect((await api().post(b(`/campaigns/${id}/resume`)).set(bearer(owner.token))).body.data.status).toBe('processing');
    const cancel = await api().post(b(`/campaigns/${id}/cancel`)).set(bearer(owner.token));
    expect(cancel.body.data.status).toBe('cancelled');
    await worker.drain();
    const final = await api().get(b(`/campaigns/${id}`)).set(bearer(owner.token));
    expect(final.body.data.status).toBe('cancelled');
    expect(final.body.data.stats.sent).toBe(0);
  });

  it('enforces broadcast quota from the subscription', async () => {
    await ctx.deps.db.query(`update public.subscription_entitlements set limit_value = 2 where business_id = $1 and key = 'broadcasts_monthly'`, [biz]);
    const c = await api().post(b('/campaigns')).set(bearer(owner.token)).send({ name: 'Over quota', templateId, audience: { type: 'all' } });
    const res = await api().post(b(`/campaigns/${c.body.data.id}/schedule`)).set(bearer(owner.token)).send({});
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/2 broadcasts per month/);
  });

  it('enforces the contact limit', async () => {
    await ctx.deps.db.query(`update public.subscription_entitlements set limit_value = 1 where business_id = $1 and key = 'contacts'`, [biz]);
    const res = await api().post(b('/contacts')).set(bearer(owner.token)).send({ phone: '9876500099' });
    expect(res.status).toBe(402);
    await ctx.deps.db.query(`update public.subscription_entitlements set limit_value = 1000 where business_id = $1 and key = 'contacts'`, [biz]);
  });

  it('tenant isolation: another workspace cannot see contacts, templates or campaigns', async () => {
    const other = await signup(ctx.app, 'other@x.in');
    for (const path of ['/contacts', '/templates', '/campaigns', '/tags', '/channels/whatsapp', '/contacts-export.csv'])
      expect((await api().get(b(path)).set(bearer(other.token))).status, path).toBe(404);
    const otherBiz = await createBusiness(ctx.app, other.token, 'Other');
    const list = await api().get(`/v1/businesses/${otherBiz}/contacts`).set(bearer(other.token));
    expect(list.body.meta.total).toBe(0);
  });
});

describe('Meta webhook endpoint', () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let worker: Worker;
  beforeAll(async () => {
    ctx = await makeTestApp();
    worker = createWorker(ctx.deps);
    const owner = await signup(ctx.app, 'w@x.in');
    const biz = await createBusiness(ctx.app, owner.token, 'Webhook Biz');
    // Simulate a real Meta connection row (no token needed for inbound processing)
    const ch = await ctx.deps.db.query<{ id: string }>(`insert into public.connected_channels (business_id, channel, provider, name, status) values ($1, 'whatsapp', 'meta_cloud', 'x', 'connected') returning id`, [biz]);
    const acc = await ctx.deps.db.query<{ id: string }>(`insert into public.whatsapp_accounts (business_id, channel_id, waba_id) values ($1, $2, '1234567890') returning id`, [biz, ch.rows[0]!.id]);
    await ctx.deps.db.query(`insert into public.whatsapp_phone_numbers (business_id, whatsapp_account_id, phone_number_id, display_phone_number) values ($1, $2, '1098765432', '+91 80 0000 0000')`, [biz, acc.rows[0]!.id]);
  });
  afterAll(async () => { await ctx.deps.db.close(); });

  it('answers the GET verification challenge only with the right token', async () => {
    const ok = await request(ctx.app).get('/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=12345');
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('12345');
    expect((await request(ctx.app).get('/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1')).status).toBe(403);
  });

  const inbound = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: '1234567890', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { display_phone_number: '918000000000', phone_number_id: '1098765432' },
      contacts: [{ profile: { name: 'Kiran' }, wa_id: '919900112233' }],
      messages: [{ from: '919900112233', id: 'wamid.TEST1', timestamp: '1762400000', type: 'text', text: { body: 'Hi, what are your timings?' } }],
    } }] }],
  });

  it('rejects missing or invalid signatures', async () => {
    expect((await request(ctx.app).post('/v1/webhooks/meta').set('content-type', 'application/json').send(inbound)).status).toBe(401);
    expect((await request(ctx.app).post('/v1/webhooks/meta').set('content-type', 'application/json').set('x-hub-signature-256', sign(inbound + ' ')).send(inbound)).status).toBe(401);
    const tampered = inbound.replace('timings', 'prices');
    expect((await request(ctx.app).post('/v1/webhooks/meta').set('content-type', 'application/json').set('x-hub-signature-256', sign(inbound)).send(tampered)).status).toBe(401);
  });

  it('accepts signed events once (idempotent) and creates contact, conversation and message', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(ctx.app).post('/v1/webhooks/meta').set('content-type', 'application/json').set('x-hub-signature-256', sign(inbound)).send(inbound);
      expect(res.status).toBe(200);
    }
    // A different delivery of the same message (Meta retry with new envelope) is also deduped by message id
    const retry = inbound.replace('"1234567890"', '"1234567890" ');
    await request(ctx.app).post('/v1/webhooks/meta').set('content-type', 'application/json').set('x-hub-signature-256', sign(retry)).send(retry);
    await worker.drain();
    const events = await ctx.deps.db.query<{ status: string }>(`select status from public.webhook_events order by received_at`);
    expect(events.rows.map((e) => e.status).sort()).toEqual(['ignored', 'processed']);
    const msgs = await ctx.deps.db.query<{ body: string; direction: string }>(`select body, direction from public.messages`);
    expect(msgs.rows).toEqual([{ body: 'Hi, what are your timings?', direction: 'inbound' }]);
    const contact = await ctx.deps.db.query<{ name: string; source: string; marketing_opt_in: boolean }>(`select name, source, marketing_opt_in from public.contacts where phone_e164 = '+919900112233'`);
    expect(contact.rows[0]).toEqual({ name: 'Kiran', source: 'whatsapp_inbound', marketing_opt_in: false });
  });

  it('ignores events for unknown phone numbers', async () => {
    const other = inbound.replace('1098765432', '5555555555').replace('wamid.TEST1', 'wamid.TEST2');
    await request(ctx.app).post('/v1/webhooks/meta').set('content-type', 'application/json').set('x-hub-signature-256', sign(other)).send(other);
    await worker.drain();
    expect((await ctx.deps.db.query(`select 1 from public.messages where provider_message_id = 'wamid.TEST2'`)).rows).toHaveLength(0);
  });
});
