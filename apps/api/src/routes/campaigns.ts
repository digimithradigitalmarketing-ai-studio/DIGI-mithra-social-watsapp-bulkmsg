import { Router } from 'express';
import { z } from 'zod';
import { CAMPAIGN_STATUSES, createCampaignSchema, scheduleCampaignSchema, type CampaignDto, type CampaignRecipientDto } from '@socialpilot/shared';
import type { Deps } from '../deps';
import type { Queryable } from '../db';
import { withService, withUser } from '../db/context';
import { HttpError, conflict, notFound } from '../lib/errors';
import { clientInfo, iso, isUuid, parse } from '../lib/http';
import { writeAudit } from '../lib/audit';
import { toCsv } from '../lib/csv';
import { enqueue } from '../jobs/queue';
import { campaignStats, pauseCampaign, previewCampaign, recomputeCampaign, resumeCampaign, type CampaignRow } from '../campaigns/service';
import { currentMembership, currentUser, requireAuth, requireMembership, requirePermission } from '../middleware/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */
async function loadDto(tx: Queryable, businessId: string, id: string): Promise<CampaignDto> {
  const r = await tx.query<any>(
    `select c.*, t.name as t_name, t.category as t_category, t.language as t_language, t.status as t_status, p.full_name as created_by_name
     from public.campaigns c left join public.message_templates t on t.id = c.template_id left join public.profiles p on p.id = c.created_by
     where c.id = $1 and c.business_id = $2`,
    [id, businessId],
  );
  const c = r.rows[0];
  if (!c) throw notFound('Campaign not found');
  return {
    id: c.id, name: c.name, status: c.status,
    template: c.template_id ? { id: c.template_id, name: c.t_name, category: c.t_category, language: c.t_language, status: c.t_status } : null,
    audience: c.audience, variableDefaults: c.variable_mapping ?? {},
    scheduledAt: iso(c.scheduled_at), startedAt: iso(c.started_at), completedAt: iso(c.completed_at), createdAt: iso(c.created_at)!, createdByName: c.created_by_name,
    stats: await campaignStats(tx, id),
  };
}

export function campaignsRouter(deps: Deps): Router {
  const r = Router();
  const base = '/businesses/:businessId/campaigns';
  const guard = [requireAuth(deps), requireMembership(deps)];
  const idOf = (req: any) => {
    const id = String(req.params.campaignId);
    if (!isUuid(id)) throw notFound('Campaign not found');
    return id;
  };
  /** Lock the campaign row (service tx) and assert it belongs to the workspace and is in an allowed state. */
  async function lockCampaign(tx: Queryable, businessId: string, id: string, allowed: string[]): Promise<CampaignRow> {
    const c = await tx.query<CampaignRow>('select * from public.campaigns where id = $1 and business_id = $2 for update', [id, businessId]);
    if (!c.rows[0]) throw notFound('Campaign not found');
    if (!allowed.includes(c.rows[0].status)) throw conflict(`This campaign is ${c.rows[0].status.replace('_', ' ')}`, 'invalid_status');
    return c.rows[0];
  }

  r.get(base, ...guard, requirePermission('campaigns.read'), async (req, res) => {
    const m = currentMembership(req);
    const q = parse(z.object({
      status: z.string().optional().transform((s) => (s ? s.split(',').filter((x) => (CAMPAIGN_STATUSES as readonly string[]).includes(x)) : [])),
      page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20),
    }), req.query);
    const data = await withUser(deps.db, currentUser(req), async (tx) => {
      const params: unknown[] = [m.businessId];
      let where = 'business_id = $1';
      if (q.status.length) { params.push(q.status); where += ` and status = any($2::text[])`; }
      const total = await tx.query<{ n: number }>(`select count(*)::int as n from public.campaigns where ${where}`, params);
      const ids = await tx.query<{ id: string }>(`select id from public.campaigns where ${where} order by coalesce(scheduled_at, created_at) desc limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`, params);
      const items: CampaignDto[] = [];
      for (const { id } of ids.rows) items.push(await loadDto(tx, m.businessId, id));
      return { items, total: total.rows[0]?.n ?? 0 };
    });
    res.json({ data: data.items, meta: { page: q.page, pageSize: q.pageSize, total: data.total } });
  });

  r.post(base, ...guard, requirePermission('campaigns.manage'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const input = parse(createCampaignSchema, req.body);
    const dto = await withUser(deps.db, user, async (tx) => {
      const t = await tx.query('select 1 from public.message_templates where id = $1 and business_id = $2', [input.templateId, m.businessId]);
      if (!t.rows.length) throw new HttpError(422, 'validation_failed', 'Template not found', { fields: { templateId: 'Choose a template' } });
      if (input.audience.tagIds.length) {
        const tags = await tx.query<{ n: number }>('select count(*)::int as n from public.tags where business_id = $1 and id = any($2::uuid[])', [m.businessId, input.audience.tagIds]);
        if (tags.rows[0]!.n !== input.audience.tagIds.length) throw new HttpError(422, 'validation_failed', 'Unknown tag', { fields: { 'audience.tagIds': 'Unknown tag' } });
      }
      const c = await tx.query<{ id: string }>(
        `insert into public.campaigns (business_id, name, template_id, audience, variable_mapping, created_by) values ($1, $2, $3, $4, $5, $6) returning id`,
        [m.businessId, input.name, input.templateId, JSON.stringify(input.audience), JSON.stringify(input.variableDefaults), user.sub]);
      return loadDto(tx, m.businessId, c.rows[0]!.id);
    });
    res.status(201).json({ data: dto });
  });

  r.get(`${base}/:campaignId`, ...guard, requirePermission('campaigns.read'), async (req, res) => {
    const m = currentMembership(req);
    const data = await withUser(deps.db, currentUser(req), (tx) => loadDto(tx, m.businessId, idOf(req)));
    res.json({ data });
  });

  r.patch(`${base}/:campaignId`, ...guard, requirePermission('campaigns.manage'), async (req, res) => {
    const m = currentMembership(req);
    const id = idOf(req);
    const input = parse(createCampaignSchema.partial(), req.body);
    const data = await withUser(deps.db, currentUser(req), async (tx) => {
      const c = await tx.query<{ status: string }>('select status from public.campaigns where id = $1 and business_id = $2', [id, m.businessId]);
      if (!c.rows[0]) throw notFound('Campaign not found');
      if (c.rows[0].status !== 'draft') throw conflict('Only draft campaigns can be edited', 'invalid_status');
      await tx.query(
        `update public.campaigns set name = coalesce($2, name), template_id = coalesce($3, template_id), audience = coalesce($4, audience), variable_mapping = coalesce($5, variable_mapping) where id = $1`,
        [id, input.name ?? null, input.templateId ?? null, input.audience ? JSON.stringify(input.audience) : null, input.variableDefaults ? JSON.stringify(input.variableDefaults) : null]);
      return loadDto(tx, m.businessId, id);
    });
    res.json({ data });
  });

  r.delete(`${base}/:campaignId`, ...guard, requirePermission('campaigns.manage'), async (req, res) => {
    const m = currentMembership(req);
    const d = await withUser(deps.db, currentUser(req), (tx) => tx.query(`delete from public.campaigns where id = $1 and business_id = $2 and status = 'draft' returning id`, [idOf(req), m.businessId]));
    if (!d.rows[0]) throw conflict('Only draft campaigns can be deleted', 'invalid_status');
    res.status(204).end();
  });

  r.post(`${base}/:campaignId/preview`, ...guard, requirePermission('campaigns.read'), async (req, res) => {
    const m = currentMembership(req);
    const c = await deps.db.query<CampaignRow>('select * from public.campaigns where id = $1 and business_id = $2', [idOf(req), m.businessId]);
    if (!c.rows[0]) throw notFound('Campaign not found');
    res.json({ data: await previewCampaign(deps.db, c.rows[0]) });
  });

  r.post(`${base}/:campaignId/schedule`, ...guard, requirePermission('campaigns.manage'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const id = idOf(req);
    const input = parse(scheduleCampaignSchema, req.body);
    const runAt = input.scheduledAt ? new Date(input.scheduledAt) : new Date();
    if (runAt.getTime() > Date.now() + 60 * 86400_000) throw new HttpError(422, 'validation_failed', 'Schedule within the next 60 days', { fields: { scheduledAt: 'Too far in the future' } });
    const effectiveRunAt = runAt.getTime() < Date.now() ? new Date() : runAt;
    await withService(deps.db, async (tx) => {
      const campaign = await lockCampaign(tx, m.businessId, id, ['draft']);
      const preview = await previewCampaign(tx, campaign);
      if (preview.blockers.length) throw new HttpError(422, 'campaign_blocked', preview.blockers[0]!, { blockers: preview.blockers });
      await tx.query(`update public.campaigns set status = 'scheduled', scheduled_at = $2 where id = $1`, [id, effectiveRunAt.toISOString()]);
      await tx.query(`delete from public.scheduled_jobs where dedupe_key = $1 and status in ('cancelled', 'done', 'failed')`, [`campaign.start:${id}`]);
      await enqueue(tx, 'campaign.start', { campaignId: id }, { businessId: m.businessId, runAt: effectiveRunAt, dedupeKey: `campaign.start:${id}`, maxAttempts: 3 });
      await writeAudit(tx, { businessId: m.businessId, actorUserId: user.sub, action: 'campaign.scheduled', targetType: 'campaign', targetId: id,
        metadata: { scheduledAt: effectiveRunAt.toISOString(), eligible: preview.eligible }, ...clientInfo(req) });
    });
    res.json({ data: await withUser(deps.db, user, (tx) => loadDto(tx, m.businessId, id)) });
  });

  /** Scheduled -> draft (edit before it starts). */
  r.post(`${base}/:campaignId/unschedule`, ...guard, requirePermission('campaigns.manage'), async (req, res) => {
    const m = currentMembership(req);
    const id = idOf(req);
    await withService(deps.db, async (tx) => {
      await lockCampaign(tx, m.businessId, id, ['scheduled']);
      await tx.query(`update public.scheduled_jobs set status = 'cancelled', finished_at = now() where dedupe_key = $1 and status = 'pending'`, [`campaign.start:${id}`]);
      await tx.query(`update public.campaigns set status = 'draft', scheduled_at = null where id = $1`, [id]);
      await writeAudit(tx, { businessId: m.businessId, actorUserId: currentUser(req).sub, action: 'campaign.unscheduled', targetType: 'campaign', targetId: id, ...clientInfo(req) });
    });
    res.json({ data: await withUser(deps.db, currentUser(req), (tx) => loadDto(tx, m.businessId, id)) });
  });

  r.post(`${base}/:campaignId/pause`, ...guard, requirePermission('campaigns.manage'), async (req, res) => {
    const m = currentMembership(req);
    const id = idOf(req);
    await withService(deps.db, async (tx) => {
      await lockCampaign(tx, m.businessId, id, ['processing']);
      await tx.query(`update public.campaigns set status = 'paused' where id = $1`, [id]);
      await pauseCampaign(tx, id);
      await writeAudit(tx, { businessId: m.businessId, actorUserId: currentUser(req).sub, action: 'campaign.paused', targetType: 'campaign', targetId: id, ...clientInfo(req) });
    });
    res.json({ data: await withUser(deps.db, currentUser(req), (tx) => loadDto(tx, m.businessId, id)) });
  });

  r.post(`${base}/:campaignId/resume`, ...guard, requirePermission('campaigns.manage'), async (req, res) => {
    const m = currentMembership(req);
    const id = idOf(req);
    await withService(deps.db, async (tx) => {
      await lockCampaign(tx, m.businessId, id, ['paused']);
      await tx.query(`update public.campaigns set status = 'processing' where id = $1`, [id]);
      await resumeCampaign(tx, deps.config, id, m.businessId);
      await recomputeCampaign(tx, id);
      await writeAudit(tx, { businessId: m.businessId, actorUserId: currentUser(req).sub, action: 'campaign.resumed', targetType: 'campaign', targetId: id, ...clientInfo(req) });
    });
    res.json({ data: await withUser(deps.db, currentUser(req), (tx) => loadDto(tx, m.businessId, id)) });
  });

  r.post(`${base}/:campaignId/cancel`, ...guard, requirePermission('campaigns.manage'), async (req, res) => {
    const m = currentMembership(req);
    const id = idOf(req);
    await withService(deps.db, async (tx) => {
      await lockCampaign(tx, m.businessId, id, ['scheduled', 'processing', 'paused']);
      await tx.query(`update public.scheduled_jobs set status = 'cancelled', finished_at = now() where dedupe_key = $1 and status = 'pending'`, [`campaign.start:${id}`]);
      await pauseCampaign(tx, id);
      await tx.query(`update public.campaign_recipients set status = 'skipped', skip_reason = 'cancelled' where campaign_id = $1 and status = 'pending'`, [id]);
      await tx.query(`update public.campaigns set status = 'cancelled', completed_at = now(), cancelled_reason = 'Cancelled by user' where id = $1`, [id]);
      await recomputeCampaign(tx, id);
      await writeAudit(tx, { businessId: m.businessId, actorUserId: currentUser(req).sub, action: 'campaign.cancelled', targetType: 'campaign', targetId: id, ...clientInfo(req) });
    });
    res.json({ data: await withUser(deps.db, currentUser(req), (tx) => loadDto(tx, m.businessId, id)) });
  });

  r.get(`${base}/:campaignId/recipients`, ...guard, requirePermission('campaigns.read'), async (req, res) => {
    const m = currentMembership(req);
    const id = idOf(req);
    const q = parse(z.object({
      status: z.enum(['skipped', 'pending', 'queued', 'sent', 'delivered', 'read', 'replied', 'failed']).optional(),
      page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50),
    }), req.query);
    const result = await withUser(deps.db, currentUser(req), async (tx) => {
      const params: unknown[] = [id, m.businessId];
      let where = 'r.campaign_id = $1 and r.business_id = $2';
      if (q.status) { params.push(q.status); where += ` and r.status = $3`; }
      const total = await tx.query<{ n: number }>(`select count(*)::int as n from public.campaign_recipients r where ${where}`, params);
      const rows = await tx.query<any>(
        `select r.*, c.name as contact_name from public.campaign_recipients r join public.contacts c on c.id = r.contact_id
         where ${where} order by r.created_at limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`, params);
      return { total: total.rows[0]?.n ?? 0, rows: rows.rows };
    });
    const data: CampaignRecipientDto[] = result.rows.map((x) => ({
      id: x.id, contactId: x.contact_id, contactName: x.contact_name, phone: x.phone_e164, status: x.status, skipReason: x.skip_reason,
      errorCode: x.error_code, errorMessage: x.error_message, attempts: x.attempts, sentAt: iso(x.sent_at), deliveredAt: iso(x.delivered_at),
      readAt: iso(x.read_at), repliedAt: iso(x.replied_at),
    }));
    res.json({ data, meta: { page: q.page, pageSize: q.pageSize, total: result.total } });
  });

  r.get(`${base}/:campaignId/report.csv`, ...guard, requirePermission('campaigns.read'), async (req, res) => {
    const m = currentMembership(req);
    const id = idOf(req);
    const rows = await withUser(deps.db, currentUser(req), (tx) => tx.query<any>(
      `select r.*, c.name as contact_name from public.campaign_recipients r join public.contacts c on c.id = r.contact_id
       where r.campaign_id = $1 and r.business_id = $2 order by r.created_at`, [id, m.businessId]));
    const out: unknown[][] = [['name', 'phone', 'status', 'skip_reason', 'error_code', 'error_message', 'attempts', 'sent_at', 'delivered_at', 'read_at', 'replied_at', 'failed_at']];
    for (const x of rows.rows) out.push([x.contact_name, x.phone_e164, x.status, x.skip_reason, x.error_code, x.error_message, x.attempts, iso(x.sent_at), iso(x.delivered_at), iso(x.read_at), iso(x.replied_at), iso(x.failed_at)]);
    res.type('text/csv').attachment(`campaign-${id.slice(0, 8)}-report.csv`).send(toCsv(out));
  });

  return r;
}
