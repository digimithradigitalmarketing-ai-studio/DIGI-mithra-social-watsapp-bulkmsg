import { Router } from 'express';
import { z } from 'zod';
import {
  aiContentSchema, aiSettingsSchema, aiTestSchema, knowledgeSourceSchema,
  type AiAuditDto, type AiSettingsDto, type AiUsageDto, type KnowledgeSourceDto,
} from '@socialpilot/shared';
import type { Deps } from '../deps';
import { withService, withUser } from '../db/context';
import { HttpError, notFound } from '../lib/errors';
import { clientInfo, iso, isUuid, parse } from '../lib/http';
import { writeAudit } from '../lib/audit';
import { answerQuestion, composeContent, conversationHistory, loadAiSettings, monthUsage, planTokenLimit, type AiSettingsRow } from '../ai/assistant';
import { currentMembership, currentUser, requireAuth, requireMembership, requirePermission } from '../middleware/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mapSettings = (s: AiSettingsRow, deps: Deps, planLimit: number): AiSettingsDto => ({
  enabled: s.enabled, autoReplyEnabled: s.auto_reply_enabled, languages: s.languages as Array<'en' | 'kn'>, tone: s.tone as AiSettingsDto['tone'],
  systemInstructions: s.system_instructions, handoffConfidenceThreshold: s.handoff_confidence_threshold, monthlyTokenLimit: s.monthly_token_limit,
  monthlySpendLimitPaise: s.monthly_spend_limit_paise, handoffKeywords: s.handoff_keywords, handoffNotifyUserIds: s.handoff_notify_user_ids,
  maxAiRepliesPerConversation: s.max_ai_replies_per_conversation, onlyWhenUnassigned: s.only_when_unassigned,
  provider: deps.config.AI_PROVIDER, model: deps.config.AI_PROVIDER === 'gemini' ? deps.config.GEMINI_MODEL : deps.config.AI_PROVIDER === 'mock' ? 'mock (offline)' : '—',
  planTokenLimit: planLimit,
});

const mapSource = (k: any): KnowledgeSourceDto => ({
  id: k.id, sourceType: k.source_type, title: k.title, question: k.question, answer: k.answer, content: k.content, language: k.language, status: k.status, updatedAt: iso(k.updated_at)!,
});

export function aiRouter(deps: Deps): Router {
  const r = Router();
  const base = '/businesses/:businessId/ai';
  const guard = [requireAuth(deps), requireMembership(deps)];
  const manage = requirePermission('ai.manage');

  // ---- settings ---------------------------------------------------------------
  r.get(`${base}/settings`, ...guard, manage, async (req, res) => {
    const m = currentMembership(req);
    const s = await withService(deps.db, (tx) => loadAiSettings(tx, m.businessId));
    res.json({ data: mapSettings(s, deps, await planTokenLimit(deps.db, m.businessId)) });
  });

  r.put(`${base}/settings`, ...guard, manage, async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const input = parse(aiSettingsSchema, req.body);
    const plan = await planTokenLimit(deps.db, m.businessId);
    if (input.enabled && plan <= 0) throw new HttpError(402, 'ai_not_in_plan', 'Business AI is included in the Business plan. Upgrade to turn it on.');
    if (input.enabled && deps.config.AI_PROVIDER === 'disabled') throw new HttpError(503, 'ai_disabled', 'AI is not configured on this server');
    if (input.handoffNotifyUserIds?.length) {
      const ok = await deps.db.query<{ n: number }>(`select count(*)::int as n from public.business_members where business_id = $1 and status = 'active' and user_id = any($2::uuid[])`, [m.businessId, input.handoffNotifyUserIds]);
      if (ok.rows[0]!.n !== input.handoffNotifyUserIds.length) throw new HttpError(422, 'validation_failed', 'Only active team members can be notified', { fields: { handoffNotifyUserIds: 'Not a team member' } });
    }
    const cols: Record<string, string> = {
      enabled: 'enabled', autoReplyEnabled: 'auto_reply_enabled', languages: 'languages', tone: 'tone', systemInstructions: 'system_instructions',
      handoffConfidenceThreshold: 'handoff_confidence_threshold', monthlyTokenLimit: 'monthly_token_limit', monthlySpendLimitPaise: 'monthly_spend_limit_paise',
      handoffKeywords: 'handoff_keywords', handoffNotifyUserIds: 'handoff_notify_user_ids', maxAiRepliesPerConversation: 'max_ai_replies_per_conversation', onlyWhenUnassigned: 'only_when_unassigned',
    };
    const sets: string[] = [];
    const vals: unknown[] = [m.businessId];
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined || !cols[k]) continue;
      vals.push(k === 'handoffKeywords' ? [...new Set((v as string[]).map((x) => x.toLowerCase()))] : v);
      sets.push(`${cols[k]} = $${vals.length}`);
    }
    await withService(deps.db, (tx) => loadAiSettings(tx, m.businessId)); // ensure row
    if (sets.length) await withUser(deps.db, user, (tx) => tx.query(`update public.ai_settings set ${sets.join(', ')} where business_id = $1`, vals));
    await writeAudit(deps.db, { businessId: m.businessId, actorUserId: user.sub, action: 'ai.settings_updated', targetType: 'ai_settings', metadata: { fields: Object.keys(input) }, ...clientInfo(req) });
    const s = await withService(deps.db, (tx) => loadAiSettings(tx, m.businessId));
    res.json({ data: mapSettings(s, deps, plan) });
  });

  // ---- knowledge base ------------------------------------------------------------
  r.get(`${base}/knowledge`, ...guard, manage, async (req, res) => {
    const m = currentMembership(req);
    const rows = await withUser(deps.db, currentUser(req), (tx) => tx.query(`select * from public.ai_knowledge_sources where business_id = $1 order by source_type, updated_at desc`, [m.businessId]));
    res.json({ data: rows.rows.map(mapSource) });
  });

  r.post(`${base}/knowledge`, ...guard, manage, async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const input = parse(knowledgeSourceSchema, req.body);
    const count = await deps.db.query<{ n: number }>(`select count(*)::int as n from public.ai_knowledge_sources where business_id = $1`, [m.businessId]);
    if ((count.rows[0]?.n ?? 0) >= 1000) throw new HttpError(422, 'too_many_sources', 'A knowledge base can hold up to 1,000 entries');
    const row = await withUser(deps.db, user, (tx) => tx.query(
      `insert into public.ai_knowledge_sources (business_id, source_type, title, question, answer, content, language, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [m.businessId, input.sourceType, input.sourceType === 'faq' ? input.question.slice(0, 120) : input.title,
       input.sourceType === 'faq' ? input.question : null, input.sourceType === 'faq' ? input.answer : null,
       input.sourceType === 'text' ? input.content : null, input.language, user.sub]));
    res.status(201).json({ data: mapSource(row.rows[0]) });
  });

  r.patch(`${base}/knowledge/:sourceId`, ...guard, manage, async (req, res) => {
    const m = currentMembership(req);
    const id = String(req.params.sourceId);
    if (!isUuid(id)) throw notFound();
    const input = parse(z.object({
      question: z.string().trim().min(3).max(300), answer: z.string().trim().min(1).max(2000), title: z.string().trim().min(2).max(120),
      content: z.string().trim().min(10).max(20_000), status: z.enum(['active', 'disabled']), language: z.enum(['en', 'kn']),
    }).partial(), req.body);
    const sets: string[] = [];
    const vals: unknown[] = [id, m.businessId];
    for (const [k, v] of Object.entries(input)) { if (v === undefined) continue; vals.push(v); sets.push(`${k} = $${vals.length}`); }
    if (!sets.length) throw new HttpError(400, 'nothing_to_update', 'Nothing to update');
    const row = await withUser(deps.db, currentUser(req), (tx) => tx.query(`update public.ai_knowledge_sources set ${sets.join(', ')} where id = $1 and business_id = $2 returning *`, vals));
    if (!row.rows[0]) throw notFound('Entry not found');
    res.json({ data: mapSource(row.rows[0]) });
  });

  r.delete(`${base}/knowledge/:sourceId`, ...guard, manage, async (req, res) => {
    const m = currentMembership(req);
    const id = String(req.params.sourceId);
    if (!isUuid(id)) throw notFound();
    const d = await withUser(deps.db, currentUser(req), (tx) => tx.query('delete from public.ai_knowledge_sources where id = $1 and business_id = $2 returning id', [id, m.businessId]));
    if (!d.rows[0]) throw notFound('Entry not found');
    res.status(204).end();
  });

  // ---- playground, suggestions, content ---------------------------------------------
  r.post(`${base}/test`, ...guard, manage, async (req, res) => {
    const m = currentMembership(req);
    const { question } = parse(aiTestSchema, req.body);
    const data = await withService(deps.db, (tx) => answerQuestion(tx, deps.config, m.businessId, { question, feature: 'reply_suggestion', ignoreEnabled: true }));
    res.json({ data });
  });

  r.post('/businesses/:businessId/conversations/:conversationId/ai-suggest', ...guard, requirePermission('conversations.reply'), async (req, res) => {
    const m = currentMembership(req);
    const id = String(req.params.conversationId);
    if (!isUuid(id)) throw notFound();
    // Visibility check under RLS (agents only see their own / unassigned conversations).
    const conv = await withUser(deps.db, currentUser(req), (tx) => tx.query<{ contact_id: string }>('select contact_id from public.conversations where id = $1 and business_id = $2', [id, m.businessId]));
    if (!conv.rows[0]) throw notFound('Conversation not found');
    const last = await deps.db.query<{ id: string; body: string }>(`select id, body from public.messages where conversation_id = $1 and direction = 'inbound' and body is not null order by created_at desc limit 1`, [id]);
    if (!last.rows[0]) throw new HttpError(409, 'no_customer_message', 'There is no customer message to reply to yet');
    const data = await withService(deps.db, async (tx) => answerQuestion(tx, deps.config, m.businessId, {
      question: last.rows[0]!.body, history: await conversationHistory(tx, id, last.rows[0]!.id), feature: 'reply_suggestion', conversationId: id, contactId: conv.rows[0]!.contact_id,
    }));
    res.json({ data });
  });

  r.post(`${base}/content`, ...guard, requirePermission('templates.manage'), async (req, res) => {
    const m = currentMembership(req);
    const input = parse(aiContentSchema, req.body);
    res.json({ data: await withService(deps.db, (tx) => composeContent(tx, deps.config, m.businessId, input)) });
  });

  // ---- usage analytics & audit trail -----------------------------------------------
  r.get(`${base}/usage`, ...guard, manage, async (req, res) => {
    const m = currentMembership(req);
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }), req.query);
    const s = await withService(deps.db, (tx) => loadAiSettings(tx, m.businessId));
    const plan = await planTokenLimit(deps.db, m.businessId);
    const month = await monthUsage(deps.db, m.businessId);
    const data = await withUser(deps.db, currentUser(req), async (tx) => {
      const outcomes = await tx.query<{ outcome: string; n: number }>(`select outcome, count(*)::int as n from public.ai_usage where business_id = $1 and created_at >= now() - make_interval(days => $2) group by outcome`, [m.businessId, days]);
      const features = await tx.query<{ feature: string; n: number }>(`select feature, count(*)::int as n from public.ai_usage where business_id = $1 and created_at >= now() - make_interval(days => $2) group by feature`, [m.businessId, days]);
      const daily = await tx.query<{ date: string; tokens: number; answered: number; handoff: number }>(
        `select to_char(d.day, 'YYYY-MM-DD') as date,
                coalesce(sum(u.input_tokens + u.output_tokens), 0)::int as tokens,
                count(u.id) filter (where u.outcome = 'answered')::int as answered,
                count(u.id) filter (where u.outcome in ('handoff', 'blocked', 'limit_reached'))::int as handoff
         from generate_series(date_trunc('day', now() - make_interval(days => $2 - 1)), date_trunc('day', now()), interval '1 day') d(day)
         left join public.ai_usage u on u.business_id = $1 and date_trunc('day', u.created_at) = d.day
         group by d.day order by d.day`, [m.businessId, days]);
      return { outcomes: outcomes.rows, features: features.rows, daily: daily.rows };
    });
    const tokenLimit = plan <= 0 ? 0 : s.monthly_token_limit > 0 ? Math.min(s.monthly_token_limit, plan) : plan;
    const dto: AiUsageDto = {
      month: { tokens: month.tokens, costPaise: Math.round(month.costPaise * 100) / 100, tokenLimit, spendLimitPaise: s.monthly_spend_limit_paise || null },
      outcomes: Object.fromEntries(data.outcomes.map((o) => [o.outcome, o.n])),
      byFeature: Object.fromEntries(data.features.map((f) => [f.feature, f.n])),
      daily: data.daily,
    };
    res.json({ data: dto });
  });

  r.get(`${base}/audit`, ...guard, manage, async (req, res) => {
    const m = currentMembership(req);
    const q = parse(z.object({ outcome: z.string().max(20).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(30) }), req.query);
    const params: unknown[] = [m.businessId];
    let where = 'u.business_id = $1';
    if (q.outcome) { params.push(q.outcome); where += ` and u.outcome = $2`; }
    const result = await withUser(deps.db, currentUser(req), async (tx) => {
      const total = await tx.query<{ n: number }>(`select count(*)::int as n from public.ai_usage u where ${where}`, params);
      const rows = await tx.query<any>(`select u.*, c.name as contact_name from public.ai_usage u left join public.contacts c on c.id = u.contact_id
        where ${where} order by u.created_at desc limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`, params);
      return { total: total.rows[0]?.n ?? 0, rows: rows.rows };
    });
    const data: AiAuditDto[] = result.rows.map((u) => ({
      id: u.id, feature: u.feature, outcome: u.outcome, confidence: u.confidence == null ? null : Number(u.confidence), model: u.model,
      question: u.prompt_audit?.question ?? null, answer: u.prompt_audit?.answer ?? null, guards: u.prompt_audit?.guards ?? [], handoffReason: u.prompt_audit?.handoffReason ?? null,
      contactName: u.contact_name, conversationId: u.conversation_id, inputTokens: u.input_tokens, outputTokens: u.output_tokens, createdAt: iso(u.created_at)!,
    }));
    res.json({ data, meta: { page: q.page, pageSize: q.pageSize, total: result.total } });
  });

  return r;
}
