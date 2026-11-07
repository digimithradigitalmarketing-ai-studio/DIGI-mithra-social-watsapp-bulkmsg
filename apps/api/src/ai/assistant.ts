/**
 * Business-specific AI customer-service assistant.
 *
 * Pipeline for every answer:
 *   settings + plan/spend limits → pre-guards (handoff keywords, medical/health, empty knowledge)
 *   → retrieval → model (Gemini or mock) → post-guards (confidence, unverified prices/phones/links,
 *   instruction leakage) → usage + audit record.
 * Anything uncertain becomes a HANDOFF to staff, never a guess.
 */
import type { AiAnswerDto, AiContentInput } from '@socialpilot/shared';
import type { AppConfig } from '../config';
import type { Queryable } from '../db';
import { HttpError } from '../lib/errors';
import { enqueue } from '../jobs/queue';
import { retrieve, type RankedChunk } from './retrieval';
import { AiProviderError, createGeminiModel, createMockModel, type AiModel } from './models';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface AiSettingsRow {
  enabled: boolean;
  auto_reply_enabled: boolean;
  model: string;
  languages: string[];
  tone: string;
  system_instructions: string;
  handoff_confidence_threshold: number;
  monthly_token_limit: number;
  monthly_spend_limit_paise: number;
  handoff_keywords: string[];
  handoff_notify_user_ids: string[];
  max_ai_replies_per_conversation: number;
  only_when_unassigned: boolean;
}

export async function loadAiSettings(db: Queryable, businessId: string): Promise<AiSettingsRow> {
  let r = await db.query<AiSettingsRow>('select * from public.ai_settings where business_id = $1', [businessId]);
  if (!r.rows[0]) {
    await db.query(`insert into public.ai_settings (business_id) values ($1) on conflict (business_id) do nothing`, [businessId]);
    r = await db.query<AiSettingsRow>('select * from public.ai_settings where business_id = $1', [businessId]);
  }
  const s = r.rows[0]!;
  return { ...s, handoff_confidence_threshold: Number(s.handoff_confidence_threshold), monthly_token_limit: Number(s.monthly_token_limit), monthly_spend_limit_paise: Number(s.monthly_spend_limit_paise) };
}

export function modelFor(config: AppConfig): AiModel | null {
  if (config.AI_PROVIDER === 'gemini') return createGeminiModel(config, config.GEMINI_MODEL);
  if (config.AI_PROVIDER === 'mock') return createMockModel();
  return null;
}

export async function planTokenLimit(db: Queryable, businessId: string): Promise<number> {
  const r = await db.query<{ v: number | null }>(`select limit_value as v from public.subscription_entitlements where business_id = $1 and key = 'ai_tokens_monthly'`, [businessId]);
  return r.rows[0]?.v == null ? 0 : Number(r.rows[0].v);
}

export async function monthUsage(db: Queryable, businessId: string) {
  const r = await db.query<{ tokens: number; cost: number }>(
    `select coalesce(sum(input_tokens + output_tokens), 0)::bigint as tokens, coalesce(sum(cost_micros), 0)::bigint as cost
     from public.ai_usage where business_id = $1 and created_at >= date_trunc('month', now())`, [businessId]);
  return { tokens: Number(r.rows[0]?.tokens ?? 0), costPaise: Number(r.rows[0]?.cost ?? 0) / 10_000 }; // cost_micros = millionths of a rupee
}

const costMicros = (config: AppConfig, input: number, output: number) =>
  Math.round(((input / 1000) * config.AI_INPUT_COST_PAISE_PER_1K + (output / 1000) * config.AI_OUTPUT_COST_PAISE_PER_1K) * 10_000);

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------
const MEDICAL = /\b(injur\w*|pain|hurt\w*|doctor|medic\w*|medicine|tablet|diabet\w*|bp|blood pressure|pregnan\w*|surgery|heart|asthma|thyroid|supplement\w*|steroid\w*|physio\w*|sprain\w*|fracture\w*|knee problem|back problem)\b|ನೋವು|ವೈದ್ಯ|ಔಷಧ/i;
const INJECTION = /(ignore (all |any |the )?(previous|above|prior) (instructions|rules)|system prompt|you are now|act as|developer mode|reveal (your|the) (instructions|prompt)|disregard (the )?rules)/i;
const MONEY = /(?:₹|rs\.?|inr)\s*([\d][\d,]*(?:\.\d+)?)|([\d][\d,]*(?:\.\d+)?)\s*(?:rupees|rs\b|\/-|inr)/gi;
const PHONE = /\+?\d[\d\s-]{8,}\d/g;
const URL = /https?:\/\/\S+|www\.\S+/gi;

export const detectLanguage = (text: string, allowed: string[]): 'en' | 'kn' => (/[ಀ-೿]/.test(text) && allowed.includes('kn') ? 'kn' : 'en');

/** Numbers, phone numbers and links in the answer must match ones in the sources EXACTLY (not as substrings). */
export function unverified(answer: string, sources: RankedChunk[]): string | null {
  const corpus = sources.map((s) => s.text).join('\n');
  const num = (s: string) => s.replace(/,/g, '').replace(/\.0+$/, '');
  const phoneKey = (s: string) => s.replace(/\D/g, '').slice(-10);
  const cleanUrl = (s: string) => s.replace(/[).,!?;:'"]+$/, '').replace(/\/$/, '').toLowerCase();
  // Phones first, so their digits are not mistaken for prices.
  const corpusPhones = new Set((corpus.match(PHONE) ?? []).map(phoneKey));
  const corpusNumbers = new Set((corpus.replace(PHONE, ' ').match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(num));
  const corpusUrls = new Set((corpus.match(URL) ?? []).map(cleanUrl));
  const answerPhones = answer.match(PHONE) ?? [];
  for (const p of answerPhones) if (!corpusPhones.has(phoneKey(p))) return 'Phone number not in the knowledge base';
  for (const m of answer.replace(PHONE, ' ').matchAll(MONEY)) {
    const amount = num(m[1] ?? m[2] ?? '');
    if (amount && !corpusNumbers.has(amount)) return `Price ₹${amount} is not in the knowledge base`;
  }
  for (const u of answer.match(URL) ?? []) if (!corpusUrls.has(cleanUrl(u))) return 'Link not in the knowledge base';
  return null;
}

/** Mask phone numbers and emails before storing prompts in the audit trail. */
export const redact = (s: string) => s.replace(PHONE, '[phone]').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]').slice(0, 1000);

export interface AnswerOptions {
  question: string;
  history?: Array<{ role: 'customer' | 'business'; text: string }>;
  feature: 'auto_reply' | 'reply_suggestion';
  conversationId?: string | null;
  contactId?: string | null;
  /** Playground/test calls may run while the assistant is switched off. */
  ignoreEnabled?: boolean;
}

export async function answerQuestion(db: Queryable, config: AppConfig, businessId: string, opts: AnswerOptions): Promise<AiAnswerDto> {
  const settings = await loadAiSettings(db, businessId);
  const language = detectLanguage(opts.question, settings.languages);
  const guards: string[] = [];
  const base = { language, guards, sources: [] as AiAnswerDto['sources'] };
  const finish = async (dto: Omit<AiAnswerDto, 'language' | 'guards' | 'sources'> & { sources?: AiAnswerDto['sources'] }, model: string) => {
    const result: AiAnswerDto = { ...base, ...dto, sources: dto.sources ?? base.sources };
    await db.query(
      `insert into public.ai_usage (business_id, conversation_id, contact_id, feature, model, input_tokens, output_tokens, cost_micros, confidence, outcome, prompt_audit)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [businessId, opts.conversationId ?? null, opts.contactId ?? null, opts.feature, model, result.usage.inputTokens, result.usage.outputTokens,
       costMicros(config, result.usage.inputTokens, result.usage.outputTokens), Math.round(result.confidence * 100) / 100, result.outcome,
       JSON.stringify({ question: redact(opts.question), answer: result.answer ? redact(result.answer) : null, guards, handoffReason: result.handoffReason, sources: result.sources.map((s) => s.id), language })]);
    return result;
  };
  const zero = { inputTokens: 0, outputTokens: 0, costPaise: 0 };
  const model = modelFor(config);
  if (!model) throw new HttpError(503, 'ai_disabled', 'AI is not configured on this server');
  if (!settings.enabled && !opts.ignoreEnabled) throw new HttpError(409, 'ai_off', 'Turn on AI in AI Center settings first');

  // Limits: plan entitlement (0 = not included), optional lower workspace cap, optional spend cap.
  const plan = await planTokenLimit(db, businessId);
  if (plan <= 0) throw new HttpError(402, 'ai_not_in_plan', 'Business AI is included in the Business plan');
  const tokenLimit = settings.monthly_token_limit > 0 ? Math.min(settings.monthly_token_limit, plan) : plan;
  const used = await monthUsage(db, businessId);
  if (used.tokens >= tokenLimit || (settings.monthly_spend_limit_paise > 0 && used.costPaise >= settings.monthly_spend_limit_paise)) {
    guards.push('monthly_limit');
    return finish({ outcome: 'limit_reached', answer: null, confidence: 0, handoffReason: 'Monthly AI limit reached', usage: zero }, model.name);
  }

  // Pre-guards
  const q = opts.question.toLowerCase();
  const kw = settings.handoff_keywords.find((k) => new RegExp(`(^|[^\\p{L}])${k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'u').test(q));
  if (kw) { guards.push('handoff_keyword'); return finish({ outcome: 'handoff', answer: null, confidence: 0, handoffReason: `Customer asked for a person ("${kw}")`, usage: zero }, model.name); }
  if (MEDICAL.test(opts.question)) { guards.push('medical'); return finish({ outcome: 'handoff', answer: null, confidence: 0, handoffReason: 'Health or medical question — staff should answer', usage: zero }, model.name); }
  if (INJECTION.test(opts.question)) guards.push('possible_prompt_injection');

  const sources = await retrieve(db, businessId, opts.question);
  base.sources = sources.map((s) => ({ id: s.id, title: s.title }));
  if (!sources.length) {
    guards.push('no_knowledge');
    return finish({ outcome: 'handoff', answer: null, confidence: 0, handoffReason: 'Nothing in the knowledge base matches this question', usage: zero }, model.name);
  }

  let r;
  try {
    r = await model.answer({
      businessName: (await db.query<{ name: string }>('select name from public.businesses where id = $1', [businessId])).rows[0]!.name,
      question: opts.question, history: opts.history ?? [], sources, language, tone: settings.tone, instructions: settings.system_instructions,
    });
  } catch (err) {
    if (err instanceof AiProviderError && err.retryable) throw err;
    guards.push('provider_error');
    return finish({ outcome: 'error', answer: null, confidence: 0, handoffReason: (err as Error).message.slice(0, 200), usage: zero }, model.name);
  }
  const usage = { inputTokens: r.inputTokens, outputTokens: r.outputTokens, costPaise: costMicros(config, r.inputTokens, r.outputTokens) / 10_000 };
  const used_ = r.usedSourceIds.length ? base.sources.filter((s) => r.usedSourceIds.includes(s.id)) : base.sources.slice(0, 1);
  let answer = r.answer.trim().slice(0, 1000);

  if (/(system prompt|my instructions|these rules|<knowledge>|<customer_message>)/i.test(answer)) {
    guards.push('instruction_leak');
    return finish({ outcome: 'blocked', answer: null, confidence: 0, handoffReason: 'Answer blocked by safety check', usage, sources: used_ }, model.name);
  }
  if (r.needsHuman || !answer) return finish({ outcome: 'handoff', answer: null, confidence: r.confidence, handoffReason: r.reason || 'Not covered by the knowledge base', usage, sources: used_ }, model.name);
  const bad = unverified(answer, sources);
  if (bad) { guards.push('unverified_fact'); return finish({ outcome: 'handoff', answer: null, confidence: r.confidence, handoffReason: bad, usage, sources: used_ }, model.name); }
  if (r.confidence < settings.handoff_confidence_threshold) {
    guards.push('low_confidence');
    return finish({ outcome: 'handoff', answer, confidence: r.confidence, handoffReason: `Confidence ${Math.round(r.confidence * 100)}% is below the ${Math.round(settings.handoff_confidence_threshold * 100)}% threshold`, usage, sources: used_ }, model.name);
  }
  answer = answer.replace(/\*\*/g, '');
  return finish({ outcome: 'answered', answer, confidence: r.confidence, handoffReason: null, usage, sources: used_ }, model.name);
}

export async function composeContent(db: Queryable, config: AppConfig, businessId: string, input: AiContentInput) {
  const model = modelFor(config);
  if (!model) throw new HttpError(503, 'ai_disabled', 'AI is not configured on this server');
  const settings = await loadAiSettings(db, businessId);
  if (!settings.enabled) throw new HttpError(409, 'ai_off', 'Turn on AI in AI Center settings first');
  const plan = await planTokenLimit(db, businessId);
  if (plan <= 0) throw new HttpError(402, 'ai_not_in_plan', 'Business AI is included in the Business plan');
  const tokenLimit = settings.monthly_token_limit > 0 ? Math.min(settings.monthly_token_limit, plan) : plan;
  const used = await monthUsage(db, businessId);
  if (used.tokens >= tokenLimit || (settings.monthly_spend_limit_paise > 0 && used.costPaise >= settings.monthly_spend_limit_paise))
    throw new HttpError(402, 'ai_limit', 'Monthly AI limit reached');
  const b = await db.query<{ name: string }>('select name from public.businesses where id = $1', [businessId]);
  let r;
  try {
    r = await model.compose({ ...input, businessName: b.rows[0]!.name });
  } catch (err) {
    throw new HttpError(502, 'ai_error', `The AI service failed: ${(err as Error).message}`);
  }
  await db.query(
    `insert into public.ai_usage (business_id, feature, model, input_tokens, output_tokens, cost_micros, outcome, prompt_audit)
     values ($1, 'content_assistant', $2, $3, $4, $5, 'answered', $6)`,
    [businessId, model.name, r.inputTokens, r.outputTokens, costMicros(config, r.inputTokens, r.outputTokens), JSON.stringify({ question: redact(input.prompt), answer: redact(r.text), kind: input.kind })]);
  return { text: r.text, model: model.name };
}

// ---------------------------------------------------------------------------
// Conversation helpers
// ---------------------------------------------------------------------------
export async function conversationHistory(db: Queryable, conversationId: string, beforeMessageId?: string) {
  const r = await db.query<{ direction: string; body: string | null; id: string }>(
    `select id, direction, body from public.messages where conversation_id = $1 and body is not null order by created_at desc limit 11`, [conversationId]);
  return r.rows.filter((m) => m.id !== beforeMessageId).slice(0, 10).reverse()
    .map((m) => ({ role: m.direction === 'inbound' ? 'customer' as const : 'business' as const, text: m.body!.slice(0, 500) }));
}

/** Enqueue an auto-reply after a customer message (cheap checks only; the job re-checks everything). */
export async function maybeQueueAutoReply(db: Queryable, businessId: string, conversationId: string, messageId: string) {
  const s = await db.query<{ ok: boolean }>(
    `select (s.enabled and s.auto_reply_enabled) as ok from public.ai_settings s where s.business_id = $1`, [businessId]);
  if (!s.rows[0]?.ok) return;
  // Short debounce: if the customer sends several messages quickly, only the last one is answered.
  await enqueue(db, 'ai.reply', { conversationId, messageId }, { businessId, runAt: new Date(Date.now() + 4000), dedupeKey: `ai-reply:${messageId}`, maxAttempts: 3 });
}

export async function handoff(db: Queryable, businessId: string, conversationId: string, reason: string, question: string, notifyUserIds: string[]) {
  await db.query(`update public.conversations set ai_active = false, ai_handoff_reason = $2, ai_handoff_at = now(), status = 'open' where id = $1`, [conversationId, reason]);
  await db.query(`insert into public.conversation_notes (business_id, conversation_id, body) values ($1, $2, $3)`,
    [businessId, conversationId, `🤖 AI handed this conversation to the team: ${reason}.\nCustomer asked: “${question.slice(0, 300)}”`]);
  for (const userId of notifyUserIds) {
    const member = await db.query(`select 1 from public.business_members where business_id = $1 and user_id = $2 and status = 'active'`, [businessId, userId]);
    if (!member.rows.length) continue;
    await db.query(
      `insert into public.notification_logs (business_id, user_id, channel, template, subject, status, metadata, sent_at) values ($1, $2, 'in_app', 'ai_handoff', 'AI handoff', 'sent', $3, now())`,
      [businessId, userId, JSON.stringify({ body: `Customer needs a person: ${reason}`, link: `inbox/${conversationId}` })]);
  }
}

/** Job handler: decide whether to auto-reply to the latest customer message. */
export async function runAutoReply(db: Queryable, config: AppConfig, conversationId: string, messageId: string): Promise<string> {
  const c = await db.query<any>(
    `select c.*, m.body, m.direction, m.business_id as m_business,
            (select id from public.messages x where x.conversation_id = c.id and x.direction = 'inbound' order by x.created_at desc limit 1) as latest_inbound,
            exists (select 1 from public.messages x where x.conversation_id = c.id and x.direction = 'outbound' and x.sent_by is not null
                    and x.created_at > m.created_at) as human_replied
     from public.conversations c join public.messages m on m.id = $2 where c.id = $1`, [conversationId, messageId]);
  const conv = c.rows[0];
  if (!conv || conv.direction !== 'inbound' || !conv.body) return 'skipped:not_text';
  if (conv.latest_inbound !== messageId) return 'skipped:newer_message';
  if (conv.status === 'closed' || conv.ai_handoff_at) return 'skipped:handed_off_or_closed';
  if (conv.human_replied) return 'skipped:human_replied';
  const settings = await loadAiSettings(db, conv.business_id);
  if (!settings.enabled || !settings.auto_reply_enabled) return 'skipped:disabled';
  if (settings.only_when_unassigned && conv.assigned_to) return 'skipped:assigned';
  if (conv.ai_reply_count >= settings.max_ai_replies_per_conversation) {
    await handoff(db, conv.business_id, conversationId, `AI reply limit (${settings.max_ai_replies_per_conversation}) reached for this conversation`, conv.body, settings.handoff_notify_user_ids);
    return 'handoff:reply_limit';
  }
  if (!conv.last_inbound_at || new Date(conv.last_inbound_at).getTime() < Date.now() - 24 * 3600_000) return 'skipped:window_closed';

  let result: AiAnswerDto;
  try {
    result = await answerQuestion(db, config, conv.business_id, {
      question: conv.body, history: await conversationHistory(db, conversationId, messageId), feature: 'auto_reply', conversationId, contactId: conv.contact_id,
    });
  } catch (err) {
    if (err instanceof HttpError) { // plan/settings changed meanwhile: hand off quietly
      await handoff(db, conv.business_id, conversationId, err.message, conv.body, settings.handoff_notify_user_ids);
      return `handoff:${err.code}`;
    }
    throw err;
  }
  if (result.outcome !== 'answered' || !result.answer) {
    await handoff(db, conv.business_id, conversationId, result.handoffReason ?? 'AI could not answer', conv.body, settings.handoff_notify_user_ids);
    return `handoff:${result.outcome}`;
  }
  const m = await db.query<{ id: string }>(
    `insert into public.messages (business_id, conversation_id, contact_id, direction, message_type, body, status, sent_by_ai, idempotency_key)
     values ($1, $2, $3, 'outbound', 'text', $4, 'queued', true, $5) on conflict do nothing returning id`,
    [conv.business_id, conversationId, conv.contact_id, result.answer, `ai:${messageId}`]);
  if (!m.rows[0]) return 'skipped:duplicate';
  await db.query(`update public.conversations set ai_active = true, ai_reply_count = ai_reply_count + 1, last_message_at = now(), last_outbound_at = now(),
                    first_response_at = coalesce(first_response_at, now()), last_message_preview = $2 where id = $1`, [conversationId, result.answer.slice(0, 140)]);
  await enqueue(db, 'conversation.send', { messageId: m.rows[0].id, params: [] }, { businessId: conv.business_id, dedupeKey: `conv-send:${m.rows[0].id}`, maxAttempts: config.JOB_MAX_ATTEMPTS });
  return 'answered';
}
