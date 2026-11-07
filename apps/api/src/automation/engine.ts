/**
 * Automation engine.
 *
 *  emitEvent()  — called after business events (contact created, tag added, customer replied, lead stage changed,
 *                 enquiry submitted). Starts executions of matching published workflows.
 *  scanSchedules() — periodic job: date triggers (membership expiry, payment due, birthday) and scheduled
 *                 workflows, evaluated in each business's own timezone.
 *  runExecution() — walks the step tree from the execution's cursor. Waits park the execution and enqueue a
 *                 future job. Failed steps are retried by the job queue; exhausted retries leave the execution
 *                 'failed' for the Failed Automation Logs.
 *
 * Safety: executions are idempotent per (workflow, contact, event) key; events emitted by automation actions carry
 * depth+1 and stop at MAX_DEPTH (loop prevention); each execution runs at most MAX_STEPS steps.
 * All functions run in service context with explicit business_id filters.
 */
import {
  definitionSchema, walkSteps, type Condition, type Step, type TriggerType, type WorkflowDefinition,
} from '@socialpilot/shared';
import type { AppConfig } from '../config';
import type { Queryable } from '../db';
import { enqueue } from '../jobs/queue';
import { loadChannel } from '../whatsapp/provider';
import { renderBody, resolveAll, type StoredTemplate } from '../whatsapp/templates';
import { HttpError } from '../lib/errors';
import { answerQuestion, conversationHistory } from '../ai/assistant';

/* eslint-disable @typescript-eslint/no-explicit-any */
export const MAX_DEPTH = 3;
const MAX_STEPS = 200;
const STEPS_PER_RUN = 25;

export interface AutomationEvent {
  businessId: string;
  type: TriggerType;
  contactId: string;
  /** Unique id of the triggering occurrence (message id, tag link id, lead id + stage…) */
  eventId: string;
  data?: { text?: string; tagId?: string; stageId?: string; source?: string; formKey?: string; conversationId?: string; leadId?: string };
  depth?: number;
}

interface WorkflowRow { id: string; business_id: string; name: string; version_id: string; definition: WorkflowDefinition }

async function publishedWorkflows(db: Queryable, businessId: string, type?: TriggerType): Promise<WorkflowRow[]> {
  const r = await db.query<WorkflowRow>(
    `select w.id, w.business_id, w.name, v.id as version_id, v.definition from public.automation_workflows w
     join public.automation_versions v on v.id = w.current_version_id
     where w.business_id = $1 and w.status = 'published' ${type ? 'and w.trigger_type = $2' : ''}`,
    type ? [businessId, type] : [businessId],
  );
  return r.rows;
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
export function textMatches(text: string | undefined, keywords: string[]): boolean {
  if (!keywords.length) return true;
  if (!text) return false;
  const t = ` ${normalize(text).replace(/[^\p{L}\p{N} ]+/gu, ' ')} `;
  return keywords.some((k) => t.includes(` ${normalize(k)} `) || (k.length > 3 && t.includes(normalize(k))));
}

function triggerMatches(def: WorkflowDefinition, ev: AutomationEvent): boolean {
  const t = def.trigger;
  const d = ev.data ?? {};
  switch (t.type) {
    case 'tag_added': return d.tagId === t.config.tagId;
    case 'customer_replied': return textMatches(d.text, t.config.keywords);
    case 'lead_stage_changed': return !t.config.stageId || t.config.stageId === d.stageId;
    case 'contact_created': return !t.config.source || t.config.source === d.source;
    case 'enquiry_submitted':
    case 'website_form_submitted': return !t.config.formKey || t.config.formKey === d.formKey;
    default: return true;
  }
}

/** Local calendar date (YYYY-MM-DD) and hour/minute in a timezone. */
export function localParts(now: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) };
}

/** Start one execution unless the idempotency key already exists. Returns the execution id or null. */
export async function startExecution(db: Queryable, wf: WorkflowRow, contactId: string | null, key: string, trigger: Record<string, unknown>, context: Record<string, unknown>, depth: number) {
  const ins = await db.query<{ id: string }>(
    `insert into public.automation_executions (business_id, workflow_id, version_id, contact_id, trigger_event, idempotency_key, depth, status, context)
     values ($1, $2, $3, $4, $5, $6, $7, 'running', $8)
     on conflict (business_id, idempotency_key) do nothing returning id`,
    [wf.business_id, wf.id, wf.version_id, contactId, JSON.stringify(trigger), key, depth, JSON.stringify(context)],
  );
  const id = ins.rows[0]?.id;
  if (id) await enqueue(db, 'automation.run', { executionId: id }, { businessId: wf.business_id, dedupeKey: `auto-run:${id}:0`, maxAttempts: 4 });
  return id ?? null;
}

/** Fan an event out to matching published workflows. Safe to call inside the transaction that caused the event. */
export async function emitEvent(db: Queryable, ev: AutomationEvent, timeZone?: string): Promise<string[]> {
  const depth = ev.depth ?? 0;
  if (depth > MAX_DEPTH) return [];
  const workflows = (await publishedWorkflows(db, ev.businessId, ev.type)).filter((w) => triggerMatches(w.definition, ev));
  if (!workflows.length) return [];
  let tz = timeZone;
  if (!tz) tz = (await db.query<{ timezone: string }>('select timezone from public.businesses where id = $1', [ev.businessId])).rows[0]?.timezone ?? 'Asia/Kolkata';
  const today = localParts(new Date(), tz).date;
  const started: string[] = [];
  for (const wf of workflows) {
    const key = wf.definition.reentry === 'once' ? `${wf.id}:${ev.contactId}`
      : wf.definition.reentry === 'daily' ? `${wf.id}:${ev.contactId}:${today}`
      : `${wf.id}:${ev.contactId}:${ev.eventId}`;
    const id = await startExecution(db, wf, ev.contactId, key, { type: ev.type, eventId: ev.eventId, ...ev.data },
      { conversationId: ev.data?.conversationId, leadId: ev.data?.leadId, eventText: ev.data?.text }, depth);
    if (id) started.push(id);
  }
  return started;
}

// ---------------------------------------------------------------------------
// Dates for date-based triggers
// ---------------------------------------------------------------------------
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Parse YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, "30 Nov", "30 November 2026", "Nov 30". Returns y/m/d or null. */
export function parseFlexibleDate(input: unknown, today: { year: number; month: number; day: number }): { y: number; m: number; d: number } | null {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/, '$1').replace(/,/g, ' ');
  let y: number | undefined; let m: number | undefined; let d: number | undefined;
  let mm = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (mm) [y, m, d] = [Number(mm[1]), Number(mm[2]), Number(mm[3])];
  else if ((mm = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s))) [d, m, y] = [Number(mm[1]), Number(mm[2]), Number(mm[3]!.length === 2 ? `20${mm[3]}` : mm[3])];
  else if ((mm = /^(\d{1,2})\s+([a-z]{3,9})\.?(?:\s+(\d{4}))?$/.exec(s))) { d = Number(mm[1]); m = MONTHS.indexOf(mm[2]!.slice(0, 3)) + 1; y = mm[3] ? Number(mm[3]) : undefined; }
  else if ((mm = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:\s+(\d{4}))?$/.exec(s))) { m = MONTHS.indexOf(mm[1]!.slice(0, 3)) + 1; d = Number(mm[2]); y = mm[3] ? Number(mm[3]) : undefined; }
  if (!m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
  if (y === undefined) {
    // No year: the next occurrence (allowing dates up to ~6 months in the past to still count as this year).
    y = today.year;
    if (daysBetween({ y: today.year, m: today.month, d: today.day }, { y, m, d }) < -180) y += 1;
  }
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCMonth() !== m - 1) return null;
  return { y, m, d };
}

export function daysBetween(a: { y: number; m: number; d: number }, b: { y: number; m: number; d: number }) {
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400_000);
}

/** Periodic scheduler for date / scheduled triggers. Returns the number of executions started. */
export async function scanSchedules(db: Queryable, now = new Date()): Promise<number> {
  const wfs = await db.query<WorkflowRow & { timezone: string; trigger_type: TriggerType }>(
    `select w.id, w.business_id, w.name, w.trigger_type, v.id as version_id, v.definition, b.timezone
     from public.automation_workflows w join public.automation_versions v on v.id = w.current_version_id
     join public.businesses b on b.id = w.business_id
     where w.status = 'published' and b.status = 'active'
       and w.trigger_type in ('membership_expiring', 'payment_due', 'birthday', 'scheduled')`,
  );
  let started = 0;
  for (const wf of wfs.rows) {
    const local = localParts(now, wf.timezone);
    const t = wf.definition.trigger;
    const today = { year: local.year, month: local.month, day: local.day };
    const run = async (contactId: string, key: string, extra: Record<string, unknown> = {}) => {
      if (await startExecution(db, wf, contactId, key, { type: t.type, localDate: local.date, ...extra }, {}, 0)) started++;
    };

    if (t.type === 'membership_expiring' || t.type === 'payment_due') {
      if (local.hour < t.config.hour) continue;
      const contacts = await db.query<{ id: string; v: string }>(
        `select id, custom_fields->>$2 as v from public.contacts where business_id = $1 and archived_at is null and custom_fields ? $2 limit 50000`,
        [wf.business_id, t.config.field]);
      for (const c of contacts.rows) {
        const d = parseFlexibleDate(c.v, today);
        if (d && daysBetween({ y: today.year, m: today.month, d: today.day }, d) === t.config.daysBefore)
          await run(c.id, `${wf.id}:${c.id}:${local.date}`, { field: t.config.field, value: c.v });
      }
    } else if (t.type === 'birthday') {
      if (local.hour < t.config.hour) continue;
      const contacts = await db.query<{ id: string }>(
        `select id from public.contacts where business_id = $1 and archived_at is null and birthday is not null
           and extract(month from birthday) = $2 and extract(day from birthday) = $3`,
        [wf.business_id, local.month, local.day]);
      for (const c of contacts.rows) await run(c.id, `${wf.id}:${c.id}:${local.date}`);
    } else if (t.type === 'scheduled') {
      const cfg = t.config;
      let due = false;
      let key = '';
      if (cfg.mode === 'once' && cfg.at) { due = now.getTime() >= new Date(cfg.at).getTime(); key = 'once'; }
      if (cfg.mode === 'daily' && cfg.time) {
        const [h, m] = cfg.time.split(':').map(Number);
        due = local.hour > h! || (local.hour === h && local.minute >= m!);
        key = local.date;
      }
      if (!due) continue;
      const params: unknown[] = [wf.business_id];
      let tagFilter = '';
      if (cfg.audience.type === 'tags') {
        params.push(cfg.audience.tagIds);
        tagFilter = `and exists (select 1 from public.contact_tags ct where ct.contact_id = c.id and ct.tag_id = any($2::uuid[]))`;
      }
      const contacts = await db.query<{ id: string }>(`select c.id from public.contacts c where c.business_id = $1 and c.archived_at is null ${tagFilter} limit 50000`, params);
      for (const c of contacts.rows) await run(c.id, `${wf.id}:${c.id}:${key}`);
    }
  }
  return started;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------
type Cursor = Array<number | 'yes' | 'no'>;

function stepAt(steps: Step[], cursor: Cursor): Step | undefined {
  let list = steps;
  let step: Step | undefined;
  for (let i = 0; i < cursor.length; i += 2) {
    step = list[cursor[i] as number];
    if (!step) return undefined;
    if (i + 1 < cursor.length) {
      if (step.type !== 'branch') return undefined;
      list = cursor[i + 1] === 'yes' ? step.yes : step.no;
    }
  }
  return step;
}

/** Next sibling; when a branch arm ends, continue after the branch. */
function nextCursor(steps: Step[], cursor: Cursor): Cursor | null {
  let c = [...cursor];
  for (;;) {
    const advanced = [...c.slice(0, -1), (c[c.length - 1] as number) + 1];
    if (stepAt(steps, advanced)) return advanced;
    if (c.length === 1) return null;
    c = c.slice(0, -2);
  }
}

export class StepError extends Error {}

interface ExecContext { conversationId?: string; leadId?: string; eventText?: string }

interface StepResult { status: 'completed' | 'skipped'; output?: Record<string, unknown>; waitUntil?: Date; branch?: 'yes' | 'no' }

async function contactRow(db: Queryable, businessId: string, contactId: string | null) {
  if (!contactId) return null;
  const r = await db.query<any>(
    `select c.*, exists (select 1 from public.suppression_lists s where (s.business_id = c.business_id or s.business_id is null) and s.phone_e164 = c.phone_e164) as suppressed
     from public.contacts c where c.id = $1 and c.business_id = $2`, [contactId, businessId]);
  return r.rows[0] ?? null;
}

async function evaluate(db: Queryable, cond: Condition, exec: any, contact: any): Promise<boolean> {
  const ctx: ExecContext = exec.context ?? {};
  switch (cond.kind) {
    case 'has_tag': return !!contact && (await db.query('select 1 from public.contact_tags where contact_id = $1 and tag_id = $2', [contact.id, cond.tagId])).rows.length > 0;
    case 'marketing_consent': return !!contact && contact.marketing_opt_in && !contact.opted_out_at && !contact.suppressed;
    case 'field_equals': return !!contact && normalize(String(contact.custom_fields?.[cond.field] ?? '')) === normalize(cond.value);
    case 'field_present': return !!contact && String(contact.custom_fields?.[cond.field] ?? '').trim() !== '';
    case 'message_contains': return textMatches(ctx.eventText, cond.keywords);
    case 'language_is': return !!contact && contact.language === cond.language;
    case 'replied_since_start':
      return !!contact && (await db.query(`select 1 from public.messages where contact_id = $1 and direction = 'inbound' and created_at >= date_trunc('second', $2::timestamptz) limit 1`,
        [contact.id, exec.started_at])).rows.length > 0;
  }
}

async function openConversation(db: Queryable, businessId: string, contactId: string, preferId?: string, create = false): Promise<string | null> {
  if (preferId) {
    const r = await db.query<{ id: string }>(`select id from public.conversations where id = $1 and business_id = $2 and status <> 'closed'`, [preferId, businessId]);
    if (r.rows[0]) return r.rows[0].id;
  }
  const r = await db.query<{ id: string }>(`select id from public.conversations where business_id = $1 and contact_id = $2 and channel = 'whatsapp' and status <> 'closed' order by created_at desc limit 1`, [businessId, contactId]);
  if (r.rows[0]) return r.rows[0].id;
  if (!create) return null;
  const ch = await loadChannel(db, businessId);
  const ins = await db.query<{ id: string }>(`insert into public.conversations (business_id, contact_id, phone_number_id) values ($1, $2, $3) returning id`, [businessId, contactId, ch?.phone.id ?? null]);
  return ins.rows[0]!.id;
}

async function isMember(db: Queryable, businessId: string, userId: string | undefined) {
  if (!userId) return false;
  return (await db.query(`select 1 from public.business_members where business_id = $1 and user_id = $2 and status = 'active'`, [businessId, userId])).rows.length > 0;
}

async function runStep(db: Queryable, config: AppConfig, step: Step, exec: any, wf: { name: string }): Promise<StepResult> {
  const businessId: string = exec.business_id;
  const contact = await contactRow(db, businessId, exec.contact_id);
  const ctx: ExecContext = exec.context ?? {};
  const depth: number = exec.depth + 1;
  const needContact = () => { if (!contact) throw new StepError('This step needs a contact'); return contact; };

  switch (step.type) {
    case 'branch': {
      const yes = await evaluate(db, step.config.condition, exec, contact);
      return { status: 'completed', branch: yes ? 'yes' : 'no', output: { result: yes } };
    }
    case 'wait': {
      const minutes = step.config.amount * { minutes: 1, hours: 60, days: 1440 }[step.config.unit];
      return { status: 'completed', waitUntil: new Date(Date.now() + minutes * 60_000), output: { minutes } };
    }
    case 'send_template': {
      const c = needContact();
      const t = await db.query<any>('select id, name, status, category, components, variable_mapping from public.message_templates where id = $1 and business_id = $2', [step.config.templateId, businessId]);
      const tpl = t.rows[0] as (StoredTemplate & { id: string; status: string; category: string }) | undefined;
      if (!tpl || tpl.status !== 'APPROVED') throw new StepError('Template is missing or no longer approved');
      const channel = await loadChannel(db, businessId);
      if (!channel || channel.status !== 'connected') throw new StepError('WhatsApp is not connected');
      if (c.archived_at) return { status: 'skipped', output: { reason: 'archived' } };
      if (c.suppressed || (tpl.category === 'MARKETING' && c.opted_out_at)) return { status: 'skipped', output: { reason: 'opted_out' } };
      const consented = tpl.category === 'MARKETING' ? c.marketing_opt_in : c.utility_opt_in || c.marketing_opt_in;
      if (!consented) return { status: 'skipped', output: { reason: 'no_consent' } };
      const b = await db.query<{ name: string }>('select name from public.businesses where id = $1', [businessId]);
      const resolved = resolveAll(tpl, { contact: c, businessName: b.rows[0]!.name, defaults: step.config.defaults });
      if (resolved.missing.length) return { status: 'skipped', output: { reason: 'missing_variable', missing: resolved.missing } };
      const conversationId = (await openConversation(db, businessId, c.id, ctx.conversationId, true))!;
      const key = `auto:${exec.id}:${step.id}`;
      const existing = await db.query<{ id: string }>('select id from public.messages where business_id = $1 and idempotency_key = $2', [businessId, key]);
      let messageId = existing.rows[0]?.id;
      if (!messageId) {
        const body = renderBody(tpl, resolved.values);
        const m = await db.query<{ id: string }>(
          `insert into public.messages (business_id, conversation_id, contact_id, direction, message_type, body, template_id, status, idempotency_key)
           values ($1, $2, $3, 'outbound', 'template', $4, $5, 'queued', $6) returning id`,
          [businessId, conversationId, c.id, body, tpl.id, key]);
        messageId = m.rows[0]!.id;
        await db.query(`update public.conversations set last_message_at = now(), last_outbound_at = now(), last_message_preview = $2 where id = $1`, [conversationId, body.slice(0, 140)]);
        await enqueue(db, 'conversation.send', { messageId, params: resolved.values }, { businessId, dedupeKey: `conv-send:${messageId}`, maxAttempts: config.JOB_MAX_ATTEMPTS });
      }
      ctx.conversationId = conversationId;
      return { status: 'completed', output: { messageId, template: tpl.name } };
    }
    case 'assign_conversation': {
      const c = needContact();
      if (!(await isMember(db, businessId, step.config.userId))) throw new StepError('Assignee is no longer an active team member');
      const conv = await openConversation(db, businessId, c.id, ctx.conversationId);
      if (!conv) return { status: 'skipped', output: { reason: 'no_open_conversation' } };
      await db.query('update public.conversations set assigned_to = $2 where id = $1', [conv, step.config.userId]);
      ctx.conversationId = conv;
      return { status: 'completed', output: { conversationId: conv, userId: step.config.userId } };
    }
    case 'create_lead': {
      const c = needContact();
      let stage = step.config.stageId
        ? (await db.query<any>('select id, pipeline_id, is_won, is_lost from public.lead_stages where id = $1 and business_id = $2', [step.config.stageId, businessId])).rows[0]
        : (await db.query<any>(`select s.id, s.pipeline_id, s.is_won, s.is_lost from public.lead_stages s join public.lead_pipelines p on p.id = s.pipeline_id
             where s.business_id = $1 order by p.is_default desc, s.position limit 1`, [businessId])).rows[0];
      if (step.config.stageId && !stage) throw new StepError('Pipeline stage no longer exists');
      stage = stage ?? null;
      const assignee = step.config.assignTo && (await isMember(db, businessId, step.config.assignTo)) ? step.config.assignTo : null;
      const l = await db.query<{ id: string }>(
        `insert into public.leads (business_id, contact_id, pipeline_id, stage_id, title, source, status, assigned_to)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [businessId, c.id, stage?.pipeline_id ?? null, stage?.id ?? null, step.config.title, step.config.source, stage?.is_won ? 'won' : stage?.is_lost ? 'lost' : 'open', assignee]);
      if (stage) await db.query(`insert into public.lead_stage_events (business_id, lead_id, to_stage_id) values ($1, $2, $3)`, [businessId, l.rows[0]!.id, stage.id]);
      ctx.leadId = l.rows[0]!.id;
      if (stage) await emitEvent(db, { businessId, type: 'lead_stage_changed', contactId: c.id, eventId: `${l.rows[0]!.id}:${stage.id}`, data: { stageId: stage.id, leadId: l.rows[0]!.id }, depth });
      return { status: 'completed', output: { leadId: l.rows[0]!.id } };
    }
    case 'create_task': {
      const assignee = step.config.assignTo && (await isMember(db, businessId, step.config.assignTo)) ? step.config.assignTo : null;
      const t = await db.query<{ id: string }>(
        `insert into public.follow_up_tasks (business_id, contact_id, lead_id, conversation_id, title, description, due_at, assigned_to)
         values ($1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7), $8) returning id`,
        [businessId, exec.contact_id, ctx.leadId ?? null, ctx.conversationId ?? null, step.config.title, `Created by automation “${wf.name}”`, step.config.dueInHours, assignee]);
      return { status: 'completed', output: { taskId: t.rows[0]!.id } };
    }
    case 'add_tag':
    case 'remove_tag': {
      const c = needContact();
      const tag = await db.query('select 1 from public.tags where id = $1 and business_id = $2', [step.config.tagId, businessId]);
      if (!tag.rows.length) throw new StepError('Tag no longer exists');
      if (step.type === 'remove_tag') {
        const d = await db.query('delete from public.contact_tags where contact_id = $1 and tag_id = $2 returning id', [c.id, step.config.tagId]);
        return { status: d.rows.length ? 'completed' : 'skipped', output: { changed: d.rows.length > 0 } };
      }
      const ins = await db.query<{ id: string }>(`insert into public.contact_tags (business_id, contact_id, tag_id) values ($1, $2, $3) on conflict do nothing returning id`, [businessId, c.id, step.config.tagId]);
      if (ins.rows[0]) await emitEvent(db, { businessId, type: 'tag_added', contactId: c.id, eventId: ins.rows[0].id, data: { tagId: step.config.tagId }, depth });
      return { status: ins.rows[0] ? 'completed' : 'skipped', output: { changed: !!ins.rows[0] } };
    }
    case 'notify_staff': {
      const link = ctx.conversationId ? `inbox/${ctx.conversationId}` : exec.contact_id ? `contacts/${exec.contact_id}` : null;
      let n = 0;
      for (const userId of step.config.userIds) {
        if (!(await isMember(db, businessId, userId))) continue;
        await db.query(
          `insert into public.notification_logs (business_id, user_id, channel, template, subject, status, metadata, sent_at)
           values ($1, $2, 'in_app', 'automation', $3, 'sent', $4, now())`,
          [businessId, userId, wf.name, JSON.stringify({ body: step.config.message, link, contactName: contact?.name ?? null })]);
        n++;
      }
      return { status: n ? 'completed' : 'skipped', output: { notified: n } };
    }
    case 'update_field': {
      const c = needContact();
      await db.query(`update public.contacts set custom_fields = custom_fields || jsonb_build_object($2::text, $3::text) where id = $1`, [c.id, step.config.field, step.config.value]);
      return { status: 'completed', output: { field: step.config.field } };
    }
    case 'ai_reply_suggestion': {
      const c = needContact();
      const conv = await openConversation(db, businessId, c.id, ctx.conversationId);
      if (!conv) return { status: 'skipped', output: { reason: 'no_open_conversation' } };
      const last = await db.query<{ id: string; body: string }>(`select id, body from public.messages where conversation_id = $1 and direction = 'inbound' and body is not null order by created_at desc limit 1`, [conv]);
      if (!last.rows[0]) return { status: 'skipped', output: { reason: 'no_customer_message' } };
      let r;
      try {
        r = await answerQuestion(db, config, businessId, { question: last.rows[0].body, history: await conversationHistory(db, conv, last.rows[0].id), feature: 'reply_suggestion', conversationId: conv, contactId: c.id });
      } catch (err) {
        if (err instanceof HttpError) return { status: 'skipped', output: { reason: err.code } };
        throw err;
      }
      const note = r.answer
        ? `💡 AI suggested reply (${Math.round(r.confidence * 100)}% confidence${r.outcome !== 'answered' ? `, ${r.handoffReason}` : ''}):\n${r.answer}`
        : `💡 AI could not suggest a reply: ${r.handoffReason}`;
      await db.query(`insert into public.conversation_notes (business_id, conversation_id, body) values ($1, $2, $3)`, [businessId, conv, note]);
      ctx.conversationId = conv;
      return { status: 'completed', output: { outcome: r.outcome, confidence: r.confidence } };
    }
  }
}

/** Run (or resume) an execution. Throws on step failure so the job queue retries it. */
export async function runExecution(db: Queryable, config: AppConfig, executionId: string, attempt: number, maxAttempts: number): Promise<void> {
  const e = await db.query<any>(
    `select e.*, v.definition, v.version, w.status as workflow_status, w.name as workflow_name
     from public.automation_executions e join public.automation_versions v on v.id = e.version_id join public.automation_workflows w on w.id = e.workflow_id
     where e.id = $1`, [executionId]);
  const exec = e.rows[0];
  if (!exec || !['running', 'waiting'].includes(exec.status)) return;
  if (exec.workflow_status !== 'published') {
    await db.query(`update public.automation_executions set status = 'cancelled', error = 'Workflow was paused or archived', finished_at = now() where id = $1`, [executionId]);
    return;
  }
  const def = definitionSchema.parse(exec.definition);
  let cursor: Cursor | null = exec.cursor;
  await db.query(`update public.automation_executions set status = 'running', next_run_at = null where id = $1`, [executionId]);

  for (let n = 0; cursor && n < STEPS_PER_RUN; n++) {
    if (exec.steps_run >= MAX_STEPS) {
      await db.query(`update public.automation_executions set status = 'failed', error = 'Step limit reached (possible loop)', finished_at = now() where id = $1`, [executionId]);
      return;
    }
    const step = stepAt(def.steps, cursor);
    if (!step) break;
    const row = await db.query<{ id: string }>(
      `insert into public.automation_steps (business_id, execution_id, node_id, node_type, status, input, attempts, started_at)
       values ($1, $2, $3, $4, 'running', $5, $6, now()) returning id`,
      [exec.business_id, executionId, step.id, step.type, JSON.stringify(step.config ?? {}), attempt]);
    let result: StepResult;
    try {
      result = await runStep(db, config, step, exec, { name: exec.workflow_name });
    } catch (err) {
      const message = (err as Error).message;
      await db.query(`update public.automation_steps set status = 'failed', error = $2, finished_at = now() where id = $1`, [row.rows[0]!.id, message]);
      if (attempt >= maxAttempts || err instanceof StepError) {
        await db.query(`update public.automation_executions set status = 'failed', error = $2, finished_at = now(), context = $3 where id = $1`,
          [executionId, `Step "${step.id}" (${step.type}): ${message}`, JSON.stringify(exec.context)]);
        return;
      }
      throw err; // retried by the queue
    }
    exec.steps_run++;
    await db.query(`update public.automation_steps set status = $2, output = $3, finished_at = now() where id = $1`, [row.rows[0]!.id, result.status, JSON.stringify(result.output ?? {})]);
    if (step.type === 'branch') {
      const arm = result.branch === 'yes' ? step.yes : step.no;
      cursor = arm.length ? [...cursor, result.branch!, 0] : nextCursor(def.steps, cursor);
    } else cursor = nextCursor(def.steps, cursor);

    if (result.waitUntil) {
      await db.query(`update public.automation_executions set status = 'waiting', cursor = $2, steps_run = $3, next_run_at = $4, context = $5 where id = $1`,
        [executionId, JSON.stringify(cursor ?? [999]), exec.steps_run, result.waitUntil.toISOString(), JSON.stringify(exec.context)]);
      await enqueue(db, 'automation.run', { executionId }, { businessId: exec.business_id, runAt: result.waitUntil, dedupeKey: `auto-run:${executionId}:${exec.steps_run}`, maxAttempts: 4 });
      return;
    }
  }
  if (cursor && stepAt(def.steps, cursor)) {
    // More steps than one run allows: continue in a new job.
    await db.query(`update public.automation_executions set cursor = $2, steps_run = $3, context = $4 where id = $1`, [executionId, JSON.stringify(cursor), exec.steps_run, JSON.stringify(exec.context)]);
    await enqueue(db, 'automation.run', { executionId }, { businessId: exec.business_id, dedupeKey: `auto-run:${executionId}:${exec.steps_run}`, maxAttempts: 4 });
    return;
  }
  await db.query(`update public.automation_executions set status = 'completed', cursor = $2, steps_run = $3, context = $4, finished_at = now() where id = $1`,
    [executionId, JSON.stringify(cursor ?? []), exec.steps_run, JSON.stringify(exec.context)]);
}

// ---------------------------------------------------------------------------
// Publish-time validation
// ---------------------------------------------------------------------------
export async function validateDefinition(db: Queryable, businessId: string, raw: unknown): Promise<{ definition: WorkflowDefinition | null; errors: Array<{ stepId?: string; message: string }> }> {
  const parsed = definitionSchema.safeParse(raw);
  if (!parsed.success) {
    // Translate schema paths like steps.2.yes.0.config.tagId into the step's id and a readable label.
    const labels: Record<string, string> = {
      send_template: 'Send template', assign_conversation: 'Assign conversation', create_lead: 'Create lead', create_task: 'Create task',
      add_tag: 'Add tag', remove_tag: 'Remove tag', notify_staff: 'Notify staff', update_field: 'Update field', wait: 'Wait', branch: 'If/else',
    };
    const seen = new Set<string>();
    const errors: Array<{ stepId?: string; message: string }> = [];
    for (const issue of parsed.error.issues) {
      let node: any = raw; // eslint-disable-line @typescript-eslint/no-explicit-any
      let step: { id?: string; type?: string } | undefined;
      const path = issue.path.map(String);
      for (let i = 0; i < path.length && node != null; i++) {
        node = node[path[i]!];
        if ((path[i - 1] === 'steps' || path[i - 1] === 'yes' || path[i - 1] === 'no') && /^\d+$/.test(path[i]!)) step = node;
      }
      const where = path[0] === 'trigger' ? 'Trigger' : step?.type ? labels[step.type] ?? step.type : 'Workflow';
      const key = `${step?.id ?? path[0]}:${issue.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      errors.push({ stepId: step?.id, message: `${where}: ${issue.message}` });
    }
    return { definition: null, errors: errors.slice(0, 20) };
  }
  const def = parsed.data;
  const errors: Array<{ stepId?: string; message: string }> = [];
  const ids = new Set<string>();
  let actions = 0;
  let total = 0;
  const templates = new Map((await db.query<{ id: string; status: string; name: string }>('select id, status, name from public.message_templates where business_id = $1', [businessId])).rows.map((t) => [t.id, t]));
  const tags = new Set((await db.query<{ id: string }>('select id from public.tags where business_id = $1', [businessId])).rows.map((t) => t.id));
  const members = new Set((await db.query<{ user_id: string }>(`select user_id from public.business_members where business_id = $1 and status = 'active'`, [businessId])).rows.map((m) => m.user_id));
  const stages = new Set((await db.query<{ id: string }>('select id from public.lead_stages where business_id = $1', [businessId])).rows.map((s) => s.id));

  const t = def.trigger;
  if (t.type === 'tag_added' && !tags.has(t.config.tagId)) errors.push({ message: 'Trigger: tag not found' });
  if (t.type === 'lead_stage_changed' && t.config.stageId && !stages.has(t.config.stageId)) errors.push({ message: 'Trigger: stage not found' });
  if (t.type === 'scheduled' && t.config.audience.type === 'tags') {
    if (!t.config.audience.tagIds.length) errors.push({ message: 'Trigger: choose at least one tag for the audience' });
    for (const id of t.config.audience.tagIds) if (!tags.has(id)) errors.push({ message: 'Trigger: audience tag not found' });
  }
  if (t.type === 'scheduled' && t.config.mode === 'once' && t.config.at && new Date(t.config.at).getTime() < Date.now() - 60_000)
    errors.push({ message: 'Trigger: the scheduled time is in the past' });

  walkSteps(def.steps, (s, depth) => {
    total++;
    if (ids.has(s.id)) errors.push({ stepId: s.id, message: 'Duplicate step id' });
    ids.add(s.id);
    if (depth >= 3) errors.push({ stepId: s.id, message: 'If/else can be nested at most 3 levels deep' });
    if (!['wait', 'branch'].includes(s.type)) actions++;
    switch (s.type) {
      case 'send_template': {
        const tpl = templates.get(s.config.templateId);
        if (!tpl) errors.push({ stepId: s.id, message: 'Choose a template' });
        else if (tpl.status !== 'APPROVED') errors.push({ stepId: s.id, message: `Template "${tpl.name}" is not approved yet` });
        break;
      }
      case 'add_tag': case 'remove_tag': if (!tags.has(s.config.tagId)) errors.push({ stepId: s.id, message: 'Choose a tag' }); break;
      case 'assign_conversation': if (!members.has(s.config.userId)) errors.push({ stepId: s.id, message: 'Choose an active team member' }); break;
      case 'notify_staff': for (const u of s.config.userIds) if (!members.has(u)) errors.push({ stepId: s.id, message: 'Someone to notify is not an active team member' }); break;
      case 'create_lead': if (s.config.stageId && !stages.has(s.config.stageId)) errors.push({ stepId: s.id, message: 'Stage not found' }); break;
      case 'branch':
        if (s.config.condition.kind === 'has_tag' && !tags.has(s.config.condition.tagId)) errors.push({ stepId: s.id, message: 'Condition: tag not found' });
        break;
    }
  });
  if (!actions) errors.push({ message: 'Add at least one action' });
  if (total > 50) errors.push({ message: 'Workflows can have at most 50 steps' });
  // Loop guard at design time: a workflow triggered by a tag must not add that same tag.
  if (t.type === 'tag_added') walkSteps(def.steps, (s) => { if (s.type === 'add_tag' && s.config.tagId === t.config.tagId) errors.push({ stepId: s.id, message: 'This would re-trigger the workflow (adds its own trigger tag)' }); });
  return { definition: def, errors };
}
