import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeTestApp, signup, createBusiness, addMember, bearer } from './helpers';

describe('Phase 7: signed lead intake', () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let owner: { token: string };
  let manager: { token: string };
  let biz: string;
  let key: { id: string; keyId: string; secret: string };
  const api = () => request(ctx.app);
  const q = <T = any>(sql: string, p: unknown[] = []) => ctx.deps.db.query<T>(sql, p).then((r) => r.rows);
  const intake = (body: object, opts: { keyId?: string; secret?: string; ts?: number } = {}) => {
    const raw = JSON.stringify(body);
    const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac('sha256', opts.secret ?? key.secret).update(`${ts}.${raw}`).digest('hex');
    return api().post('/v1/integrations/lead-intake').set('content-type', 'application/json')
      .set('x-dm-key-id', opts.keyId ?? key.keyId).set('x-dm-timestamp', ts).set('x-dm-signature', sig).send(raw);
  };
  const enquiry = (over: Record<string, unknown> = {}) => ({
    externalId: 'form-row-1', name: 'Ravi Kumar', phone: '98450 12345', interest: 'Weight loss plan', message: 'Evening batch?', formKey: 'gym_enquiry', ...over,
  });

  beforeAll(async () => {
    ctx = await makeTestApp();
    owner = await signup(ctx.app, 'owner@intake.in', 'Owner');
    biz = await createBusiness(ctx.app, owner.token, 'Gold Fitness Kengeri');
    manager = await addMember(ctx.app, owner.token, biz, 'manager@intake.in', 'manager');
  });
  afterAll(async () => { await ctx.deps.db.close(); });

  it('creates an integration key and shows the secret once', async () => {
    const res = await api().post(`/v1/businesses/${biz}/integrations/keys`).set(bearer(owner.token)).send({ name: 'Gold enquiry form' });
    expect(res.status).toBe(201);
    key = { id: res.body.data.id, keyId: res.body.data.keyId, secret: res.body.data.secret };
    expect(key.keyId).toMatch(/^dmk_/);
    expect(key.secret.length).toBeGreaterThan(30);
    const list = await api().get(`/v1/businesses/${biz}/integrations`).set(bearer(owner.token));
    expect(list.body.data.keys[0].keyId).toBe(key.keyId);
    expect(JSON.stringify(list.body)).not.toContain(key.secret);
  });

  it('stores the secret encrypted, never in plaintext', async () => {
    const [row] = await q(`select secret_ciphertext, secret_iv, secret_auth_tag from public.integration_keys where id = $1`, [key.id]);
    expect(JSON.stringify(row)).not.toContain(key.secret);
  });

  it('is limited to owners', async () => {
    expect((await api().post(`/v1/businesses/${biz}/integrations/keys`).set(bearer(manager.token)).send({ name: 'x' })).status).toBe(403);
  });

  it('rejects bad signatures, stale timestamps and unknown keys', async () => {
    const body = enquiry({ externalId: 'auth-1' });
    expect((await intake(body, { secret: 'wrong-secret-wrong-secret-wrong' })).status).toBe(401);
    expect((await intake(body, { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect((await intake(body, { keyId: 'dmk_unknown' })).status).toBe(401);
    expect(await q(`select 1 from public.contacts where business_id = $1 and phone_e164 = '+919845012345'`, [biz])).toHaveLength(0);
  });

  it('creates the contact and a lead in the default pipeline, with the phone normalised', async () => {
    const res = await intake(enquiry());
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ duplicate: false, contactCreated: true });
    const [c] = await q(`select source, phone_e164 from public.contacts where id = $1`, [res.body.data.contactId]);
    expect(c).toMatchObject({ source: 'lead_form', phone_e164: '+919845012345' });
    const [l] = await q(`select source, status, title, stage_id from public.leads where id = $1`, [res.body.data.leadId]);
    expect(l).toMatchObject({ source: 'enquiry_form', status: 'open', title: 'Weight loss plan' });
    expect(l.stage_id).not.toBeNull();
  });

  it('is idempotent on externalId', async () => {
    const res = await intake(enquiry());
    expect(res.status).toBe(200);
    expect(res.body.data.duplicate).toBe(true);
    const [{ n }] = await q(`select count(*)::int as n from public.leads where business_id = $1 and notes = 'Evening batch?'`, [biz]);
    expect(n).toBe(1);
  });

  it('records marketing consent only with the exact consent wording', async () => {
    expect((await intake(enquiry({ externalId: 'consent-no-text', phone: '9876543210', name: 'Asha', consentMarketing: true }))).status).toBe(422);
    const ok = await intake(enquiry({ externalId: 'consent-ok', phone: '9876543210', name: 'Asha', consentMarketing: true, consentText: 'Send me offers on WhatsApp' }));
    expect(ok.status).toBe(202);
    const [cons] = await q(`select status, source, evidence from public.contact_consents where contact_id = $1 and purpose = 'marketing'`, [ok.body.data.contactId]);
    expect(cons).toMatchObject({ status: 'granted', source: 'lead_form' });
    expect(cons.evidence.consentText).toBe('Send me offers on WhatsApp');
  });

  it('never re-subscribes a contact who opted out', async () => {
    const first = await intake(enquiry({ externalId: 'optout-first', phone: '9123456780', name: 'Meena' }));
    await q(`update public.contacts set opted_out_at = now() where id = $1`, [first.body.data.contactId]);
    const again = await intake(enquiry({ externalId: 'optout-second', phone: '9123456780', name: 'Meena', consentMarketing: true, consentText: 'Send me offers' }));
    expect(again.status).toBe(202);
    const grants = await q(`select 1 from public.contact_consents where contact_id = $1 and purpose = 'marketing' and status = 'granted'`, [first.body.data.contactId]);
    expect(grants).toHaveLength(0);
  });

  it('stops accepting a key once it is revoked', async () => {
    const res = await api().post(`/v1/businesses/${biz}/integrations/keys/${key.id}/revoke`).set(bearer(owner.token));
    expect(res.status).toBe(200);
    expect((await intake(enquiry({ externalId: 'after-revoke' }))).status).toBe(401);
  });
});
