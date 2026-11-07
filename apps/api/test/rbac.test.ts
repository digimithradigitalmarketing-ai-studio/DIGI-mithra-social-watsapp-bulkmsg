import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeTestApp, signup, createBusiness, addMember, bearer } from './helpers';
import { withUser } from '../src/db/context';

describe('roles and permissions', () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let owner: { token: string; userId: string };
  let manager: { token: string; userId: string };
  let agent: { token: string; userId: string };
  let biz: string;

  beforeAll(async () => {
    ctx = await makeTestApp();
    owner = await signup(ctx.app, 'owner@gold.in', 'Owner');
    biz = await createBusiness(ctx.app, owner.token, 'Gold Fitness Kengeri');
    await ctx.deps.db.query(`update public.subscription_entitlements set limit_value = 10 where business_id = $1 and key = 'staff_seats'`, [biz]);
    manager = await addMember(ctx.app, owner.token, biz, 'manager@gold.in', 'manager');
    agent = await addMember(ctx.app, owner.token, biz, 'agent@gold.in', 'agent');
  });
  afterAll(async () => { await ctx.deps.db.close(); });

  it('new workspace gets owner membership, trial subscription, entitlements and default pipeline', async () => {
    const res = await request(ctx.app).get(`/v1/businesses/${biz}`).set(bearer(owner.token));
    expect(res.body.data.myRole).toBe('owner');
    expect(res.body.data.subscription.status).toBe('trialing');
    expect(res.body.data.subscription.plan.code).toBe('starter');
    expect(res.body.data.timezone).toBe('Asia/Kolkata');
    expect(res.body.data.currency).toBe('INR');
    const stages = await ctx.deps.db.query<{ n: number }>('select count(*)::int as n from public.lead_stages where business_id = $1', [biz]);
    expect(stages.rows[0]!.n).toBe(6);
  });

  it('only owners can edit the business profile', async () => {
    expect((await request(ctx.app).patch(`/v1/businesses/${biz}`).set(bearer(agent.token)).send({ city: 'Mysuru' })).status).toBe(403);
    expect((await request(ctx.app).patch(`/v1/businesses/${biz}`).set(bearer(manager.token)).send({ city: 'Mysuru' })).status).toBe(403);
    const ok = await request(ctx.app).patch(`/v1/businesses/${biz}`).set(bearer(owner.token)).send({ city: 'Bengaluru', address: 'Kengeri Satellite Town' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.address).toBe('Kengeri Satellite Town');
  });

  it('managers can invite agents but not managers; agents cannot invite', async () => {
    expect((await request(ctx.app).post(`/v1/businesses/${biz}/invitations`).set(bearer(manager.token)).send({ email: 'm2@gold.in', role: 'manager' })).status).toBe(403);
    expect((await request(ctx.app).post(`/v1/businesses/${biz}/invitations`).set(bearer(manager.token)).send({ email: 'a2@gold.in', role: 'agent' })).status).toBe(201);
    expect((await request(ctx.app).post(`/v1/businesses/${biz}/invitations`).set(bearer(agent.token)).send({ email: 'a3@gold.in', role: 'agent' })).status).toBe(403);
    expect((await request(ctx.app).post(`/v1/businesses/${biz}/invitations`).set(bearer(owner.token)).send({ email: 'a2@gold.in', role: 'agent' })).status).toBe(409);
    expect((await request(ctx.app).post(`/v1/businesses/${biz}/invitations`).set(bearer(owner.token)).send({ email: 'agent@gold.in', role: 'agent' })).status).toBe(409);
  });

  it('role changes respect the hierarchy and protect the last owner', async () => {
    const members = (await request(ctx.app).get(`/v1/businesses/${biz}/members`).set(bearer(owner.token))).body.data;
    const id = (email: string) => members.find((m: { email: string }) => m.email === email).id;
    // manager cannot promote an agent to manager, nor touch the owner
    expect((await request(ctx.app).patch(`/v1/businesses/${biz}/members/${id('agent@gold.in')}`).set(bearer(manager.token)).send({ role: 'manager' })).status).toBe(403);
    expect((await request(ctx.app).patch(`/v1/businesses/${biz}/members/${id('owner@gold.in')}`).set(bearer(manager.token)).send({ status: 'disabled' })).status).toBe(403);
    // nobody changes their own role
    expect((await request(ctx.app).patch(`/v1/businesses/${biz}/members/${id('owner@gold.in')}`).set(bearer(owner.token)).send({ role: 'agent' })).status).toBe(403);
    // agent cannot manage anyone
    expect((await request(ctx.app).delete(`/v1/businesses/${biz}/members/${id('manager@gold.in')}`).set(bearer(agent.token))).status).toBe(403);
    // owner can promote/demote
    const promoted = await request(ctx.app).patch(`/v1/businesses/${biz}/members/${id('agent@gold.in')}`).set(bearer(owner.token)).send({ role: 'manager' });
    expect(promoted.status).toBe(200);
    expect(promoted.body.data.role).toBe('manager');
    await request(ctx.app).patch(`/v1/businesses/${biz}/members/${id('agent@gold.in')}`).set(bearer(owner.token)).send({ role: 'agent' });
  });

  it('agents can read the dashboard but not the audit log', async () => {
    expect((await request(ctx.app).get(`/v1/businesses/${biz}/dashboard`).set(bearer(agent.token))).status).toBe(200);
    expect((await request(ctx.app).get(`/v1/businesses/${biz}/audit-logs`).set(bearer(agent.token))).status).toBe(403);
    const log = await request(ctx.app).get(`/v1/businesses/${biz}/audit-logs`).set(bearer(owner.token));
    expect(log.status).toBe(200);
    expect(log.body.data.map((x: { action: string }) => x.action)).toEqual(expect.arrayContaining(['business.created', 'invitation.accepted', 'member.updated']));
  });

  it('RLS: agents only see their assigned conversations and the unassigned queue', async () => {
    const c1 = await ctx.deps.db.query<{ id: string }>(`insert into public.contacts (business_id, phone_e164) values ($1, '+919800000001') returning id`, [biz]);
    const c2 = await ctx.deps.db.query<{ id: string }>(`insert into public.contacts (business_id, phone_e164) values ($1, '+919800000002') returning id`, [biz]);
    const c3 = await ctx.deps.db.query<{ id: string }>(`insert into public.contacts (business_id, phone_e164) values ($1, '+919800000003') returning id`, [biz]);
    await ctx.deps.db.query(`insert into public.conversations (business_id, contact_id, assigned_to) values ($1, $2, $3)`, [biz, c1.rows[0]!.id, agent.userId]);
    await ctx.deps.db.query(`insert into public.conversations (business_id, contact_id, assigned_to) values ($1, $2, $3)`, [biz, c2.rows[0]!.id, manager.userId]);
    await ctx.deps.db.query(`insert into public.conversations (business_id, contact_id) values ($1, $2)`, [biz, c3.rows[0]!.id]);
    const agentSees = await withUser(ctx.deps.db, { sub: agent.userId, email: 'agent@gold.in', aal: 'aal1' }, (tx) => tx.query('select id from public.conversations'));
    expect(agentSees.rows).toHaveLength(2);
    const managerSees = await withUser(ctx.deps.db, { sub: manager.userId, email: 'manager@gold.in', aal: 'aal1' }, (tx) => tx.query('select id from public.conversations'));
    expect(managerSees.rows).toHaveLength(3);
    const dash = await request(ctx.app).get(`/v1/businesses/${biz}/dashboard`).set(bearer(agent.token));
    expect(dash.body.data.totals.openConversations).toBe(2);
  });

  it('invitations: only the invited email can accept, and tokens are single-use', async () => {
    const inv = await request(ctx.app).post(`/v1/businesses/${biz}/invitations`).set(bearer(owner.token)).send({ email: 'target@gold.in', role: 'agent' });
    const token = inv.body.data.inviteUrl.split('/invite/')[1];
    const stranger = await signup(ctx.app, 'stranger@gold.in');
    expect((await request(ctx.app).post('/v1/invitations/accept').set(bearer(stranger.token)).send({ token })).status).toBe(403);
    const target = await signup(ctx.app, 'target@gold.in');
    expect((await request(ctx.app).post('/v1/invitations/accept').set(bearer(target.token)).send({ token })).status).toBe(200);
    expect((await request(ctx.app).post('/v1/invitations/accept').set(bearer(target.token)).send({ token })).status).toBe(410);
  });

  it('seat limits from the subscription are enforced', async () => {
    await ctx.deps.db.query(`update public.subscription_entitlements set limit_value = 2 where business_id = $1 and key = 'staff_seats'`, [biz]);
    const res = await request(ctx.app).post(`/v1/businesses/${biz}/invitations`).set(bearer(owner.token)).send({ email: 'over@gold.in', role: 'agent' });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('seat_limit_reached');
  });

  it('per-user workspace cap is enforced', async () => {
    const u = await signup(ctx.app, 'cap@x.in');
    for (let i = 0; i < 3; i++) await createBusiness(ctx.app, u.token, `Workspace ${i}`);
    const res = await request(ctx.app).post('/v1/businesses').set(bearer(u.token)).send({ name: 'One too many' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('workspace_limit_reached');
  });
});
