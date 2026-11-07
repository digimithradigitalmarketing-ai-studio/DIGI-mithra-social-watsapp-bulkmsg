import { Router } from 'express';
import { z } from 'zod';
import { createLeadSchema, createTaskSchema, updateLeadSchema, updateTaskSchema, type LeadDto, type PipelineDto, type ReportsDto, type TaskDto } from '@socialpilot/shared';
import type { Deps } from '../deps';
import type { Queryable } from '../db';
import { withUser } from '../db/context';
import { HttpError, notFound } from '../lib/errors';
import { clientInfo, iso, isUuid, parse } from '../lib/http';
import { writeAudit } from '../lib/audit';
import { toCsv } from '../lib/csv';
import { emitSafe } from '../automation/emit';
import { currentMembership, currentUser, requireAuth, requireMembership, requirePermission } from '../middleware/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */
const LEAD_SELECT = `select l.*, c.name as contact_name, c.phone_e164, p.full_name as assignee_name
  from public.leads l join public.contacts c on c.id = l.contact_id left join public.profiles p on p.id = l.assigned_to`;

const mapLead = (l: any): LeadDto => ({
  id: l.id, title: l.title, contact: { id: l.contact_id, name: l.contact_name, phone: l.phone_e164 }, pipelineId: l.pipeline_id, stageId: l.stage_id,
  status: l.status, source: l.source, valuePaise: l.value_paise == null ? null : Number(l.value_paise),
  assignedTo: l.assigned_to ? { id: l.assigned_to, name: l.assignee_name ?? '' } : null,
  expectedCloseDate: l.expected_close_date ? (l.expected_close_date instanceof Date ? l.expected_close_date.toISOString().slice(0, 10) : String(l.expected_close_date).slice(0, 10)) : null,
  lostReason: l.lost_reason, notes: l.notes ?? '', createdAt: iso(l.created_at)!, updatedAt: iso(l.updated_at)!,
});

const TASK_SELECT = `select t.*, c.name as contact_name, c.phone_e164, p.full_name as assignee_name
  from public.follow_up_tasks t left join public.contacts c on c.id = t.contact_id left join public.profiles p on p.id = t.assigned_to`;

const mapTask = (t: any): TaskDto => ({
  id: t.id, title: t.title, description: t.description, dueAt: iso(t.due_at), status: t.status,
  overdue: t.status === 'open' && !!t.due_at && new Date(t.due_at).getTime() < Date.now(),
  contact: t.contact_id ? { id: t.contact_id, name: t.contact_name, phone: t.phone_e164 } : null,
  leadId: t.lead_id, conversationId: t.conversation_id, assignedTo: t.assigned_to ? { id: t.assigned_to, name: t.assignee_name ?? '' } : null,
  completedAt: iso(t.completed_at), createdAt: iso(t.created_at)!,
});

async function assertMember(tx: Queryable, businessId: string, userId: string | null | undefined) {
  if (!userId) return;
  const r = await tx.query(`select 1 from public.business_members where business_id = $1 and user_id = $2 and status = 'active'`, [businessId, userId]);
  if (!r.rows.length) throw new HttpError(422, 'validation_failed', 'That person is not an active team member', { fields: { assignedTo: 'Not a team member' } });
}

async function stageInfo(tx: Queryable, businessId: string, stageId: string) {
  const s = await tx.query<{ id: string; pipeline_id: string; is_won: boolean; is_lost: boolean }>(
    'select id, pipeline_id, is_won, is_lost from public.lead_stages where id = $1 and business_id = $2', [stageId, businessId]);
  if (!s.rows[0]) throw new HttpError(422, 'validation_failed', 'Unknown pipeline stage', { fields: { stageId: 'Unknown stage' } });
  return s.rows[0];
}

export function crmRouter(deps: Deps): Router {
  const r = Router();
  const base = '/businesses/:businessId';
  const guard = [requireAuth(deps), requireMembership(deps)];
  const idParam = (req: any, name: string) => {
    const id = String(req.params[name]);
    if (!isUuid(id)) throw notFound();
    return id;
  };

  // ---- pipelines ----------------------------------------------------------------
  r.get(`${base}/pipelines`, ...guard, requirePermission('contacts.read'), async (req, res) => {
    const m = currentMembership(req);
    const data = await withUser(deps.db, currentUser(req), async (tx) => {
      const p = await tx.query<any>('select * from public.lead_pipelines where business_id = $1 order by is_default desc, created_at', [m.businessId]);
      const s = await tx.query<any>('select * from public.lead_stages where business_id = $1 order by position', [m.businessId]);
      return p.rows.map((x): PipelineDto => ({
        id: x.id, name: x.name, isDefault: x.is_default,
        stages: s.rows.filter((st) => st.pipeline_id === x.id).map((st) => ({ id: st.id, name: st.name, position: st.position, isWon: st.is_won, isLost: st.is_lost })),
      }));
    });
    res.json({ data });
  });

  // ---- leads -------------------------------------------------------------------------
  r.get(`${base}/leads`, ...guard, requirePermission('contacts.read'), async (req, res) => {
    const m = currentMembership(req);
    const q = parse(z.object({
      pipelineId: z.string().uuid().optional(), contactId: z.string().uuid().optional(), status: z.enum(['open', 'won', 'lost']).optional(),
      assignedTo: z.string().optional(), q: z.string().trim().max(100).optional(),
    }), req.query);
    const where = ['l.business_id = $1'];
    const params: unknown[] = [m.businessId];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (q.pipelineId) add('l.pipeline_id = ?', q.pipelineId);
    if (q.contactId) add('l.contact_id = ?', q.contactId);
    if (q.status) add('l.status = ?', q.status);
    if (q.assignedTo === 'me') add('l.assigned_to = ?', currentUser(req).sub);
    else if (q.assignedTo && isUuid(q.assignedTo)) add('l.assigned_to = ?', q.assignedTo);
    if (q.q) {
      params.push(`%${q.q.toLowerCase()}%`);
      where.push(`(lower(l.title) like $${params.length} or lower(c.name) like $${params.length})`);
    }
    const rows = await withUser(deps.db, currentUser(req), (tx) => tx.query(`${LEAD_SELECT} where ${where.join(' and ')} order by l.updated_at desc limit 500`, params));
    res.json({ data: rows.rows.map(mapLead) });
  });

  r.get(`${base}/lead-sources`, ...guard, requirePermission('contacts.read'), async (req, res) => {
    const m = currentMembership(req);
    const rows = await withUser(deps.db, currentUser(req), (tx) => tx.query<{ source: string; n: number }>(
      'select source, count(*)::int as n from public.leads where business_id = $1 group by source order by n desc', [m.businessId]));
    res.json({ data: rows.rows.map((x) => ({ source: x.source, count: x.n })) });
  });

  r.post(`${base}/leads`, ...guard, requirePermission('leads.update'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const input = parse(createLeadSchema, req.body);
    const lead: any = await withUser(deps.db, user, async (tx) => {
      const c = await tx.query('select 1 from public.contacts where id = $1 and business_id = $2', [input.contactId, m.businessId]);
      if (!c.rows.length) throw new HttpError(422, 'validation_failed', 'Contact not found', { fields: { contactId: 'Choose a contact' } });
      await assertMember(tx, m.businessId, input.assignedTo);
      let stage;
      if (input.stageId) stage = await stageInfo(tx, m.businessId, input.stageId);
      else {
        const s = await tx.query<any>(
          `select s.id, s.pipeline_id, s.is_won, s.is_lost from public.lead_stages s join public.lead_pipelines p on p.id = s.pipeline_id
           where s.business_id = $1 order by p.is_default desc, s.position limit 1`, [m.businessId]);
        stage = s.rows[0];
      }
      const ins = await tx.query<{ id: string }>(
        `insert into public.leads (business_id, contact_id, pipeline_id, stage_id, title, source, value_paise, status, assigned_to, expected_close_date, notes)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [m.businessId, input.contactId, stage?.pipeline_id ?? null, stage?.id ?? null, input.title, input.source,
         input.valueRupees != null ? Math.round(input.valueRupees * 100) : null, stage?.is_won ? 'won' : stage?.is_lost ? 'lost' : 'open',
         input.assignedTo ?? user.sub, input.expectedCloseDate ?? null, input.notes]);
      if (stage) await tx.query(`insert into public.lead_stage_events (business_id, lead_id, to_stage_id, changed_by) values ($1, $2, $3, $4)`, [m.businessId, ins.rows[0]!.id, stage.id, user.sub]);
      return (await tx.query(`${LEAD_SELECT} where l.id = $1`, [ins.rows[0]!.id])).rows[0];
    });
    if (lead.stage_id) await emitSafe(deps, [{ businessId: m.businessId, type: 'lead_stage_changed', contactId: lead.contact_id, eventId: `${lead.id}:${lead.stage_id}`, data: { stageId: lead.stage_id, leadId: lead.id } }]);
    res.status(201).json({ data: mapLead(lead) });
  });

  r.patch(`${base}/leads/:leadId`, ...guard, requirePermission('leads.update'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const id = idParam(req, 'leadId');
    const input = parse(updateLeadSchema, req.body);
    const result = await withUser(deps.db, user, async (tx) => {
      const cur = await tx.query<any>('select * from public.leads where id = $1 and business_id = $2', [id, m.businessId]);
      const lead = cur.rows[0];
      if (!lead) throw notFound('Lead not found');
      if (input.assignedTo !== undefined) await assertMember(tx, m.businessId, input.assignedTo);
      const sets: string[] = [];
      const vals: unknown[] = [id];
      const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
      if (input.title !== undefined) set('title', input.title);
      if (input.source !== undefined) set('source', input.source);
      if (input.valueRupees !== undefined) set('value_paise', input.valueRupees == null ? null : Math.round(input.valueRupees * 100));
      if (input.assignedTo !== undefined) set('assigned_to', input.assignedTo);
      if (input.expectedCloseDate !== undefined) set('expected_close_date', input.expectedCloseDate);
      if (input.lostReason !== undefined) set('lost_reason', input.lostReason);
      if (input.notes !== undefined) set('notes', input.notes);
      let stageChanged = false;
      if (input.stageId && input.stageId !== lead.stage_id) {
        const st = await stageInfo(tx, m.businessId, input.stageId);
        set('stage_id', st.id);
        set('pipeline_id', st.pipeline_id);
        set('status', st.is_won ? 'won' : st.is_lost ? 'lost' : 'open');
        await tx.query(`insert into public.lead_stage_events (business_id, lead_id, from_stage_id, to_stage_id, changed_by) values ($1, $2, $3, $4, $5)`,
          [m.businessId, id, lead.stage_id, st.id, user.sub]);
        stageChanged = true;
      }
      if (sets.length) await tx.query(`update public.leads set ${sets.join(', ')} where id = $1`, vals);
      return { row: (await tx.query(`${LEAD_SELECT} where l.id = $1`, [id])).rows[0], stageChanged };
    });
    if (result.stageChanged)
      await emitSafe(deps, [{ businessId: m.businessId, type: 'lead_stage_changed', contactId: (result.row as any).contact_id, eventId: `${id}:${input.stageId}:${Date.now()}`, data: { stageId: input.stageId, leadId: id } }]);
    if (result.stageChanged)
      await writeAudit(deps.db, { businessId: m.businessId, actorUserId: user.sub, action: 'lead.stage_changed', targetType: 'lead', targetId: id, metadata: { to: input.stageId }, ...clientInfo(req) });
    res.json({ data: mapLead(result.row) });
  });

  // ---- tasks ----------------------------------------------------------------------------
  r.get(`${base}/tasks`, ...guard, requirePermission('business.read'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const q = parse(z.object({
      view: z.enum(['mine', 'all', 'overdue', 'unassigned']).default('mine'),
      status: z.enum(['open', 'done', 'cancelled', 'any']).default('open'),
      contactId: z.string().uuid().optional(),
      leadId: z.string().uuid().optional(),
    }), req.query);
    const where = ['t.business_id = $1'];
    const params: unknown[] = [m.businessId];
    if (q.status !== 'any') { params.push(q.status); where.push(`t.status = $${params.length}`); }
    if (q.contactId) { params.push(q.contactId); where.push(`t.contact_id = $${params.length}`); }
    else if (q.leadId) { params.push(q.leadId); where.push(`t.lead_id = $${params.length}`); }
    else if (q.view === 'mine') { params.push(user.sub); where.push(`t.assigned_to = $${params.length}`); }
    else if (q.view === 'unassigned') where.push('t.assigned_to is null');
    else if (q.view === 'overdue') where.push(`t.status = 'open' and t.due_at < now()`);
    const rows = await withUser(deps.db, user, (tx) => tx.query(`${TASK_SELECT} where ${where.join(' and ')} order by t.due_at asc nulls last, t.created_at desc limit 500`, params));
    res.json({ data: rows.rows.map(mapTask) });
  });

  r.post(`${base}/tasks`, ...guard, requirePermission('business.read'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const input = parse(createTaskSchema, req.body);
    const row = await withUser(deps.db, user, async (tx) => {
      await assertMember(tx, m.businessId, input.assignedTo);
      let contactId = input.contactId ?? null;
      if (input.leadId) {
        const l = await tx.query<{ contact_id: string }>('select contact_id from public.leads where id = $1 and business_id = $2', [input.leadId, m.businessId]);
        if (!l.rows[0]) throw notFound('Lead not found');
        contactId = contactId ?? l.rows[0].contact_id;
      }
      if (input.conversationId) {
        const c = await tx.query<{ contact_id: string }>('select contact_id from public.conversations where id = $1 and business_id = $2', [input.conversationId, m.businessId]);
        if (!c.rows[0]) throw notFound('Conversation not found');
        contactId = contactId ?? c.rows[0].contact_id;
      }
      if (contactId) {
        const c = await tx.query('select 1 from public.contacts where id = $1 and business_id = $2', [contactId, m.businessId]);
        if (!c.rows.length) throw notFound('Contact not found');
      }
      const ins = await tx.query<{ id: string }>(
        `insert into public.follow_up_tasks (business_id, contact_id, lead_id, conversation_id, title, description, due_at, assigned_to, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [m.businessId, contactId, input.leadId ?? null, input.conversationId ?? null, input.title, input.description, input.dueAt ?? null,
         input.assignedTo === undefined ? user.sub : input.assignedTo, user.sub]);
      return (await tx.query(`${TASK_SELECT} where t.id = $1`, [ins.rows[0]!.id])).rows[0];
    });
    res.status(201).json({ data: mapTask(row) });
  });

  r.patch(`${base}/tasks/:taskId`, ...guard, requirePermission('business.read'), async (req, res) => {
    const m = currentMembership(req);
    const id = idParam(req, 'taskId');
    const input = parse(updateTaskSchema, req.body);
    const row = await withUser(deps.db, currentUser(req), async (tx) => {
      if (input.assignedTo !== undefined) await assertMember(tx, m.businessId, input.assignedTo);
      const sets: string[] = [];
      const vals: unknown[] = [id, m.businessId];
      const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
      if (input.title !== undefined) set('title', input.title);
      if (input.description !== undefined) set('description', input.description);
      if (input.dueAt !== undefined) set('due_at', input.dueAt);
      if (input.assignedTo !== undefined) set('assigned_to', input.assignedTo);
      if (input.status !== undefined) {
        set('status', input.status);
        sets.push(`completed_at = ${input.status === 'done' ? 'now()' : 'null'}`);
      }
      if (!sets.length) throw new HttpError(400, 'nothing_to_update', 'Nothing to update');
      const u = await tx.query(`update public.follow_up_tasks set ${sets.join(', ')} where id = $1 and business_id = $2 returning id`, vals);
      if (!u.rows[0]) throw notFound('Task not found');
      return (await tx.query(`${TASK_SELECT} where t.id = $1`, [id])).rows[0];
    });
    res.json({ data: mapTask(row) });
  });

  // ---- contact notes (customer timeline) -------------------------------------------------
  r.post(`${base}/contacts/:contactId/notes`, ...guard, requirePermission('contacts.read'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const id = idParam(req, 'contactId');
    const { body } = parse(z.object({ body: z.string().trim().min(1).max(4000) }), req.body);
    const row = await withUser(deps.db, user, async (tx) => {
      const c = await tx.query('select 1 from public.contacts where id = $1 and business_id = $2', [id, m.businessId]);
      if (!c.rows.length) throw notFound('Contact not found');
      return (await tx.query<any>('insert into public.contact_notes (business_id, contact_id, author_id, body) values ($1, $2, $3, $4) returning *', [m.businessId, id, user.sub, body])).rows[0];
    });
    res.status(201).json({ data: { id: row.id, body: row.body, createdAt: iso(row.created_at) } });
  });

  r.get(`${base}/contacts/:contactId/timeline`, ...guard, requirePermission('contacts.read'), async (req, res) => {
    const m = currentMembership(req);
    const id = idParam(req, 'contactId');
    const data = await withUser(deps.db, currentUser(req), async (tx) => {
      const c = await tx.query('select 1 from public.contacts where id = $1 and business_id = $2', [id, m.businessId]);
      if (!c.rows.length) throw notFound('Contact not found');
      const notes = await tx.query<any>(`select n.*, p.full_name as author_name from public.contact_notes n left join public.profiles p on p.id = n.author_id where n.contact_id = $1 order by n.created_at desc`, [id]);
      const leads = await tx.query(`${LEAD_SELECT} where l.contact_id = $1 order by l.created_at desc`, [id]);
      const tasks = await tx.query(`${TASK_SELECT} where t.contact_id = $1 order by t.status, t.due_at nulls last`, [id]);
      const stageEvents = await tx.query<any>(
        `select e.created_at, l.title, s.name as stage_name, p.full_name as by_name from public.lead_stage_events e
         join public.leads l on l.id = e.lead_id left join public.lead_stages s on s.id = e.to_stage_id left join public.profiles p on p.id = e.changed_by
         where l.contact_id = $1 order by e.created_at desc limit 50`, [id]);
      return {
        notes: notes.rows.map((n) => ({ id: n.id, body: n.body, authorName: n.author_name, createdAt: iso(n.created_at) })),
        leads: leads.rows.map(mapLead),
        tasks: tasks.rows.map(mapTask),
        stageEvents: stageEvents.rows.map((e) => ({ leadTitle: e.title, stage: e.stage_name, byName: e.by_name, createdAt: iso(e.created_at) })),
      };
    });
    res.json({ data });
  });

  // ---- reports ------------------------------------------------------------------------------
  const rangeSchema = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

  async function buildReport(tx: Queryable, businessId: string, days: number): Promise<ReportsDto> {
    const p = [businessId, days];
    const since = `now() - make_interval(days => $2)`;
    const [conv] = (await tx.query<any>(
      `select (select count(*)::int from public.conversations where business_id = $1 and created_at >= ${since}) as started,
              (select count(*)::int from public.conversations where business_id = $1 and closed_at >= ${since}) as closed,
              (select count(*)::int from public.messages where business_id = $1 and direction = 'inbound' and created_at >= ${since}) as inbound,
              (select count(*)::int from public.messages where business_id = $1 and direction = 'outbound' and created_at >= ${since}) as outbound,
              (select percentile_cont(0.5) within group (order by extract(epoch from c.first_response_at - fi.first_in) / 60)
                 from public.conversations c
                 cross join lateral (select min(x.created_at) as first_in from public.messages x where x.conversation_id = c.id and x.direction = 'inbound') fi
                 where c.business_id = $1 and c.first_response_at is not null and fi.first_in <= c.first_response_at and c.first_response_at >= ${since}) as median_frt,
              (select count(*)::int from public.conversations where business_id = $1 and status <> 'closed') as open_now,
              (select count(*)::int from public.conversations where business_id = $1 and status <> 'closed' and assigned_to is null) as unassigned_now`, p)).rows;
    const [leads] = (await tx.query<any>(
      `select count(*) filter (where created_at >= ${since})::int as created,
              count(*) filter (where status = 'won' and updated_at >= ${since})::int as won,
              count(*) filter (where status = 'lost' and updated_at >= ${since})::int as lost,
              coalesce(sum(value_paise) filter (where status = 'won' and updated_at >= ${since}), 0)::bigint as won_value
       from public.leads where business_id = $1`, p)).rows;
    const byStage = (await tx.query<any>(
      `select s.name as stage, count(l.id)::int as count from public.lead_stages s
       left join public.leads l on l.stage_id = s.id where s.business_id = $1 group by s.id order by s.position`, [businessId])).rows;
    const bySource = (await tx.query<any>(
      `select source, count(*)::int as count, count(*) filter (where status = 'won')::int as won from public.leads
       where business_id = $1 and created_at >= ${since} group by source order by count desc`, p)).rows;
    const [camp] = (await tx.query<any>(
      `select count(*)::int as count, coalesce(sum(sent_count), 0)::int as sent, coalesce(sum(delivered_count), 0)::int as delivered,
              coalesce(sum(read_count), 0)::int as read, coalesce(sum(replied_count), 0)::int as replied, coalesce(sum(failed_count), 0)::int as failed
       from public.campaigns where business_id = $1 and started_at >= ${since}`, p)).rows;
    const team = (await tx.query<any>(
      `select m.user_id, p.full_name as name, m.role,
              (select count(*)::int from public.messages x where x.business_id = $1 and x.sent_by = m.user_id and x.created_at >= ${since}) as replies,
              (select count(*)::int from public.conversations c where c.business_id = $1 and c.assigned_to = m.user_id and c.status <> 'closed') as assigned,
              (select percentile_cont(0.5) within group (order by extract(epoch from c.first_response_at - fi.first_in) / 60)
                 from public.conversations c
                 cross join lateral (select min(x.created_at) as first_in from public.messages x where x.conversation_id = c.id and x.direction = 'inbound') fi
                 where c.business_id = $1 and c.assigned_to = m.user_id and c.first_response_at is not null and fi.first_in <= c.first_response_at
                   and c.first_response_at >= ${since}) as frt,
              (select count(*)::int from public.follow_up_tasks t where t.business_id = $1 and t.assigned_to = m.user_id and t.status = 'done' and t.completed_at >= ${since}) as tasks_done,
              (select count(*)::int from public.leads l where l.business_id = $1 and l.assigned_to = m.user_id and l.status = 'won' and l.updated_at >= ${since}) as leads_won
       from public.business_members m join public.profiles p on p.id = m.user_id
       where m.business_id = $1 and m.status = 'active' order by replies desc, p.full_name`, p)).rows;
    const daily = (await tx.query<any>(
      `select to_char(d.day, 'YYYY-MM-DD') as date,
              (select count(*)::int from public.messages x where x.business_id = $1 and x.direction = 'inbound' and date_trunc('day', x.created_at) = d.day) as inbound,
              (select count(*)::int from public.messages x where x.business_id = $1 and x.direction = 'outbound' and date_trunc('day', x.created_at) = d.day) as outbound,
              (select count(*)::int from public.leads l where l.business_id = $1 and date_trunc('day', l.created_at) = d.day) as leads
       from generate_series(date_trunc('day', now() - make_interval(days => $2 - 1)), date_trunc('day', now()), interval '1 day') d(day) order by d.day`, p)).rows;
    const round = (v: unknown) => (v == null ? null : Math.round(Number(v) * 10) / 10);
    return {
      range: { from: new Date(Date.now() - days * 86400_000).toISOString(), to: new Date().toISOString() },
      conversations: { started: conv.started, closed: conv.closed, inbound: conv.inbound, outbound: conv.outbound, medianFirstResponseMinutes: round(conv.median_frt), openNow: conv.open_now, unassignedNow: conv.unassigned_now },
      leads: { created: leads.created, won: leads.won, lost: leads.lost, wonValuePaise: Number(leads.won_value), byStage, bySource },
      campaigns: camp,
      team: team.map((t) => ({ userId: t.user_id, name: t.name, role: t.role, replies: t.replies, conversationsAssigned: t.assigned, medianFirstResponseMinutes: round(t.frt), tasksDone: t.tasks_done, leadsWon: t.leads_won })),
      daily,
    };
  }

  r.get(`${base}/reports`, ...guard, requirePermission('analytics.read'), async (req, res) => {
    const m = currentMembership(req);
    const { days } = parse(rangeSchema, req.query);
    res.json({ data: await withUser(deps.db, currentUser(req), (tx) => buildReport(tx, m.businessId, days)) });
  });

  r.get(`${base}/reports/team.csv`, ...guard, requirePermission('analytics.read'), async (req, res) => {
    const m = currentMembership(req);
    const { days } = parse(rangeSchema, req.query);
    const report = await withUser(deps.db, currentUser(req), (tx) => buildReport(tx, m.businessId, days));
    const rows: unknown[][] = [['name', 'role', 'replies', 'open_conversations_assigned', 'median_first_response_minutes', 'tasks_done', 'leads_won']];
    for (const t of report.team) rows.push([t.name, t.role, t.replies, t.conversationsAssigned, t.medianFirstResponseMinutes, t.tasksDone, t.leadsWon]);
    rows.push([]);
    rows.push(['lead_source', 'leads', 'won']);
    for (const s of report.leads.bySource) rows.push([s.source, s.count, s.won]);
    res.type('text/csv').attachment(`team-report-${days}d.csv`).send(toCsv(rows));
  });

  return r;
}
