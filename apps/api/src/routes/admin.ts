import { Router } from 'express';
import { z } from 'zod';
import { paginationSchema, suspendBusinessSchema, updatePlanSchema, type AdminBusinessDto, type AdminOverviewDto, type AuditLogDto } from '@socialpilot/shared';
import type { Deps } from '../deps';
import { withService } from '../db/context';
import { HttpError, notFound } from '../lib/errors';
import { clientInfo, iso, isUuid, parse } from '../lib/http';
import { writeAudit } from '../lib/audit';
import { mapPlan } from '../lib/mappers';
import { currentUser, requireAuth, requirePlatformAdmin } from '../middleware/auth';

/** Settings a Super Admin may change, each with its own validator. */
const EDITABLE_SETTINGS: Record<string, z.ZodType> = {
  signups_enabled: z.boolean(),
  max_workspaces_per_user: z.number().int().min(1).max(50),
  default_plan_code: z.string().regex(/^[a-z0-9_-]+$/),
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export function adminRouter(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth(deps), requirePlatformAdmin(deps));

  r.get('/overview', async (_req, res) => {
    const q = <T>(sql: string, p: unknown[] = []) => deps.db.query<T>(sql, p).then((x) => x.rows);
    const [b] = await q<AdminOverviewDto['businesses']>(
      `select count(*)::int as total,
              count(*) filter (where status = 'active')::int as active,
              count(*) filter (where status = 'suspended')::int as suspended,
              count(*) filter (where created_at >= now() - interval '30 days')::int as "newLast30d"
       from public.businesses`,
    );
    const [s] = await q<AdminOverviewDto['subscriptions']>(
      `select count(*) filter (where status = 'trialing')::int as trialing,
              count(*) filter (where status = 'active')::int as active,
              count(*) filter (where status = 'past_due')::int as "pastDue",
              count(*) filter (where status = 'cancelled')::int as cancelled
       from public.subscriptions`,
    );
    const byPlan = await q<any>(
      `select p.code, p.name,
              count(s.id) filter (where s.status = 'active')::int as active_count,
              count(s.id) filter (where s.status = 'trialing')::int as trialing_count,
              coalesce(sum(case when s.status = 'active' then
                 case when s.billing_cycle = 'annual' then p.annual_price_paise / 12 else p.monthly_price_paise end end), 0)::bigint as mrr
       from public.subscription_plans p left join public.subscriptions s on s.plan_id = p.id
       group by p.id order by p.sort_order`,
    );
    const [u] = await q<AdminOverviewDto['users']>(
      `select count(*)::int as total, count(*) filter (where created_at >= now() - interval '30 days')::int as "newLast30d" from public.profiles`,
    );
    const [misc] = await q<any>(
      `select (select count(*)::int from public.connected_channels where channel = 'whatsapp' and status = 'connected') as wa,
              (select count(*)::int from public.campaigns) as campaigns_total,
              (select count(*)::int from public.campaigns where status = 'processing') as campaigns_processing,
              (select count(*)::int from public.webhook_events where received_at >= now() - interval '24 hours') as wh_received,
              (select count(*)::int from public.webhook_events where status = 'failed' and received_at >= now() - interval '24 hours') as wh_failed,
              (select count(*)::int from public.payments where status = 'failed' and created_at >= now() - interval '30 days') as failed_payments,
              (select count(*)::int from public.support_tickets where status in ('open', 'pending')) as open_tickets`,
    );
    const signups = await q<{ date: string; count: number }>(
      `select to_char(d.day, 'YYYY-MM-DD') as date, count(b.id)::int as count
       from generate_series(date_trunc('day', now() - interval '29 days'), date_trunc('day', now()), interval '1 day') d(day)
       left join public.businesses b on date_trunc('day', b.created_at) = d.day
       group by d.day order by d.day`,
    );
    const revenueByPlan = byPlan.map((p) => ({
      planCode: p.code, planName: p.name, activeCount: p.active_count, trialingCount: p.trialing_count, mrrPaise: Number(p.mrr),
    }));
    const data: AdminOverviewDto = {
      businesses: b!,
      subscriptions: s!,
      mrrPaise: revenueByPlan.reduce((a, p) => a + p.mrrPaise, 0),
      revenueByPlan,
      users: u!,
      whatsappConnections: misc.wa,
      campaigns: { total: misc.campaigns_total, processing: misc.campaigns_processing },
      webhooks: { received24h: misc.wh_received, failed24h: misc.wh_failed },
      failedPayments30d: misc.failed_payments,
      openSupportTickets: misc.open_tickets,
      signupsByDay: signups,
    };
    res.json({ data });
  });

  r.get('/businesses', async (req, res) => {
    const { page, pageSize, q } = parse(paginationSchema, req.query);
    const status = parse(z.enum(['active', 'suspended', 'closed']).optional(), req.query.status || undefined);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where.push(`(lower(b.name) like $${params.length} or lower(b.slug) like $${params.length} or lower(coalesce(b.city, '')) like $${params.length})`);
    }
    if (status) {
      params.push(status);
      where.push(`b.status = $${params.length}`);
    }
    const whereSql = where.length ? `where ${where.join(' and ')}` : '';
    const total = await deps.db.query<{ n: number }>(`select count(*)::int as n from public.businesses b ${whereSql}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    const rows = await deps.db.query<any>(
      `select b.*, p.name as plan_name, s.status as subscription_status, s.trial_ends_at,
              (select pr.email from public.business_members m join public.profiles pr on pr.id = m.user_id
                where m.business_id = b.id and m.role = 'owner' order by m.created_at limit 1) as owner_email,
              (select count(*)::int from public.business_members m where m.business_id = b.id and m.status = 'active') as member_count,
              (select count(*)::int from public.contacts c where c.business_id = b.id) as contact_count
       from public.businesses b
       left join public.subscriptions s on s.business_id = b.id
       left join public.subscription_plans p on p.id = s.plan_id
       ${whereSql}
       order by b.created_at desc limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    const data: AdminBusinessDto[] = rows.rows.map((x) => ({
      id: x.id, name: x.name, slug: x.slug, status: x.status, suspendedReason: x.suspended_reason, city: x.city, industry: x.industry,
      ownerEmail: x.owner_email, memberCount: x.member_count, contactCount: x.contact_count, planName: x.plan_name,
      subscriptionStatus: x.subscription_status, trialEndsAt: iso(x.trial_ends_at), createdAt: iso(x.created_at)!,
    }));
    res.json({ data, meta: { page, pageSize, total: total.rows[0]?.n ?? 0 } });
  });

  const setStatus = (status: 'active' | 'suspended') =>
    async (req: any, res: any) => {
      const id = String(req.params.businessId);
      if (!isUuid(id)) throw notFound('Workspace not found');
      const reason = status === 'suspended' ? parse(suspendBusinessSchema, req.body).reason : null;
      const admin = currentUser(req);
      const row = await withService(deps.db, async (tx) => {
        const u = await tx.query<any>(
          `update public.businesses set status = $2, suspended_reason = $3, suspended_at = case when $2 = 'suspended' then now() else null end
           where id = $1 and status <> 'closed' returning id, name, status`,
          [id, status, reason],
        );
        if (!u.rows[0]) throw notFound('Workspace not found');
        await writeAudit(tx, {
          businessId: id, actorUserId: admin.sub, actorType: 'platform_admin',
          action: status === 'suspended' ? 'admin.business_suspended' : 'admin.business_reactivated',
          targetType: 'business', targetId: id, metadata: reason ? { reason } : {}, ...clientInfo(req),
        });
        return u.rows[0];
      });
      res.json({ data: row });
    };
  r.post('/businesses/:businessId/suspend', setStatus('suspended'));
  r.post('/businesses/:businessId/reactivate', setStatus('active'));

  r.get('/plans', async (_req, res) => {
    const rows = await deps.db.query('select * from public.subscription_plans order by sort_order');
    res.json({ data: rows.rows.map(mapPlan) });
  });

  r.patch('/plans/:planId', async (req, res) => {
    const id = String(req.params.planId);
    if (!isUuid(id)) throw notFound('Plan not found');
    const input = parse(updatePlanSchema, req.body);
    const admin = currentUser(req);
    const map: Record<string, string> = {
      name: 'name', description: 'description', monthlyPricePaise: 'monthly_price_paise', annualPricePaise: 'annual_price_paise',
      trialDays: 'trial_days', isActive: 'is_active', limits: 'limits',
      razorpayPlanIdMonthly: 'razorpay_plan_id_monthly', razorpayPlanIdAnnual: 'razorpay_plan_id_annual',
    };
    const sets: string[] = [];
    const vals: unknown[] = [id];
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined || !map[k]) continue;
      vals.push(k === 'limits' ? JSON.stringify(v) : v);
      sets.push(`${map[k]} = $${vals.length}`);
    }
    if (!sets.length) throw new HttpError(400, 'nothing_to_update', 'Nothing to update');
    const row = await withService(deps.db, async (tx) => {
      const u = await tx.query(`update public.subscription_plans set ${sets.join(', ')} where id = $1 returning *`, vals);
      if (!u.rows[0]) throw notFound('Plan not found');
      await writeAudit(tx, { actorUserId: admin.sub, actorType: 'platform_admin', action: 'admin.plan_updated', targetType: 'subscription_plan', targetId: id, metadata: { changes: input }, ...clientInfo(req) });
      return u.rows[0];
    });
    res.json({ data: mapPlan(row) });
  });

  r.get('/settings', async (_req, res) => {
    const rows = await deps.db.query<any>('select key, value, description, updated_at from public.system_settings order by key');
    res.json({ data: rows.rows.map((s) => ({ key: s.key, value: s.value, description: s.description, editable: s.key in EDITABLE_SETTINGS, updatedAt: iso(s.updated_at) })) });
  });

  r.patch('/settings/:key', async (req, res) => {
    const key = String(req.params.key);
    const validator = EDITABLE_SETTINGS[key];
    if (!validator) throw notFound('Setting not found or not editable');
    const value = parse(z.object({ value: validator }), req.body).value;
    const admin = currentUser(req);
    await withService(deps.db, async (tx) => {
      await tx.query('update public.system_settings set value = $2, updated_by = $3 where key = $1', [key, JSON.stringify(value), admin.sub]);
      await writeAudit(tx, { actorUserId: admin.sub, actorType: 'platform_admin', action: 'admin.setting_updated', targetType: 'system_setting', targetId: key, metadata: { value }, ...clientInfo(req) });
    });
    res.json({ data: { key, value } });
  });

  // ---- background jobs / dead-letter queue -------------------------------------------
  r.get('/queue', async (_req, res) => {
    const counts = await deps.db.query<any>(
      `select kind, status, count(*)::int as n from public.scheduled_jobs where created_at > now() - interval '7 days' group by kind, status order by kind, status`);
    const failed = await deps.db.query<any>(
      `select j.id, j.kind, j.attempts, j.last_error, j.finished_at, j.created_at, b.name as business_name from public.scheduled_jobs j
       left join public.businesses b on b.id = j.business_id where j.status = 'failed' order by j.finished_at desc nulls last limit 50`);
    const webhooks = await deps.db.query<any>(
      `select status, count(*)::int as n from public.webhook_events where received_at > now() - interval '24 hours' group by status`);
    const oldest = await deps.db.query<{ lag: number | null }>(
      `select extract(epoch from now() - min(run_at))::int as lag from public.scheduled_jobs where status = 'pending' and run_at <= now()`);
    res.json({ data: {
      counts: counts.rows,
      deadLetter: failed.rows.map((j) => ({ id: j.id, kind: j.kind, attempts: j.attempts, lastError: j.last_error, businessName: j.business_name, failedAt: iso(j.finished_at), createdAt: iso(j.created_at) })),
      webhooks24h: Object.fromEntries(webhooks.rows.map((w) => [w.status, w.n])),
      oldestDueSeconds: oldest.rows[0]?.lag ?? 0,
    } });
  });

  r.post('/queue/:jobId/retry', async (req, res) => {
    const id = String(req.params.jobId);
    if (!isUuid(id)) throw notFound('Job not found');
    const admin = currentUser(req);
    const job = await withService(deps.db, async (tx) => {
      const r2 = await tx.query<any>(`update public.scheduled_jobs set status = 'pending', attempts = 0, run_at = now(), finished_at = null, last_error = null where id = $1 and status = 'failed' returning id, kind, payload`, [id]);
      if (!r2.rows[0]) throw notFound('Failed job not found');
      const j = r2.rows[0];
      // A retried send needs its recipient pending again (only if the provider never accepted it).
      if (j.kind === 'message.send') {
        await tx.query(
          `update public.campaign_recipients r set status = 'pending', error_code = null, error_message = null, failed_at = null
           where r.id = $1 and r.status = 'failed'
             and not exists (select 1 from public.messages m where m.id = r.message_id and m.provider_message_id is not null)`,
          [j.payload.recipientId]);
        await tx.query(`update public.campaigns set status = 'processing' where id = (select campaign_id from public.campaign_recipients where id = $1) and status in ('completed', 'partially_completed', 'failed')`, [j.payload.recipientId]);
      }
      await writeAudit(tx, { actorUserId: admin.sub, actorType: 'platform_admin', action: 'admin.job_retried', targetType: 'scheduled_job', targetId: id, metadata: { kind: j.kind } });
      return j;
    });
    res.json({ data: { id: job.id, status: 'pending' } });
  });

  r.get('/audit-logs', async (req, res) => {
    const { page, pageSize, q } = parse(paginationSchema, req.query);
    const params: unknown[] = [];
    let where = '';
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where = `where lower(a.action) like $1 or lower(coalesce(p.email, '')) like $1 or lower(coalesce(b.name, '')) like $1`;
    }
    const total = await deps.db.query<{ n: number }>(
      `select count(*)::int as n from public.audit_logs a left join public.profiles p on p.id = a.actor_user_id left join public.businesses b on b.id = a.business_id ${where}`,
      params,
    );
    params.push(pageSize, (page - 1) * pageSize);
    const rows = await deps.db.query<any>(
      `select a.*, p.email as actor_email, b.name as business_name from public.audit_logs a
       left join public.profiles p on p.id = a.actor_user_id left join public.businesses b on b.id = a.business_id
       ${where} order by a.created_at desc limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    const data: AuditLogDto[] = rows.rows.map((a) => ({
      id: a.id, action: a.action, actorEmail: a.actor_email, actorType: a.actor_type, targetType: a.target_type, targetId: a.target_id,
      metadata: a.metadata ?? {}, businessId: a.business_id, businessName: a.business_name, createdAt: iso(a.created_at)!,
    }));
    res.json({ data, meta: { page, pageSize, total: total.rows[0]?.n ?? 0 } });
  });

  return r;
}
