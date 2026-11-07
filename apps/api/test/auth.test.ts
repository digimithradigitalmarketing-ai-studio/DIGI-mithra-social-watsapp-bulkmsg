import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeTestApp, PASSWORD, signup, bearer } from './helpers';

describe('authentication (local provider)', () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  beforeAll(async () => { ctx = await makeTestApp(); });
  afterAll(async () => { await ctx.deps.db.close(); });

  it('signs up, returns a session and an httpOnly refresh cookie', async () => {
    const res = await request(ctx.app).post('/v1/auth/signup').send({ email: 'Owner@GoldFitness.in', password: PASSWORD, fullName: 'Gold Owner', acceptTerms: true });
    expect(res.status).toBe(201);
    expect(res.body.data.session.user.email).toBe('owner@goldfitness.in');
    expect(res.body.data.session.aal).toBe('aal1');
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/sp_rt=.+HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(JSON.stringify(res.body)).not.toContain('refreshToken');
  });

  it('rejects duplicate email, weak passwords and missing consent', async () => {
    const dup = await request(ctx.app).post('/v1/auth/signup').send({ email: 'owner@goldfitness.in', password: PASSWORD, fullName: 'X Y', acceptTerms: true });
    expect(dup.status).toBe(409);
    const weak = await request(ctx.app).post('/v1/auth/signup').send({ email: 'weak@x.in', password: 'short', fullName: 'X Y', acceptTerms: true });
    expect(weak.status).toBe(422);
    expect(weak.body.error.details.fields.password).toBeTruthy();
    const terms = await request(ctx.app).post('/v1/auth/signup').send({ email: 'terms@x.in', password: PASSWORD, fullName: 'X Y' });
    expect(terms.status).toBe(422);
  });

  it('logs in with correct credentials only', async () => {
    const bad = await request(ctx.app).post('/v1/auth/login').send({ email: 'owner@goldfitness.in', password: 'Wrong-Passw0rd' });
    expect(bad.status).toBe(401);
    const unknown = await request(ctx.app).post('/v1/auth/login').send({ email: 'nobody@x.in', password: PASSWORD });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.message).toBe(bad.body.error.message);
    const ok = await request(ctx.app).post('/v1/auth/login').send({ email: 'owner@goldfitness.in', password: PASSWORD });
    expect(ok.status).toBe(200);
    const me = await request(ctx.app).get('/v1/me').set(bearer(ok.body.data.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.data.fullName).toBe('Gold Owner');
    expect(me.body.data.isPlatformAdmin).toBe(false);
  });

  it('rejects missing, malformed and forged tokens', async () => {
    expect((await request(ctx.app).get('/v1/me')).status).toBe(401);
    expect((await request(ctx.app).get('/v1/me').set(bearer('abc.def.ghi'))).status).toBe(401);
    const { token } = await signup(ctx.app, 'forge@x.in');
    const [h, p] = token.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    payload.aal = 'aal2';
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${token.split('.')[2]}`;
    expect((await request(ctx.app).get('/v1/me').set(bearer(forged))).status).toBe(401);
  });

  it('refresh requires the CSRF header and rotates the refresh token; reuse revokes the session family', async () => {
    const { cookie } = await signup(ctx.app, 'refresh@x.in');
    const noCsrf = await request(ctx.app).post('/v1/auth/refresh').set('cookie', cookie);
    expect(noCsrf.status).toBe(403);
    const badOrigin = await request(ctx.app).post('/v1/auth/refresh').set('cookie', cookie).set('x-requested-with', 'socialpilot').set('origin', 'https://evil.example');
    expect(badOrigin.status).toBe(403);
    const ok = await request(ctx.app).post('/v1/auth/refresh').set('cookie', cookie).set('x-requested-with', 'socialpilot');
    expect(ok.status).toBe(200);
    const newCookie = (ok.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    expect(newCookie).not.toBe(cookie);
    // replaying the old (rotated) token is treated as theft
    const replay = await request(ctx.app).post('/v1/auth/refresh').set('cookie', cookie).set('x-requested-with', 'socialpilot');
    expect(replay.status).toBe(401);
    const afterRevoke = await request(ctx.app).post('/v1/auth/refresh').set('cookie', newCookie).set('x-requested-with', 'socialpilot');
    expect(afterRevoke.status).toBe(401);
  });

  it('logout invalidates the refresh token', async () => {
    const { cookie, token } = await signup(ctx.app, 'logout@x.in');
    const out = await request(ctx.app).post('/v1/auth/logout').set('cookie', cookie).set(bearer(token)).set('x-requested-with', 'socialpilot');
    expect(out.status).toBe(204);
    const r = await request(ctx.app).post('/v1/auth/refresh').set('cookie', cookie).set('x-requested-with', 'socialpilot');
    expect(r.status).toBe(401);
  });

  it('password reset: no account enumeration, single-use token, old sessions revoked', async () => {
    const { cookie } = await signup(ctx.app, 'reset@x.in');
    const unknown = await request(ctx.app).post('/v1/auth/forgot-password').send({ email: 'ghost@x.in' });
    expect(unknown.status).toBe(202);
    const known = await request(ctx.app).post('/v1/auth/forgot-password').send({ email: 'reset@x.in' });
    expect(known.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    const mail = ctx.deps.mailer.outbox.filter((m) => m.to === 'reset@x.in').at(-1)!;
    const token = new URL(mail.link!).searchParams.get('token')!;
    const newPassword = 'AnotherStr0ngPass';
    expect((await request(ctx.app).post('/v1/auth/reset-password').send({ token, password: newPassword })).status).toBe(200);
    expect((await request(ctx.app).post('/v1/auth/reset-password').send({ token, password: newPassword })).status).toBe(400);
    expect((await request(ctx.app).post('/v1/auth/login').send({ email: 'reset@x.in', password: PASSWORD })).status).toBe(401);
    expect((await request(ctx.app).post('/v1/auth/login').send({ email: 'reset@x.in', password: newPassword })).status).toBe(200);
    expect((await request(ctx.app).post('/v1/auth/refresh').set('cookie', cookie).set('x-requested-with', 'socialpilot')).status).toBe(401);
  });
});

describe('email verification required', () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  beforeAll(async () => { ctx = await makeTestApp({ LOCAL_AUTO_VERIFY_EMAIL: 'false' }); });
  afterAll(async () => { await ctx.deps.db.close(); });

  it('blocks login until the email link is used', async () => {
    const s = await request(ctx.app).post('/v1/auth/signup').send({ email: 'verify@x.in', password: PASSWORD, fullName: 'Verify Me', acceptTerms: true });
    expect(s.status).toBe(201);
    expect(s.body.data).toEqual({ session: null, emailVerificationRequired: true });
    const blocked = await request(ctx.app).post('/v1/auth/login').send({ email: 'verify@x.in', password: PASSWORD });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('email_not_verified');
    const link = ctx.deps.mailer.outbox.find((m) => m.to === 'verify@x.in')!.link!;
    const token = new URL(link).searchParams.get('token')!;
    expect((await request(ctx.app).post('/v1/auth/verify-email').send({ token })).status).toBe(200);
    expect((await request(ctx.app).post('/v1/auth/login').send({ email: 'verify@x.in', password: PASSWORD })).status).toBe(200);
  });
});
