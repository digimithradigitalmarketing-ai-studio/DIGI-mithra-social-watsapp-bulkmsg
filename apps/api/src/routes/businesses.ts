import { Router } from 'express';
import { createBusinessSchema, paginationSchema, updateBusinessSchema, updateProfileSchema, type AuditLogDto, type MeDto } from '@socialpilot/shared';
import type { Deps } from '../deps';
import { withService, withUser } from '../db/context';
import { HttpError, notFound } from '../lib/errors';
import { clientInfo, iso, parse } from '../lib/http';
import { writeAudit } from '../lib/audit';
import { loadMemberships, loadSubscription, mapBusiness, mapPlan } from '../lib/mappers';
import { randomToken } from '../lib/crypto';
import { currentMembership, currentUser, requireAuth, requireMembership, requirePermission } from '../middleware/auth';

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'workspace'}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'x1'}`;
}

const DEFAULT_PIPELINE_STAGES = ['New enquiry', 'Contacted', 'Visit / trial booked', 'Negotiation', 'Won', 'Lost'];

export function businessesRouter(deps: Deps): Router {
  const r = Router();
  const auth = requireAuth(deps);
  const member = requireMembership(deps);

  // ---- current user ----------------------------------------------------------
  r.get('/me', auth, async (req, res) => {
    const user = currentUser(req);
    const profile = await withUser(deps.db, user, async (tx) => {
      const p = await tx.query<{ id: string; email: string; full_name: string; phone: string | null; preferred_language: 'en' | 'kn' }>(
        'select id, email, full_name, phone, preferred_language from public.profiles where id = $1',
        [user.sub],
      );
      const admin = await tx.query('select 1 from public.platform_admins where user_id = $1', [user.sub]);
      return { p: p.rows[0], isAdmin: admin.rows.length > 0 };
    });
    if (!profile.p) throw notFound('Profile not found');
    const dto: MeDto = {
      id: profile.p.id,
      email: profile.p.email,
      fullName: profile.p.full_name,
      phone: profile.p.phone,
      preferredLanguage: profile.p.preferred_language,
      isPlatformAdmin: profile.isAdmin,
      aal: user.aal,
      memberships: await loadMemberships(deps.db, user.sub),
    };
    res.json({ data: dto });
  });

  r.patch('/me', auth, async (req, res) => {
    const user = currentUser(req);
    const input = parse(updateProfileSchema, req.body);
    await withUser(deps.db, user, (tx) =>
      tx.query(
        `update public.profiles set
           full_name = coalesce($2, full_name),
           phone = case when $3::boolean then $4 else phone end,
           preferred_language = coalesce($5, preferred_language)
         where id = $1`,
        [user.sub, input.fullName ?? null, input.phone !== undefined, input.phone ?? null, input.preferredLanguage ?? null],
      ),
    );
    res.json({ data: { updated: true } });
  });

  // ---- public plan catalogue -------------------------------------------------
  r.get('/plans', async (_req, res) => {
    const rows = await deps.db.query('select * from public.subscription_plans where is_active order by sort_order');
    res.json({ data: rows.rows.map(mapPlan) });
  });

  // ---- workspaces --------------------------------------------------------------
  r.get('/businesses', auth, async (req, res) => {
    res.json({ data: await loadMemberships(deps.db, currentUser(req).sub) });
  });

  /**
   * Create a workspace.  Service operation (RLS cannot express "the creator
   * becomes owner"), guarded by: authenticated + verified user, per-user
   * workspace cap, and an audit entry.
   */
  r.post('/businesses', auth, async (req, res) => {
    const user = currentUser(req);
    const input = parse(createBusinessSchema, req.body);

    const business = await withService(deps.db, async (tx) => {
      const capRow = await tx.query<{ value: number }>(`select value from public.system_settings where key = 'max_workspaces_per_user'`);
      const cap = Number(capRow.rows[0]?.value ?? 3);
      const owned = await tx.query<{ n: number }>(
        `select count(*)::int as n from public.business_members where user_id = $1 and role = 'owner'`,
        [user.sub],
      );
      if ((owned.rows[0]?.n ?? 0) >= cap)
        throw new HttpError(403, 'workspace_limit_reached', `You can own at most ${cap} workspaces. Contact DigiMithra support for more.`);

      const b = await tx.query<{ id: string } & Record<string, unknown>>(
        `insert into public.businesses (name, slug, industry, phone, city, timezone, default_language, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
        [input.name, slugify(input.name), input.industry, input.phone ?? null, input.city ?? null, input.timezone, input.defaultLanguage, user.sub],
      );
      const businessId = b.rows[0]!.id;
      await tx.query(`insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner')`, [businessId, user.sub]);

      // Trial subscription on the configured default plan + entitlements snapshot
      const planCode = await tx.query<{ value: string }>(`select value from public.system_settings where key = 'default_plan_code'`);
      const plan = await tx.query<{ id: string; trial_days: number; limits: Record<string, number> }>(
        `select id, trial_days, limits from public.subscription_plans where code = $1 and is_active`,
        [planCode.rows[0]?.value ?? 'starter'],
      );
      if (plan.rows[0]) {
        const p = plan.rows[0];
        await tx.query(
          `insert into public.subscriptions (business_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
           values ($1, $2, 'trialing', now() + make_interval(days => $3), now(), now() + make_interval(days => $3))`,
          [businessId, p.id, p.trial_days],
        );
        for (const [key, value] of Object.entries(p.limits ?? {})) {
          await tx.query(
            `insert into public.subscription_entitlements (business_id, key, limit_value, source) values ($1, $2, $3, 'plan')`,
            [businessId, key, value],
          );
        }
      }

      // Default CRM pipeline and AI settings (AI disabled until configured)
      const pipeline = await tx.query<{ id: string }>(
        `insert into public.lead_pipelines (business_id, name, is_default) values ($1, 'Sales pipeline', true) returning id`,
        [businessId],
      );
      for (const [i, name] of DEFAULT_PIPELINE_STAGES.entries()) {
        await tx.query(
          `insert into public.lead_stages (business_id, pipeline_id, name, position, is_won, is_lost) values ($1, $2, $3, $4, $5, $6)`,
          [businessId, pipeline.rows[0]!.id, name, i, name === 'Won', name === 'Lost'],
        );
      }
      await tx.query(`insert into public.ai_settings (business_id, languages) values ($1, $2)`, [businessId, [input.defaultLanguage]]);

      await writeAudit(tx, { businessId, actorUserId: user.sub, action: 'business.created', targetType: 'business', targetId: businessId, metadata: { name: input.name }, ...clientInfo(req) });
      return b.rows[0]!;
    });

    const subscription = await loadSubscription(deps.db, business.id);
    res.status(201).json({ data: mapBusiness(business, 'owner', subscription) });
  });

  r.get('/businesses/:businessId', auth, member, async (req, res) => {
    const m = currentMembership(req);
    const data = await withUser(deps.db, currentUser(req), async (tx) => {
      const b = await tx.query('select * from public.businesses where id = $1', [m.businessId]);
      if (!b.rows[0]) throw notFound('Workspace not found');
      return mapBusiness(b.rows[0], m.role, await loadSubscription(tx, m.businessId));
    });
    res.json({ data });
  });

  r.patch('/businesses/:businessId', auth, member, requirePermission('business.update'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const input = parse(updateBusinessSchema, req.body);
    const columns: Record<string, string> = {
      name: 'name', industry: 'industry', phone: 'phone', email: 'email', website: 'website', address: 'address',
      city: 'city', state: 'state', timezone: 'timezone', defaultLanguage: 'default_language',
    };
    const sets: string[] = [];
    const values: unknown[] = [m.businessId];
    for (const [k, v] of Object.entries(input)) {
      const col = columns[k];
      if (!col || v === undefined) continue;
      values.push(v === '' ? null : v);
      sets.push(`${col} = $${values.length}`);
    }
    if (!sets.length) throw new HttpError(400, 'nothing_to_update', 'Nothing to update');
    const data = await withUser(deps.db, user, async (tx) => {
      const r2 = await tx.query(`update public.businesses set ${sets.join(', ')} where id = $1 returning *`, values);
      if (!r2.rows[0]) throw notFound('Workspace not found');
      return mapBusiness(r2.rows[0], m.role, await loadSubscription(tx, m.businessId));
    });
    await writeAudit(deps.db, { businessId: m.businessId, actorUserId: user.sub, action: 'business.updated', targetType: 'business', targetId: m.businessId, metadata: { fields: Object.keys(input) }, ...clientInfo(req) });
    res.json({ data });
  });

  r.get('/businesses/:businessId/audit-logs', auth, member, requirePermission('audit.read'), async (req, res) => {
    const m = currentMembership(req);
    const { page, pageSize } = parse(paginationSchema, req.query);
    const result = await withUser(deps.db, currentUser(req), async (tx) => {
      const total = await tx.query<{ n: number }>('select count(*)::int as n from public.audit_logs where business_id = $1', [m.businessId]);
      const rows = await tx.query<Record<string, unknown>>(
        `select a.*, p.email as actor_email from public.audit_logs a
         left join public.profiles p on p.id = a.actor_user_id
         where a.business_id = $1 order by a.created_at desc limit $2 offset $3`,
        [m.businessId, pageSize, (page - 1) * pageSize],
      );
      return { total: total.rows[0]?.n ?? 0, rows: rows.rows };
    });
    const data: AuditLogDto[] = result.rows.map((a) => ({
      id: String(a.id),
      action: String(a.action),
      actorEmail: (a.actor_email as string | null) ?? null,
      actorType: String(a.actor_type),
      targetType: (a.target_type as string | null) ?? null,
      targetId: (a.target_id as string | null) ?? null,
      metadata: (a.metadata as Record<string, unknown>) ?? {},
      businessId: (a.business_id as string | null) ?? null,
      businessName: m.businessName,
      createdAt: iso(a.created_at)!,
    }));
    res.json({ data, meta: { page, pageSize, total: result.total } });
  });

  return r;
}
