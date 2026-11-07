import { Router } from 'express';
import { z } from 'zod';
import { can, type ConversationDetailDto, type ConversationDto, type InboxCountsDto } from '@socialpilot/shared';
import type { Deps } from '../deps';
import type { Queryable } from '../db';
import { withUser } from '../db/context';
import { HttpError, conflict, forbidden, notFound } from '../lib/errors';
import { clientInfo, iso, isUuid, parse } from '../lib/http';
import { writeAudit } from '../lib/audit';
import { enqueue } from '../jobs/queue';
import { renderBody, resolveAll, type StoredTemplate } from '../whatsapp/templates';
import { currentMembership, currentUser, requireAuth, requireMembership, requirePermission } from '../middleware/auth';
import { mapContact } from './contacts';

/* eslint-disable @typescript-eslint/no-explicit-any */
const WINDOW_MS = 24 * 3600_000;

const windowExpiresAt = (lastInbound: Date | string | null) =>
  lastInbound ? new Date(new Date(lastInbound).getTime() + WINDOW_MS).toISOString() : null;

const mapConversation = (c: any): ConversationDto => ({
  id: c.id,
  status: c.status,
  contact: { id: c.contact_id, name: c.contact_name, phone: c.phone_e164, optedOut: !!c.opted_out_at },
  assignedTo: c.assigned_to ? { id: c.assigned_to, name: c.assignee_name ?? '' } : null,
  lastMessageAt: iso(c.last_message_at),
  lastMessagePreview: c.last_message_preview,
  lastInboundAt: iso(c.last_inbound_at),
  windowExpiresAt: windowExpiresAt(c.last_inbound_at),
  windowOpen: !!c.last_inbound_at && new Date(c.last_inbound_at).getTime() > Date.now() - WINDOW_MS,
  unreadCount: c.unread_count,
  tags: c.tags ?? [],
  aiHandoffReason: c.ai_handoff_at ? c.ai_handoff_reason ?? 'Needs a person' : null,
  createdAt: iso(c.created_at)!,
});

const CONV_SELECT = `select c.*, ct.name as contact_name, ct.phone_e164, ct.opted_out_at, p.full_name as assignee_name
  from public.conversations c join public.contacts ct on ct.id = c.contact_id left join public.profiles p on p.id = c.assigned_to`;

async function loadConversation(tx: Queryable, businessId: string, id: string) {
  const r = await tx.query<any>(`${CONV_SELECT} where c.id = $1 and c.business_id = $2`, [id, businessId]);
  if (!r.rows[0]) throw notFound('Conversation not found');
  return r.rows[0];
}

export function inboxRouter(deps: Deps): Router {
  const r = Router();
  const base = '/businesses/:businessId';
  const guard = [requireAuth(deps), requireMembership(deps)];
  const convId = (req: any) => {
    const id = String(req.params.conversationId);
    if (!isUuid(id)) throw notFound('Conversation not found');
    return id;
  };

  // ---- list ------------------------------------------------------------------
  r.get(`${base}/conversations`, ...guard, requirePermission('conversations.read_assigned', 'conversations.read_all'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const q = parse(z.object({
      view: z.enum(['all', 'mine', 'unassigned']).default('all'),
      status: z.enum(['open', 'pending', 'closed', 'active']).default('active'),
      q: z.string().trim().max(100).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(30),
    }), req.query);
    const where = ['c.business_id = $1'];
    const params: unknown[] = [m.businessId];
    if (q.status === 'active') where.push(`c.status <> 'closed'`);
    else { params.push(q.status); where.push(`c.status = $${params.length}`); }
    if (q.view === 'mine') { params.push(user.sub); where.push(`c.assigned_to = $${params.length}`); }
    if (q.view === 'unassigned') where.push('c.assigned_to is null');
    if (q.q) {
      params.push(`%${q.q.toLowerCase()}%`);
      const i = params.length;
      const digits = q.q.replace(/\D/g, '');
      let phone = '';
      if (digits.length >= 3) { params.push(`%${digits}%`); phone = ` or ct.phone_e164 like $${params.length}`; }
      where.push(`(lower(ct.name) like $${i} or lower(coalesce(c.last_message_preview, '')) like $${i}${phone})`);
    }
    // RLS limits agents to assigned + unassigned conversations.
    const result = await withUser(deps.db, user, async (tx) => {
      const total = await tx.query<{ n: number }>(`select count(*)::int as n from public.conversations c join public.contacts ct on ct.id = c.contact_id where ${where.join(' and ')}`, params);
      const rows = await tx.query(`${CONV_SELECT} where ${where.join(' and ')} order by c.last_message_at desc nulls last, c.created_at desc limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`, params);
      return { total: total.rows[0]?.n ?? 0, rows: rows.rows };
    });
    res.json({ data: result.rows.map(mapConversation), meta: { page: q.page, pageSize: q.pageSize, total: result.total } });
  });

  r.get(`${base}/inbox/counts`, ...guard, requirePermission('conversations.read_assigned', 'conversations.read_all'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const row = await withUser(deps.db, user, (tx) => tx.query<InboxCountsDto>(
      `select count(*) filter (where status <> 'closed')::int as "all",
              count(*) filter (where status <> 'closed' and assigned_to = $2)::int as mine,
              count(*) filter (where status <> 'closed' and assigned_to is null)::int as unassigned,
              count(*) filter (where status <> 'closed' and unread_count > 0)::int as unread
       from public.conversations where business_id = $1`, [m.businessId, user.sub]));
    res.json({ data: row.rows[0] });
  });

  // ---- thread -----------------------------------------------------------------
  r.get(`${base}/conversations/:conversationId`, ...guard, requirePermission('conversations.read_assigned', 'conversations.read_all'), async (req, res) => {
    const m = currentMembership(req);
    const id = convId(req);
    const data = await withUser(deps.db, currentUser(req), async (tx): Promise<ConversationDetailDto> => {
      const c = await loadConversation(tx, m.businessId, id);
      const msgs = await tx.query<any>(
        `select m.*, p.full_name as sent_by_name, cp.name as campaign_name from public.messages m
         left join public.profiles p on p.id = m.sent_by left join public.campaigns cp on cp.id = m.campaign_id
         where m.conversation_id = $1 order by m.created_at desc limit 200`, [id]);
      const notes = await tx.query<any>(
        `select n.*, p.full_name as author_name from public.conversation_notes n left join public.profiles p on p.id = n.author_id
         where n.conversation_id = $1 order by n.created_at`, [id]);
      const contact = await tx.query<any>(
        `select c.*, coalesce((select json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) order by t.name)
           from public.contact_tags ct join public.tags t on t.id = ct.tag_id where ct.contact_id = c.id), '[]'::json) as tag_list
         from public.contacts c where c.id = $1`, [c.contact_id]);
      return {
        conversation: mapConversation(c),
        contact: mapContact(contact.rows[0]),
        messages: msgs.rows.reverse().map((x) => ({
          id: x.id, direction: x.direction, type: x.message_type, body: x.body, status: x.status, errorCode: x.error_code, errorMessage: x.error_message,
          sentByName: x.sent_by_ai ? 'AI assistant' : x.sent_by_name, campaignName: x.campaign_name, createdAt: iso(x.created_at)!,
        })),
        notes: notes.rows.map((n) => ({ id: n.id, body: n.body, authorName: n.author_name, createdAt: iso(n.created_at)! })),
      };
    });
    res.json({ data });
  });

  r.post(`${base}/conversations/:conversationId/read`, ...guard, requirePermission('conversations.read_assigned', 'conversations.read_all'), async (req, res) => {
    const m = currentMembership(req);
    await withUser(deps.db, currentUser(req), (tx) => tx.query('update public.conversations set unread_count = 0 where id = $1 and business_id = $2', [convId(req), m.businessId]));
    res.status(204).end();
  });

  // ---- reply ---------------------------------------------------------------------
  const replySchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), body: z.string().trim().min(1, 'Write a message').max(4096), clientId: z.string().uuid() }),
    z.object({ type: z.literal('template'), templateId: z.string().uuid(), variables: z.record(z.string(), z.string().trim().max(200)).default({}), clientId: z.string().uuid() }),
  ]);

  r.post(`${base}/conversations/:conversationId/messages`, ...guard, requirePermission('conversations.reply'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const id = convId(req);
    const input = parse(replySchema, req.body);
    const idempotencyKey = `ui:${input.clientId}`;

    const result = await withUser(deps.db, user, async (tx) => {
      const c = await loadConversation(tx, m.businessId, id); // RLS: agents only reach assigned/unassigned
      const dup = await tx.query<{ id: string }>('select id from public.messages where business_id = $1 and idempotency_key = $2', [m.businessId, idempotencyKey]);
      if (dup.rows[0]) return { messageId: dup.rows[0].id, duplicate: true };
      if (c.status === 'closed') throw conflict('Reopen the conversation before replying', 'conversation_closed');
      const windowOpen = !!c.last_inbound_at && new Date(c.last_inbound_at).getTime() > Date.now() - WINDOW_MS;

      let body: string;
      let templateId: string | null = null;
      let params: string[] = [];
      if (input.type === 'text') {
        if (!windowOpen) throw new HttpError(422, 'outside_24h_window', 'The customer has not messaged in the last 24 hours. WhatsApp only allows an approved template now.');
        body = input.body;
      } else {
        const t = await tx.query<any>('select id, name, status, category, components, variable_mapping from public.message_templates where id = $1 and business_id = $2', [input.templateId, m.businessId]);
        const tpl = t.rows[0] as (StoredTemplate & { id: string; status: string }) | undefined;
        if (!tpl) throw notFound('Template not found');
        if (tpl.status !== 'APPROVED') throw new HttpError(422, 'template_not_approved', 'Only approved templates can be sent');
        const contact = await tx.query<any>('select name, phone_e164, custom_fields, opted_out_at, marketing_opt_in, utility_opt_in from public.contacts where id = $1', [c.contact_id]);
        const ct = contact.rows[0];
        if (tpl.category === 'MARKETING' && (ct.opted_out_at || !ct.marketing_opt_in))
          throw new HttpError(422, 'no_consent', 'This contact has not opted in to marketing messages');
        const b = await tx.query<{ name: string }>('select name from public.businesses where id = $1', [m.businessId]);
        const resolved = resolveAll(tpl, { contact: ct, businessName: b.rows[0]!.name, defaults: input.variables });
        if (resolved.missing.length)
          throw new HttpError(422, 'missing_variables', `Fill in: ${resolved.missing.join(', ')}`, { missing: resolved.missing });
        params = resolved.values;
        body = renderBody(tpl, params);
        templateId = tpl.id;
      }

      const msg = await tx.query<{ id: string }>(
        `insert into public.messages (business_id, conversation_id, contact_id, direction, message_type, body, template_id, status, sent_by, idempotency_key)
         values ($1, $2, $3, 'outbound', $4, $5, $6, 'queued', $7, $8) returning id`,
        [m.businessId, id, c.contact_id, input.type, body, templateId, user.sub, idempotencyKey]);
      // Replying to an unassigned conversation claims it.
      await tx.query(
        `update public.conversations set last_message_at = now(), last_outbound_at = now(), last_message_preview = $2, unread_count = 0,
           first_response_at = coalesce(first_response_at, case when last_inbound_at is not null then now() end),
           assigned_to = coalesce(assigned_to, $3), ai_active = false, status = case when status = 'pending' then 'open' else status end
         where id = $1`,
        [id, body.slice(0, 140), user.sub]);
      return { messageId: msg.rows[0]!.id, duplicate: false, params };
    });
    if (!result.duplicate) {
      await enqueue(deps.db, 'conversation.send', { messageId: result.messageId, params: result.params ?? [] },
        { businessId: m.businessId, dedupeKey: `conv-send:${result.messageId}`, maxAttempts: deps.config.JOB_MAX_ATTEMPTS });
    }
    res.status(result.duplicate ? 200 : 201).json({ data: { id: result.messageId, duplicate: result.duplicate } });
  });

  // ---- assignment & status --------------------------------------------------------
  r.post(`${base}/conversations/:conversationId/assign`, ...guard, requirePermission('conversations.reply'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const id = convId(req);
    const { userId } = parse(z.object({ userId: z.string().uuid().nullable() }), req.body);
    const canAssign = can(m.role, 'conversations.assign');
    await withUser(deps.db, user, async (tx) => {
      const c = await loadConversation(tx, m.businessId, id);
      if (!canAssign) {
        // Agents may only claim an unassigned conversation or release their own.
        const claiming = userId === user.sub && !c.assigned_to;
        const releasing = userId === null && c.assigned_to === user.sub;
        if (!claiming && !releasing) throw forbidden('Only managers can assign conversations to other people');
      }
      if (userId) {
        const member = await tx.query(`select 1 from public.business_members where business_id = $1 and user_id = $2 and status = 'active'`, [m.businessId, userId]);
        if (!member.rows.length) throw new HttpError(422, 'validation_failed', 'That person is not an active team member', { fields: { userId: 'Not a team member' } });
      }
      await tx.query('update public.conversations set assigned_to = $2 where id = $1', [id, userId]);
    });
    await writeAudit(deps.db, { businessId: m.businessId, actorUserId: user.sub, action: 'conversation.assigned', targetType: 'conversation', targetId: id, metadata: { to: userId }, ...clientInfo(req) });
    const data = await withUser(deps.db, user, async (tx) => {
      const r2 = await tx.query<any>(`${CONV_SELECT} where c.id = $1`, [id]);
      return r2.rows[0] ? mapConversation(r2.rows[0]) : null; // null: agent assigned it away and can no longer see it
    });
    res.json({ data });
  });

  r.post(`${base}/conversations/:conversationId/status`, ...guard, requirePermission('conversations.reply'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const id = convId(req);
    const { status } = parse(z.object({ status: z.enum(['open', 'pending', 'closed']) }), req.body);
    const data = await withUser(deps.db, user, async (tx) => {
      const c = await loadConversation(tx, m.businessId, id);
      if (status !== 'closed' && c.status === 'closed') {
        const other = await tx.query(`select 1 from public.conversations where business_id = $1 and contact_id = $2 and channel = $3 and status <> 'closed' and id <> $4`,
          [m.businessId, c.contact_id, c.channel, id]);
        if (other.rows.length) throw conflict('This customer already has a newer open conversation', 'newer_conversation');
      }
      await tx.query(
        `update public.conversations set status = $2, closed_at = case when $2 = 'closed' then now() else null end,
           closed_by = case when $2 = 'closed' then $3::uuid else null end where id = $1`, [id, status, user.sub]);
      return mapConversation(await loadConversation(tx, m.businessId, id));
    });
    res.json({ data });
  });

  r.put(`${base}/conversations/:conversationId/tags`, ...guard, requirePermission('conversations.reply'), async (req, res) => {
    const m = currentMembership(req);
    const { tags } = parse(z.object({ tags: z.array(z.string().trim().min(1).max(30)).max(10) }), req.body);
    const data = await withUser(deps.db, currentUser(req), async (tx) => {
      await loadConversation(tx, m.businessId, convId(req));
      await tx.query('update public.conversations set tags = $2 where id = $1', [convId(req), [...new Set(tags)]]);
      return mapConversation(await loadConversation(tx, m.businessId, convId(req)));
    });
    res.json({ data });
  });

  r.post(`${base}/conversations/:conversationId/notes`, ...guard, requirePermission('conversations.reply'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const { body } = parse(z.object({ body: z.string().trim().min(1).max(2000) }), req.body);
    const note = await withUser(deps.db, user, async (tx) => {
      await loadConversation(tx, m.businessId, convId(req));
      return (await tx.query<any>(`insert into public.conversation_notes (business_id, conversation_id, author_id, body) values ($1, $2, $3, $4) returning *`,
        [m.businessId, convId(req), user.sub, body])).rows[0];
    });
    res.status(201).json({ data: { id: note.id, body: note.body, authorName: null, createdAt: iso(note.created_at) } });
  });

  // ---- canned replies ------------------------------------------------------------------
  r.get(`${base}/canned-replies`, ...guard, requirePermission('conversations.reply'), async (req, res) => {
    const m = currentMembership(req);
    const rows = await withUser(deps.db, currentUser(req), (tx) => tx.query<any>('select * from public.canned_replies where business_id = $1 order by shortcut', [m.businessId]));
    res.json({ data: rows.rows.map((x) => ({ id: x.id, shortcut: x.shortcut, title: x.title, body: x.body })) });
  });
  r.post(`${base}/canned-replies`, ...guard, requirePermission('campaigns.manage'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const input = parse(z.object({
      shortcut: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{1,40}$/, 'Use letters, numbers, - or _'),
      title: z.string().trim().min(1).max(80),
      body: z.string().trim().min(1).max(4096),
    }), req.body);
    const row = await withUser(deps.db, user, async (tx) => {
      const dup = await tx.query('select 1 from public.canned_replies where business_id = $1 and shortcut = $2', [m.businessId, input.shortcut]);
      if (dup.rows.length) throw conflict(`/${input.shortcut} already exists`, 'duplicate_shortcut');
      return (await tx.query<any>('insert into public.canned_replies (business_id, shortcut, title, body, created_by) values ($1, $2, $3, $4, $5) returning *',
        [m.businessId, input.shortcut, input.title, input.body, user.sub])).rows[0];
    });
    res.status(201).json({ data: { id: row.id, shortcut: row.shortcut, title: row.title, body: row.body } });
  });
  r.delete(`${base}/canned-replies/:replyId`, ...guard, requirePermission('campaigns.manage'), async (req, res) => {
    const m = currentMembership(req);
    const id = String(req.params.replyId);
    if (!isUuid(id)) throw notFound();
    const d = await withUser(deps.db, currentUser(req), (tx) => tx.query('delete from public.canned_replies where id = $1 and business_id = $2 returning id', [id, m.businessId]));
    if (!d.rows[0]) throw notFound();
    res.status(204).end();
  });

  return r;
}
