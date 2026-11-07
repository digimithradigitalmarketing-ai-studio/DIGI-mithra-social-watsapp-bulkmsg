import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import {
  TRIGGER_TYPES, WORKFLOW_TEMPLATES, createWorkflowSchema, saveDraftSchema,
  type ExecutionDto, type NotificationDto, type TriggerType, type WorkflowDefinition, type WorkflowDto,
} from '@socialpilot/shared';
import type { Deps } from '../deps';
import type { Queryable } from '../db';
import { withService, withUser } from '../db/context';
import { HttpError, conflict, notFound } from '../lib/errors';
import { clientInfo, iso, isUuid, parse } from '../lib/http';
import { writeAudit } from '../lib/audit';
import { enqueue } from '../jobs/queue';
import { startExecution, validateDefinition } from '../automation/engine';
import { currentMembership, currentUser, requireAuth, requireMembership, requirePermission } from '../middleware/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */
const EMPTY: WorkflowDefinition = { trigger: { type: 'contact_created', config: {} }, steps: [], reentry: 'daily' };

async function loadWorkflow(tx: Queryable, businessId: string, id: string): Promise<WorkflowDto> {
  const r = await tx.query<any>(
    `select w.*, v.id as v_id, v.version as v_version, v.definition as v_definition, v.published_at as v_published_at,
       (select count(*) filter (where status = 'running')::int from public.automation_executions e where e.workflow_id = w.id) as running,
       (select count(*) filter (where status = 'waiting')::int from public.automation_executions e where e.workflow_id = w.id) as waiting,
       (select count(*) filter (where status = 'completed')::int from public.automation_executions e where e.workflow_id = w.id) as completed,
       (select count(*) filter (where status = 'failed')::int from public.automation_executions e where e.workflow_id = w.id) as failed
     from public.automation_workflows w left join public.automation_versions v on v.id = w.current_version_id
     where w.id = $1 and w.business_id = $2`, [id, businessId]);
  const w = r.rows[0];
  if (!w) throw notFound('Workflow not found');
  return {
    id: w.id, name: w.name, description: w.description, status: w.status, triggerType: w.trigger_type,
    draft: w.draft_definition ?? null,
    published: w.v_id ? { versionId: w.v_id, version: w.v_version, definition: w.v_definition, publishedAt: iso(w.v_published_at) } : null,
    hasUnpublishedChanges: !!w.draft_definition && (!w.v_id || JSON.stringify(w.draft_definition) !== JSON.stringify(w.v_definition)),
    stats: { running: w.running, waiting: w.waiting, completed: w.completed, failed: w.failed },
    createdAt: iso(w.created_at)!, updatedAt: iso(w.updated_at)!,
  };
}

const mapExecution = (e: any): ExecutionDto => ({
  id: e.id, workflowId: e.workflow_id, workflowName: e.workflow_name, version: e.version,
  contact: e.contact_id ? { id: e.contact_id, name: e.contact_name ?? '', phone: e.phone_e164 ?? '' } : null,
  status: e.status, error: e.error, trigger: e.trigger_event ?? {}, startedAt: iso(e.started_at)!, finishedAt: iso(e.finished_at), nextRunAt: iso(e.next_run_at),
});

export function automationRouter(deps: Deps): Router {
  const r = Router();
  const base = '/businesses/:businessId';
  const guard = [requireAuth(deps), requireMembership(deps)];
  const manage = requirePermission('automation.manage');
  const wfId = (req: any) => {
    const id = String(req.params.workflowId);
    if (!isUuid(id)) throw notFound('Workflow not found');
    return id;
  };

  r.get(`${base}/automation-templates`, ...guard, manage, (_req, res) => {
    res.json({ data: WORKFLOW_TEMPLATES.map((t) => ({ key: t.key, name: t.name, description: t.description, triggerType: t.definition.trigger.type, stepCount: t.definition.steps.length })) });
  });

  r.get(`${base}/automations`, ...guard, manage, async (req, res) => {
    const m = currentMembership(req);
    const data = await withUser(deps.db, currentUser(req), async (tx) => {
      const ids = await tx.query<{ id: string }>(`select id from public.automation_workflows where business_id = $1 and status <> 'archived' order by updated_at desc`, [m.businessId]);
      const out: WorkflowDto[] = [];
      for (const { id } of ids.rows) out.push(await loadWorkflow(tx, m.businessId, id));
      return out;
    });
    res.json({ data });
  });

  r.post(`${base}/automations`, ...guard, manage, async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const input = parse(createWorkflowSchema, req.body);
    const tpl = input.templateKey ? WORKFLOW_TEMPLATES.find((t) => t.key === input.templateKey) : undefined;
    if (input.templateKey && !tpl) throw new HttpError(422, 'validation_failed', 'Unknown template', { fields: { templateKey: 'Unknown template' } });
    const definition = (tpl?.definition ?? EMPTY) as WorkflowDefinition;
    const lim = await deps.db.query<{ lim: number | null; used: number }>(
      `select (select limit_value from public.subscription_entitlements where business_id = $1 and key = 'workflows') as lim,
              (select count(*)::int from public.automation_workflows where business_id = $1 and status <> 'archived') as used`, [m.businessId]);
    const l = lim.rows[0];
    if (l?.lim != null && l.used >= Number(l.lim))
      throw new HttpError(402, 'workflow_limit_reached', Number(l.lim) === 0 ? 'Automation workflows are included from the Growth plan.' : `Your plan allows ${l.lim} workflows.`);
    const dto = await withUser(deps.db, user, async (tx) => {
      const w = await tx.query<{ id: string }>(
        `insert into public.automation_workflows (business_id, name, description, status, trigger_type, draft_definition, draft_updated_at, created_by)
         values ($1, $2, $3, 'draft', $4, $5, now(), $6) returning id`,
        [m.businessId, input.name, tpl && !input.description ? tpl.description : input.description, definition.trigger.type, JSON.stringify(definition), user.sub]);
      return loadWorkflow(tx, m.businessId, w.rows[0]!.id);
    });
    res.status(201).json({ data: dto });
  });

  r.get(`${base}/automations/:workflowId`, ...guard, manage, async (req, res) => {
    const m = currentMembership(req);
    res.json({ data: await withUser(deps.db, currentUser(req), (tx) => loadWorkflow(tx, m.businessId, wfId(req))) });
  });

  /** Save the editable draft. Incomplete drafts are allowed; publishing validates. */
  r.put(`${base}/automations/:workflowId/draft`, ...guard, manage, async (req, res) => {
    const m = currentMembership(req);
    const input = parse(saveDraftSchema, req.body);
    const raw = input.definition as { trigger?: { type?: string } } | null;
    if (!raw || typeof raw !== 'object' || !raw.trigger || !(TRIGGER_TYPES as readonly string[]).includes(String(raw.trigger.type)))
      throw new HttpError(422, 'validation_failed', 'The workflow needs a valid trigger');
    if (JSON.stringify(raw).length > 200_000) throw new HttpError(413, 'too_large', 'Workflow is too large');
    const data = await withUser(deps.db, currentUser(req), async (tx) => {
      const u = await tx.query(
        `update public.automation_workflows set draft_definition = $3, draft_updated_at = now(), trigger_type = $4,
           name = coalesce($5, name), description = coalesce($6, description)
         where id = $1 and business_id = $2 and status <> 'archived' returning id`,
        [wfId(req), m.businessId, JSON.stringify(raw), raw.trigger!.type as TriggerType, input.name ?? null, input.description ?? null]);
      if (!u.rows[0]) throw notFound('Workflow not found');
      return loadWorkflow(tx, m.businessId, wfId(req));
    });
    res.json({ data });
  });

  r.post(`${base}/automations/:workflowId/validate`, ...guard, manage, async (req, res) => {
    const m = currentMembership(req);
    const w = await deps.db.query<{ draft_definition: unknown }>('select draft_definition from public.automation_workflows where id = $1 and business_id = $2', [wfId(req), m.businessId]);
    if (!w.rows[0]) throw notFound('Workflow not found');
    const { errors } = await validateDefinition(deps.db, m.businessId, w.rows[0].draft_definition);
    res.json({ data: { valid: errors.length === 0, errors } });
  });

  r.post(`${base}/automations/:workflowId/publish`, ...guard, manage, async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const id = wfId(req);
    const w = await deps.db.query<{ draft_definition: unknown; status: string }>('select draft_definition, status from public.automation_workflows where id = $1 and business_id = $2', [id, m.businessId]);
    if (!w.rows[0] || w.rows[0].status === 'archived') throw notFound('Workflow not found');
    const { definition, errors } = await validateDefinition(deps.db, m.businessId, w.rows[0].draft_definition);
    if (errors.length || !definition) throw new HttpError(422, 'workflow_invalid', errors[0]?.message ?? 'Workflow is invalid', { errors });
    const data = await withUser(deps.db, user, async (tx) => {
      const v = await tx.query<{ n: number }>('select coalesce(max(version), 0)::int as n from public.automation_versions where workflow_id = $1', [id]);
      const ver = await tx.query<{ id: string }>(
        `insert into public.automation_versions (business_id, workflow_id, version, definition, published_at, published_by) values ($1, $2, $3, $4, now(), $5) returning id`,
        [m.businessId, id, (v.rows[0]?.n ?? 0) + 1, JSON.stringify(definition), user.sub]);
      await tx.query(`update public.automation_workflows set current_version_id = $2, status = 'published', published_at = now(), trigger_type = $3, draft_definition = $4 where id = $1`,
        [id, ver.rows[0]!.id, definition.trigger.type, JSON.stringify(definition)]);
      return loadWorkflow(tx, m.businessId, id);
    });
    await writeAudit(deps.db, { businessId: m.businessId, actorUserId: user.sub, action: 'automation.published', targetType: 'automation_workflow', targetId: id, metadata: { version: data.published?.version }, ...clientInfo(req) });
    // Date-based workflows: evaluate right away instead of waiting for the next scheduler tick.
    if (['membership_expiring', 'payment_due', 'birthday', 'scheduled'].includes(definition.trigger.type))
      await enqueue(deps.db, 'automation.scan', {}, { dedupeKey: `automation.scan:publish:${id}:${data.published?.version}`, maxAttempts: 3 });
    res.json({ data });
  });

  for (const action of ['pause', 'resume', 'archive'] as const) {
    r.post(`${base}/automations/:workflowId/${action}`, ...guard, manage, async (req, res) => {
      const m = currentMembership(req);
      const id = wfId(req);
      const data = await withUser(deps.db, currentUser(req), async (tx) => {
        const w = await tx.query<{ status: string; current_version_id: string | null }>('select status, current_version_id from public.automation_workflows where id = $1 and business_id = $2', [id, m.businessId]);
        const cur = w.rows[0];
        if (!cur || cur.status === 'archived') throw notFound('Workflow not found');
        if (action === 'resume' && !cur.current_version_id) throw conflict('Publish the workflow first', 'not_published');
        const next = action === 'pause' ? 'paused' : action === 'resume' ? 'published' : 'archived';
        await tx.query('update public.automation_workflows set status = $2 where id = $1', [id, next]);
        return action === 'archive' ? null : loadWorkflow(tx, m.businessId, id);
      });
      if (action !== 'resume') {
        // Waiting executions stop at their next step (runExecution cancels them); cancel them now for clarity.
        await deps.db.query(`update public.automation_executions set status = 'cancelled', error = $2, finished_at = now() where workflow_id = $1 and status = 'waiting'`,
          [id, action === 'pause' ? 'Workflow paused' : 'Workflow archived']);
      }
      await writeAudit(deps.db, { businessId: m.businessId, actorUserId: currentUser(req).sub, action: `automation.${action}d`, targetType: 'automation_workflow', targetId: id, ...clientInfo(req) });
      res.json({ data });
    });
  }

  /** Run the published version for one contact now (manual test / enquiry triggers until Phase 7 integrations). */
  r.post(`${base}/automations/:workflowId/test`, ...guard, manage, async (req, res) => {
    const m = currentMembership(req);
    const id = wfId(req);
    const input = parse(z.object({ contactId: z.string().uuid(), text: z.string().max(1000).optional() }), req.body);
    const executionId = await withService(deps.db, async (tx) => {
      const w = await tx.query<any>(
        `select w.id, w.business_id, w.name, w.status, v.id as version_id, v.definition from public.automation_workflows w
         left join public.automation_versions v on v.id = w.current_version_id where w.id = $1 and w.business_id = $2`, [id, m.businessId]);
      const wf = w.rows[0];
      if (!wf) throw notFound('Workflow not found');
      if (wf.status !== 'published') throw conflict('Publish (or resume) the workflow before running it', 'not_published');
      const c = await tx.query('select 1 from public.contacts where id = $1 and business_id = $2', [input.contactId, m.businessId]);
      if (!c.rows.length) throw notFound('Contact not found');
      return startExecution(tx, wf, input.contactId, `${id}:test:${crypto.randomUUID()}`, { type: 'manual_test', by: currentUser(req).email }, { eventText: input.text }, 0);
    });
    res.status(201).json({ data: { executionId } });
  });

  // ---- execution history -----------------------------------------------------------
  const EXEC_SELECT = `select e.*, w.name as workflow_name, v.version, c.name as contact_name, c.phone_e164
    from public.automation_executions e join public.automation_workflows w on w.id = e.workflow_id
    join public.automation_versions v on v.id = e.version_id left join public.contacts c on c.id = e.contact_id`;

  r.get(`${base}/automation-executions`, ...guard, manage, async (req, res) => {
    const m = currentMembership(req);
    const q = parse(z.object({
      workflowId: z.string().uuid().optional(), status: z.enum(['running', 'waiting', 'completed', 'failed', 'cancelled']).optional(),
      page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(30),
    }), req.query);
    const where = ['e.business_id = $1'];
    const params: unknown[] = [m.businessId];
    if (q.workflowId) { params.push(q.workflowId); where.push(`e.workflow_id = $${params.length}`); }
    if (q.status) { params.push(q.status); where.push(`e.status = $${params.length}`); }
    const result = await withUser(deps.db, currentUser(req), async (tx) => {
      const total = await tx.query<{ n: number }>(`select count(*)::int as n from public.automation_executions e where ${where.join(' and ')}`, params);
      const rows = await tx.query(`${EXEC_SELECT} where ${where.join(' and ')} order by e.started_at desc limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`, params);
      return { total: total.rows[0]?.n ?? 0, rows: rows.rows };
    });
    res.json({ data: result.rows.map(mapExecution), meta: { page: q.page, pageSize: q.pageSize, total: result.total } });
  });

  r.get(`${base}/automation-executions/:executionId`, ...guard, manage, async (req, res) => {
    const m = currentMembership(req);
    const id = String(req.params.executionId);
    if (!isUuid(id)) throw notFound();
    const data = await withUser(deps.db, currentUser(req), async (tx) => {
      const e = await tx.query(`${EXEC_SELECT} where e.id = $1 and e.business_id = $2`, [id, m.businessId]);
      if (!e.rows[0]) throw notFound('Execution not found');
      const steps = await tx.query<any>('select * from public.automation_steps where execution_id = $1 order by created_at', [id]);
      return { ...mapExecution(e.rows[0]), steps: steps.rows.map((s) => ({ id: s.id, nodeId: s.node_id, type: s.node_type, status: s.status, output: s.output, error: s.error, attempts: s.attempts, startedAt: iso(s.started_at), finishedAt: iso(s.finished_at) })) };
    });
    res.json({ data });
  });

  /** Retry a failed execution from the step that failed (e.g. after reconnecting WhatsApp or approving a template). */
  r.post(`${base}/automation-executions/:executionId/retry`, ...guard, manage, async (req, res) => {
    const m = currentMembership(req);
    const id = String(req.params.executionId);
    if (!isUuid(id)) throw notFound();
    await withService(deps.db, async (tx) => {
      const u = await tx.query<{ steps_run: number }>(
        `update public.automation_executions set status = 'running', error = null, finished_at = null where id = $1 and business_id = $2 and status = 'failed' returning steps_run`, [id, m.businessId]);
      if (!u.rows[0]) throw conflict('Only failed executions can be retried', 'invalid_status');
      await enqueue(tx, 'automation.run', { executionId: id }, { businessId: m.businessId, dedupeKey: `auto-run:${id}:retry:${Date.now()}`, maxAttempts: 4 });
      await writeAudit(tx, { businessId: m.businessId, actorUserId: currentUser(req).sub, action: 'automation.execution_retried', targetType: 'automation_execution', targetId: id });
    });
    res.json({ data: { id, status: 'running' } });
  });

  r.post(`${base}/automation-executions/:executionId/cancel`, ...guard, manage, async (req, res) => {
    const m = currentMembership(req);
    const id = String(req.params.executionId);
    if (!isUuid(id)) throw notFound();
    const u = await deps.db.query(`update public.automation_executions set status = 'cancelled', error = 'Cancelled by user', finished_at = now()
       where id = $1 and business_id = $2 and status in ('running', 'waiting') returning id`, [id, m.businessId]);
    if (!u.rows[0]) throw conflict('Only running or waiting executions can be cancelled', 'invalid_status');
    res.json({ data: { id, status: 'cancelled' } });
  });

  // ---- in-app notifications (notify_staff) -------------------------------------------
  r.get(`${base}/notifications`, ...guard, async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const rows = await withUser(deps.db, user, (tx) => tx.query<any>(
      `select * from public.notification_logs where business_id = $1 and user_id = $2 and channel = 'in_app' order by created_at desc limit 30`, [m.businessId, user.sub]));
    const data: NotificationDto[] = rows.rows.map((n) => ({
      id: n.id, title: n.subject ?? 'Notification', body: n.metadata?.body ?? '', link: n.metadata?.link ?? null, readAt: iso(n.read_at), createdAt: iso(n.created_at)!,
    }));
    res.json({ data, meta: { unread: data.filter((n) => !n.readAt).length } });
  });

  r.post(`${base}/notifications/read-all`, ...guard, async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    await withUser(deps.db, user, (tx) => tx.query(`update public.notification_logs set read_at = now() where business_id = $1 and user_id = $2 and read_at is null`, [m.businessId, user.sub]));
    res.status(204).end();
  });

  return r;
}
