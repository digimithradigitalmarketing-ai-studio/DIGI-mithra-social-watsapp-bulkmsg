import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import * as OTPAuth from 'otpauth';
import { makeTestApp, signup, createBusiness, bearer } from './helpers';

describe('Super Admin', () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let first: { token: string; userId: string };
  let admin: { token: string; userId: string; cookie: string };
  let biz: string;

  beforeAll(async () => {
    ctx = await makeTestApp();
    first = await signup(ctx.app, 'first@public.in', 'First Signup');
    biz = await createBusiness(ctx.app, first.token, 'First Gym');
    admin = await signup(ctx.app, 'admin@digimithra.co.in', 'DigiMithra Admin');
  });
  afterAll(async () => { await ctx.deps.db.close(); });

  it('the first public signup is NOT a Super Admin', async () => {
    expect((await request(ctx.app).get('/v1/admin/overview').set(bearer(first.token))).status).toBe(404);
    expect((await request(ctx.app).get('/v1/me').set(bearer(first.token))).body.data.isPlatformAdmin).toBe(false);
  });

  it('a provisioned admin still needs MFA (aal2) before the console unlocks', async () => {
    await ctx.deps.db.query(`insert into public.platform_admins (user_id, granted_by) values ($1, 'test-operator')`, [admin.userId]);
    const res = await request(ctx.app).get('/v1/admin/overview').set(bearer(admin.token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('mfa_required');

    const enroll = await request(ctx.app).post('/v1/auth/mfa/enroll').set(bearer(admin.token));
    expect(enroll.status).toBe(201);
    const { factorId, secret } = enroll.body.data;
    const wrong = await request(ctx.app).post('/v1/auth/mfa/verify').set(bearer(admin.token)).send({ factorId, code: '000000' });
    expect(wrong.status).toBe(400);
    const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate();
    const ok = await request(ctx.app).post('/v1/auth/mfa/verify').set(bearer(admin.token)).send({ factorId, code });
    expect(ok.status).toBe(200);
    expect(ok.body.data.aal).toBe('aal2');
    admin.token = ok.body.data.accessToken;
    // aal2 survives refresh
    const cookie = (ok.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    const refreshed = await request(ctx.app).post('/v1/auth/refresh').set('cookie', cookie).set('x-requested-with', 'socialpilot');
    expect(refreshed.body.data.aal).toBe('aal2');

    const overview = await request(ctx.app).get('/v1/admin/overview').set(bearer(admin.token));
    expect(overview.status).toBe(200);
    expect(overview.body.data.businesses.total).toBe(1);
    expect(overview.body.data.subscriptions.trialing).toBe(1);
    expect(overview.body.data.revenueByPlan.map((p: { planCode: string }) => p.planCode)).toEqual(['starter', 'growth', 'business']);
  });

  it('MFA alone does not grant admin to a normal user', async () => {
    const enroll = await request(ctx.app).post('/v1/auth/mfa/enroll').set(bearer(first.token));
    const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(enroll.body.data.secret), digits: 6, period: 30 }).generate();
    const ok = await request(ctx.app).post('/v1/auth/mfa/verify').set(bearer(first.token)).send({ factorId: enroll.body.data.factorId, code });
    expect((await request(ctx.app).get('/v1/admin/overview').set(bearer(ok.body.data.accessToken))).status).toBe(404);
  });

  it('suspends and reactivates a workspace with audit trail', async () => {
    expect((await request(ctx.app).post(`/v1/admin/businesses/${biz}/suspend`).set(bearer(admin.token)).send({ reason: 'x' })).status).toBe(422);
    const s = await request(ctx.app).post(`/v1/admin/businesses/${biz}/suspend`).set(bearer(admin.token)).send({ reason: 'Spam complaints from recipients' });
    expect(s.status).toBe(200);
    const locked = await request(ctx.app).get(`/v1/businesses/${biz}`).set(bearer(first.token));
    expect(locked.status).toBe(423);
    expect(locked.body.error.details.reason).toBe('Spam complaints from recipients');
    expect((await request(ctx.app).post(`/v1/admin/businesses/${biz}/reactivate`).set(bearer(admin.token))).status).toBe(200);
    expect((await request(ctx.app).get(`/v1/businesses/${biz}`).set(bearer(first.token))).status).toBe(200);
    const logs = await request(ctx.app).get('/v1/admin/audit-logs?q=admin.business').set(bearer(admin.token));
    expect(logs.body.data.map((l: { action: string }) => l.action)).toEqual(['admin.business_reactivated', 'admin.business_suspended']);
  });

  it('lists and searches businesses; edits plan prices and settings', async () => {
    const list = await request(ctx.app).get('/v1/admin/businesses?q=first').set(bearer(admin.token));
    expect(list.body.meta.total).toBe(1);
    expect(list.body.data[0].ownerEmail).toBe('first@public.in');
    const plans = await request(ctx.app).get('/v1/admin/plans').set(bearer(admin.token));
    const starter = plans.body.data.find((p: { code: string }) => p.code === 'starter');
    expect(starter.monthlyPricePaise).toBe(99900);
    const upd = await request(ctx.app).patch(`/v1/admin/plans/${starter.id}`).set(bearer(admin.token)).send({ monthlyPricePaise: 129900 });
    expect(upd.body.data.monthlyPricePaise).toBe(129900);
    expect((await request(ctx.app).patch(`/v1/admin/plans/${starter.id}`).set(bearer(first.token)).send({ monthlyPricePaise: 0 })).status).toBe(404);
    expect((await request(ctx.app).patch('/v1/admin/settings/signups_enabled').set(bearer(admin.token)).send({ value: 'nope' })).status).toBe(422);
    expect((await request(ctx.app).patch('/v1/admin/settings/signups_enabled').set(bearer(admin.token)).send({ value: false })).status).toBe(200);
    const blocked = await request(ctx.app).post('/v1/auth/signup').send({ email: 'late@x.in', password: 'Str0ngPassw0rd!', fullName: 'Late', acceptTerms: true });
    expect(blocked.status).toBe(403);
    await request(ctx.app).patch('/v1/admin/settings/signups_enabled').set(bearer(admin.token)).send({ value: true });
  });
});
