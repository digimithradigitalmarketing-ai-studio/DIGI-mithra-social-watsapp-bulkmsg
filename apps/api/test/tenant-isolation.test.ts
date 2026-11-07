import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeTestApp, signup, createBusiness, bearer } from './helpers';
import { withUser } from '../src/db/context';

describe('tenant isolation', () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let a: { token: string; userId: string };
  let b: { token: string; userId: string };
  let bizA: string;
  let bizB: string;

  beforeAll(async () => {
    ctx = await makeTestApp();
    a = await signup(ctx.app, 'a@gold.in', 'Owner A');
    b = await signup(ctx.app, 'b@other.in', 'Owner B');
    bizA = await createBusiness(ctx.app, a.token, 'Gold Fitness Kengeri');
    bizB = await createBusiness(ctx.app, b.token, 'Other Gym');
    // seed a contact + credential for tenant A via the service connection
    await ctx.deps.db.query(`insert into public.contacts (business_id, name, phone_e164) values ($1, 'Ravi', '+919876543210')`, [bizA]);
    await ctx.deps.db.query(
      `insert into public.integration_credentials (business_id, provider, label, ciphertext, iv, auth_tag) values ($1, 'meta_whatsapp', 'default', 'x', 'y', 'z')`,
      [bizA],
    );
  });
  afterAll(async () => { await ctx.deps.db.close(); });

  const crossTenantRoutes = (id: string) => [
    ['get', `/v1/businesses/${id}`],
    ['patch', `/v1/businesses/${id}`],
    ['get', `/v1/businesses/${id}/members`],
    ['get', `/v1/businesses/${id}/invitations`],
    ['post', `/v1/businesses/${id}/invitations`],
    ['get', `/v1/businesses/${id}/dashboard`],
    ['get', `/v1/businesses/${id}/audit-logs`],
  ] as const;

  it('API: tenant B gets 404 on every tenant-A route (existence is not revealed)', async () => {
    for (const [method, url] of crossTenantRoutes(bizA)) {
      const res = await request(ctx.app)[method](url).set(bearer(b.token)).send({ name: 'Hacked', email: 'x@y.in', role: 'agent' });
      expect(res.status, `${method} ${url}`).toBe(404);
    }
    const stillOk = await request(ctx.app).get(`/v1/businesses/${bizA}`).set(bearer(a.token));
    expect(stillOk.body.data.name).toBe('Gold Fitness Kengeri');
  });

  it('API: workspace list only contains own workspaces', async () => {
    const res = await request(ctx.app).get('/v1/businesses').set(bearer(b.token));
    expect(res.body.data.map((m: { businessId: string }) => m.businessId)).toEqual([bizB]);
  });

  it('RLS: tenant B cannot read or write tenant A rows even with raw SQL', async () => {
    const claimsB = { sub: b.userId, email: 'b@other.in', aal: 'aal1' as const };
    const claimsA = { sub: a.userId, email: 'a@gold.in', aal: 'aal1' as const };
    const seenByB = await withUser(ctx.deps.db, claimsB, (tx) => tx.query('select * from public.contacts'));
    expect(seenByB.rows).toHaveLength(0);
    const seenByA = await withUser(ctx.deps.db, claimsA, (tx) => tx.query('select * from public.contacts'));
    expect(seenByA.rows).toHaveLength(1);

    await expect(
      withUser(ctx.deps.db, claimsB, (tx) => tx.query(`insert into public.contacts (business_id, name, phone_e164) values ($1, 'Evil', '+919999999999')`, [bizA])),
    ).rejects.toMatchObject({ code: '42501' });

    const upd = await withUser(ctx.deps.db, claimsB, (tx) => tx.query(`update public.businesses set name = 'pwned' where id = $1 returning id`, [bizA]));
    expect(upd.rows).toHaveLength(0);
    const bizzes = await withUser(ctx.deps.db, claimsB, (tx) => tx.query('select id from public.businesses'));
    expect(bizzes.rows.map((r: any) => r.id)).toEqual([bizB]);
    const members = await withUser(ctx.deps.db, claimsB, (tx) => tx.query('select business_id from public.business_members'));
    expect(members.rows.every((r: any) => r.business_id === bizB)).toBe(true);
  });

  it('RLS: encrypted credentials and system settings are never readable by signed-in users', async () => {
    const claimsA = { sub: a.userId, email: 'a@gold.in', aal: 'aal1' as const };
    await expect(withUser(ctx.deps.db, claimsA, (tx) => tx.query('select * from public.integration_credentials'))).rejects.toMatchObject({ code: '42501' });
    await expect(withUser(ctx.deps.db, claimsA, (tx) => tx.query('select * from public.system_settings'))).rejects.toMatchObject({ code: '42501' });
    await expect(withUser(ctx.deps.db, claimsA, (tx) => tx.query('select * from public.webhook_events'))).rejects.toMatchObject({ code: '42501' });
  });

  it('RLS: users cannot grant themselves Super Admin or forge audit entries', async () => {
    const claimsA = { sub: a.userId, email: 'a@gold.in', aal: 'aal1' as const };
    await expect(
      withUser(ctx.deps.db, claimsA, (tx) => tx.query(`insert into public.platform_admins (user_id, granted_by) values ($1, 'me')`, [a.userId])),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withUser(ctx.deps.db, claimsA, (tx) => tx.query(`insert into public.audit_logs (business_id, action) values ($1, 'fake')`, [bizA])),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withUser(ctx.deps.db, claimsA, (tx) => tx.query(`insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner')`, [bizB, a.userId])),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('schema: every table in public has RLS enabled and anon has no table privileges', async () => {
    const noRls = await ctx.deps.db.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(noRls.rows).toEqual([]);
    const anon = await ctx.deps.db.query(
      `select table_name, privilege_type from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public'`,
    );
    expect(anon.rows).toEqual([]);
    const tenantTablesWithoutBusinessId = await ctx.deps.db.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and c.relname not in ('profiles','platform_admins','businesses','business_roles','subscription_plans','system_settings','audit_logs','message_pricing','webhook_events','suppression_lists','scheduled_jobs','notification_logs')
         and not exists (select 1 from information_schema.columns col where col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'business_id' and col.is_nullable = 'NO')`,
    );
    expect(tenantTablesWithoutBusinessId.rows).toEqual([]);
  });

  it('suspended workspaces are locked at both API and RLS layers', async () => {
    await ctx.deps.db.query(`update public.businesses set status = 'suspended', suspended_reason = 'test' where id = $1`, [bizB]);
    const res = await request(ctx.app).get(`/v1/businesses/${bizB}/dashboard`).set(bearer(b.token));
    expect(res.status).toBe(423);
    const rows = await withUser(ctx.deps.db, { sub: b.userId, email: 'b@other.in', aal: 'aal1' }, (tx) => tx.query('select id from public.businesses'));
    expect(rows.rows).toHaveLength(0);
    const me = await request(ctx.app).get('/v1/me').set(bearer(b.token));
    expect(me.body.data.memberships[0].businessStatus).toBe('suspended');
    await ctx.deps.db.query(`update public.businesses set status = 'active' where id = $1`, [bizB]);
  });
});
