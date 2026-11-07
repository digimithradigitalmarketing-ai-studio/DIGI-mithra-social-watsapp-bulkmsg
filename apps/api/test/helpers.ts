import request from 'supertest';
import type { Express } from 'express';
import { bootstrap } from '../src/bootstrap';
import { createApp } from '../src/app';
import type { Deps } from '../src/deps';

export const PASSWORD = 'Str0ngPassw0rd!';

export async function makeTestApp(overrides: Record<string, string> = {}): Promise<{ app: Express; deps: Deps }> {
  const deps = await bootstrap({
    APP_ENV: 'test',
    DATABASE_DRIVER: 'pglite',
    PGLITE_DATA_DIR: 'memory',
    AUTH_PROVIDER: 'local',
    LOCAL_JWT_SECRET: 'test-secret-test-secret-test-secret-123',
    LOCAL_AUTO_VERIFY_EMAIL: 'true',
    ADMIN_REQUIRE_MFA: 'true',
    WEB_ORIGINS: 'http://localhost:5173',
    PUBLIC_WEB_URL: 'http://localhost:5173',
    META_APP_SECRET: 'test-app-secret',
    META_WEBHOOK_VERIFY_TOKEN: 'test-verify-token',
    INTEGRATION_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
    JOB_RETRY_BASE_SECONDS: '0',
    CAMPAIGN_SEND_RATE_PER_SECOND: '50',
    ...overrides,
  });
  return { app: createApp(deps), deps };
}

export async function signup(app: Express, email: string, fullName = 'Test User'): Promise<{ token: string; userId: string; cookie: string }> {
  const res = await request(app).post('/v1/auth/signup').send({ email, password: PASSWORD, fullName, acceptTerms: true });
  if (res.status !== 201) throw new Error(`signup failed ${res.status} ${JSON.stringify(res.body)}`);
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  return { token: res.body.data.session.accessToken, userId: res.body.data.session.user.id, cookie };
}

export async function createBusiness(app: Express, token: string, name: string): Promise<string> {
  const res = await request(app).post('/v1/businesses').set('authorization', `Bearer ${token}`).send({ name, industry: 'fitness', city: 'Bengaluru' });
  if (res.status !== 201) throw new Error(`createBusiness failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.id;
}

/** Owner invites `email` with `role`; the invitee signs up and accepts. Returns the invitee's token. */
export async function addMember(app: Express, ownerToken: string, businessId: string, email: string, role: 'manager' | 'agent') {
  const inv = await request(app).post(`/v1/businesses/${businessId}/invitations`).set('authorization', `Bearer ${ownerToken}`).send({ email, role });
  if (inv.status !== 201) throw new Error(`invite failed ${inv.status} ${JSON.stringify(inv.body)}`);
  const token = String(inv.body.data.inviteUrl).split('/invite/')[1]!;
  const user = await signup(app, email, role === 'manager' ? 'Manager Person' : 'Agent Person');
  const acc = await request(app).post('/v1/invitations/accept').set('authorization', `Bearer ${user.token}`).send({ token });
  if (acc.status !== 200) throw new Error(`accept failed ${acc.status} ${JSON.stringify(acc.body)}`);
  return user;
}

export const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
