import crypto from 'node:crypto';
import type { Queryable } from '../db';
import { safeEqual } from '../lib/crypto';
import { optIn, optOut } from '../contacts/consent';
import { recomputeCampaign } from '../campaigns/service';
import { emitEvent } from '../automation/engine';
import { maybeQueueAutoReply } from '../ai/assistant';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Validate Meta's X-Hub-Signature-256 header: "sha256=" + HMAC-SHA256(app secret, raw body). */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return safeEqual(header, expected);
}

export const STOP_KEYWORDS = new Set(['STOP', 'STOP ALL', 'UNSUBSCRIBE', 'OPT OUT', 'OPTOUT', 'STOP PROMOTIONS', 'ನಿಲ್ಲಿಸಿ']);
export const START_KEYWORDS = new Set(['START', 'SUBSCRIBE', 'OPT IN', 'UNSTOP']);
const normalizeKeyword = (s: string) => s.trim().replace(/[.!]+$/, '').replace(/\s+/g, ' ').toUpperCase();

const STATUS_RANK: Record<string, number> = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4 };

export interface ProcessResult {
  statuses: number;
  inbound: number;
  templates: number;
  ignored: number;
}

/** Process one Meta webhook payload (object = whatsapp_business_account). Service context. Idempotent. */
export async function processMetaPayload(db: Queryable, payload: any): Promise<ProcessResult> {
  const result: ProcessResult = { statuses: 0, inbound: 0, templates: 0, ignored: 0 };
  if (payload?.object !== 'whatsapp_business_account') {
    result.ignored++;
    return result;
  }
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      if (change.field === 'message_template_status_update') {
        result.templates += await handleTemplateStatus(db, v);
        continue;
      }
      if (change.field !== 'messages') {
        result.ignored++;
        continue;
      }
      const phoneNumberId: string | undefined = v.metadata?.phone_number_id;
      const phone = phoneNumberId
        ? (await db.query<{ business_id: string }>('select business_id from public.whatsapp_phone_numbers where phone_number_id = $1', [phoneNumberId])).rows[0]
        : undefined;
      if (!phone) {
        result.ignored++;
        continue;
      }
      for (const s of v.statuses ?? []) result.statuses += await handleStatus(db, phone.business_id, s);
      const profiles = new Map<string, string>((v.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name ?? '']));
      for (const m of v.messages ?? []) result.inbound += await handleInbound(db, phone.business_id, phoneNumberId!, m, profiles.get(m.from) ?? '');
    }
  }
  return result;
}

async function handleStatus(db: Queryable, businessId: string, s: any): Promise<number> {
  const status: string = s.status;
  if (!['sent', 'delivered', 'read', 'failed'].includes(status)) return 0;
  const msg = await db.query<{ id: string; status: string; campaign_id: string | null; business_id: string; contact_id: string }>(
    'select id, status, campaign_id, business_id, contact_id from public.messages where provider_message_id = $1 and business_id = $2',
    [s.id, businessId],
  );
  const m = msg.rows[0];
  const occurredAt = new Date(Number(s.timestamp) * 1000 || Date.now());
  const error = s.errors?.[0] ?? null;
  const ins = await db.query(
    `insert into public.message_status_events (business_id, message_id, provider_message_id, status, error, pricing, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $7) on conflict (provider_message_id, status) do nothing returning id`,
    [businessId, m?.id ?? null, s.id, status, error ? JSON.stringify(error) : null, s.pricing ? JSON.stringify(s.pricing) : null, occurredAt.toISOString()],
  );
  if (!ins.rows[0] || !m) return 0; // duplicate delivery of the same status, or unknown message

  const tsCol = status === 'failed' ? 'failed_at' : `${status}_at`;
  if (status === 'failed') {
    if ((STATUS_RANK[m.status] ?? 0) < STATUS_RANK.delivered!) {
      await db.query(`update public.messages set status = 'failed', failed_at = $2, error_code = $3, error_message = $4 where id = $1`,
        [m.id, occurredAt.toISOString(), error ? String(error.code) : null, error?.message ?? error?.title ?? null]);
    }
  } else if (m.status === 'failed' ? status !== 'sent' : (STATUS_RANK[status] ?? 0) > (STATUS_RANK[m.status] ?? -1)) {
    // Webhooks can arrive out of order: a late 'sent' never undoes 'failed'; 'delivered'/'read' prove delivery and do.
    await db.query(`update public.messages set status = $2, ${tsCol} = $3 where id = $1`, [m.id, status, occurredAt.toISOString()]);
  } else {
    await db.query(`update public.messages set ${tsCol} = coalesce(${tsCol}, $2) where id = $1`, [m.id, occurredAt.toISOString()]);
  }

  // Usage metering (Meta charges are separate from the DigiMithra subscription)
  if (s.pricing?.billable !== false && s.pricing?.category && status === 'sent') {
    const category = String(s.pricing.category).toLowerCase();
    const metric = ['marketing', 'utility', 'authentication', 'service'].includes(category) ? `message_${category}` : null;
    if (metric) {
      const price = await db.query<{ price_micros: number; currency: string }>(
        `select price_micros, currency from public.message_pricing
         where country_code = 'IN' and category = upper($1) and effective_from <= current_date and (effective_to is null or effective_to >= current_date)
         order by effective_from desc limit 1`,
        [category],
      );
      await db.query(
        `insert into public.usage_events (business_id, metric, quantity, unit_cost_micros, currency, period_month, reference_type, reference_id)
         values ($1, $2, 1, $3, $4, date_trunc('month', now())::date, 'message', $5)`,
        [businessId, metric, price.rows[0]?.price_micros ?? null, price.rows[0]?.currency ?? 'INR', m.id],
      );
    }
  }

  if (m.campaign_id) {
    const rec = await db.query<{ id: string; status: string }>('select id, status from public.campaign_recipients where message_id = $1', [m.id]);
    const r = rec.rows[0];
    if (r) {
      const rRank: Record<string, number> = { pending: 0, queued: 1, sent: 2, delivered: 3, read: 4, replied: 5 };
      if (status === 'failed') {
        if ((rRank[r.status] ?? 0) < 3)
          await db.query(`update public.campaign_recipients set status = 'failed', failed_at = $2, error_code = $3, error_message = $4 where id = $1`,
            [r.id, occurredAt.toISOString(), error ? String(error.code) : null, error?.message ?? error?.title ?? null]);
      } else {
        const keep = r.status === 'replied' || (r.status === 'failed' ? status === 'sent' : (rRank[r.status] ?? 0) >= (rRank[status] ?? 0));
        const newStatus = keep ? r.status : status;
        await db.query(`update public.campaign_recipients set status = $2, ${tsCol} = coalesce(${tsCol}, $3) where id = $1`, [r.id, newStatus, occurredAt.toISOString()]);
      }
      await recomputeCampaign(db, m.campaign_id);
    }
  }
  return 1;
}

function inboundBody(m: any): { type: string; body: string | null; media: unknown } {
  switch (m.type) {
    case 'text': return { type: 'text', body: m.text?.body ?? '', media: null };
    case 'button': return { type: 'interactive', body: m.button?.text ?? m.button?.payload ?? '', media: null };
    case 'interactive': return { type: 'interactive', body: m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '', media: null };
    case 'image': case 'document': case 'audio': case 'video': case 'sticker':
      return { type: m.type, body: m[m.type]?.caption ?? null, media: { id: m[m.type]?.id, mime_type: m[m.type]?.mime_type } };
    case 'location': return { type: 'location', body: m.location?.name ?? null, media: m.location ?? null };
    case 'reaction': return { type: 'reaction', body: m.reaction?.emoji ?? null, media: null };
    default: return { type: 'unsupported', body: null, media: null };
  }
}

async function handleInbound(db: Queryable, businessId: string, phoneNumberId: string, m: any, profileName: string): Promise<number> {
  const phone = `+${String(m.from).replace(/\D/g, '')}`;
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) return 0;
  const contact = await db.query<{ id: string }>(
    `insert into public.contacts (business_id, name, phone_e164, source, last_contacted_at)
     values ($1, $2, $3, 'whatsapp_inbound', now())
     on conflict (business_id, phone_e164) do update set
       name = case when public.contacts.name = '' then excluded.name else public.contacts.name end,
       last_contacted_at = now()
     returning id, (xmax = 0) as inserted`,
    [businessId, profileName, phone],
  );
  const contactId = contact.rows[0]!.id;
  const isNewContact = !!(contact.rows[0] as { inserted?: boolean }).inserted;
  const phoneRow = await db.query<{ id: string }>('select id from public.whatsapp_phone_numbers where phone_number_id = $1', [phoneNumberId]);
  let conv = await db.query<{ id: string }>(
    `select id from public.conversations where business_id = $1 and contact_id = $2 and channel = 'whatsapp' and status <> 'closed'`,
    [businessId, contactId],
  );
  if (!conv.rows[0]) {
    conv = await db.query<{ id: string }>(
      `insert into public.conversations (business_id, contact_id, phone_number_id, status) values ($1, $2, $3, 'open') returning id`,
      [businessId, contactId, phoneRow.rows[0]?.id ?? null],
    );
  }
  const conversationId = conv.rows[0]!.id;
  const { type, body, media } = inboundBody(m);
  const receivedAt = new Date(Number(m.timestamp) * 1000 || Date.now()).toISOString();
  const ins = await db.query(
    `insert into public.messages (business_id, conversation_id, contact_id, direction, message_type, body, media, provider_message_id, status, created_at)
     values ($1, $2, $3, 'inbound', $4, $5, $6, $7, 'received', $8)
     on conflict (provider_message_id) where provider_message_id is not null do nothing returning id`,
    [businessId, conversationId, contactId, type, body, media ? JSON.stringify(media) : null, m.id, receivedAt],
  );
  if (!ins.rows[0]) return 0; // duplicate webhook delivery
  await db.query(
    `update public.conversations set last_message_at = $2, last_inbound_at = $2, unread_count = unread_count + 1, status = 'open',
       last_message_preview = $3 where id = $1`,
    [conversationId, receivedAt, (body ?? `[${type}]`).slice(0, 140)],
  );

  // Attribute the reply to the most recent campaign message (72h window)
  const rec = await db.query<{ id: string; campaign_id: string }>(
    `select r.id, r.campaign_id from public.campaign_recipients r
     where r.business_id = $1 and r.contact_id = $2 and r.status in ('queued', 'sent', 'delivered', 'read') and r.sent_at > now() - interval '72 hours'
     order by r.sent_at desc limit 1`,
    [businessId, contactId],
  );
  if (rec.rows[0]) {
    await db.query(`update public.campaign_recipients set status = 'replied', replied_at = $2 where id = $1`, [rec.rows[0].id, receivedAt]);
    await recomputeCampaign(db, rec.rows[0].campaign_id);
  }

  // STOP / START keywords
  const keyword = body ? normalizeKeyword(body) : '';
  if (STOP_KEYWORDS.has(keyword)) {
    await optOut(db, { businessId, contactId, phone, source: 'whatsapp_stop_keyword', reason: 'stop_keyword', evidence: { message_id: m.id, text: body } });
  } else if (START_KEYWORDS.has(keyword)) {
    await optIn(db, { businessId, contactId, phone, source: 'whatsapp_start_keyword', evidence: { message_id: m.id, text: body } });
  }

  // Automations (same transaction: if processing fails, the webhook is retried and nothing is half-started)
  if (isNewContact) await emitEvent(db, { businessId, type: 'contact_created', contactId, eventId: contactId, data: { source: 'whatsapp_inbound', conversationId } });
  if (!STOP_KEYWORDS.has(keyword))
    await emitEvent(db, { businessId, type: 'customer_replied', contactId, eventId: String(m.id), data: { text: body ?? '', conversationId } });
  if (!STOP_KEYWORDS.has(keyword) && !START_KEYWORDS.has(keyword) && type === 'text' && body)
    await maybeQueueAutoReply(db, businessId, conversationId, (ins.rows[0] as { id: string }).id);
  return 1;
}

const TEMPLATE_EVENT_MAP: Record<string, string> = {
  APPROVED: 'APPROVED', REINSTATED: 'APPROVED', FLAGGED: 'APPROVED', REJECTED: 'REJECTED', IN_APPEAL: 'REJECTED',
  PAUSED: 'PAUSED', DISABLED: 'DISABLED', PENDING_DELETION: 'DISABLED', DELETED: 'DISABLED', PENDING: 'PENDING',
};

async function handleTemplateStatus(db: Queryable, v: any): Promise<number> {
  const status = TEMPLATE_EVENT_MAP[String(v.event ?? '').toUpperCase()];
  if (!status || !v.message_template_id) return 0;
  const r = await db.query(
    `update public.message_templates set status = $2, rejection_reason = $3, last_synced_at = now() where meta_template_id = $1 returning id`,
    [String(v.message_template_id), status, status === 'REJECTED' ? (v.reason ?? 'Rejected by Meta') : null],
  );
  return r.rows.length;
}

/** Build a Meta-format status webhook (used by the mock provider to exercise the real processing path). */
export function mockStatusPayload(phoneNumberId: string, wamid: string, to: string, status: string, errorCode?: number, category = 'marketing') {
  return {
    object: 'whatsapp_business_account',
    mock: true,
    entry: [{ id: 'mock', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: phoneNumberId },
      statuses: [{
        id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: to.replace('+', ''),
        ...(status === 'sent' ? { pricing: { billable: category !== 'service', pricing_model: 'PMP', category } } : {}),
        ...(errorCode ? { errors: [{ code: errorCode, title: '(mock) Message not delivered', message: '(mock) Message not delivered' }] } : {}),
      }],
    } }] }],
  };
}

export function mockInboundPayload(phoneNumberId: string, from: string, name: string, text: string) {
  return {
    object: 'whatsapp_business_account',
    mock: true,
    entry: [{ id: 'mock', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: phoneNumberId },
      contacts: [{ profile: { name }, wa_id: from.replace('+', '') }],
      messages: [{ from: from.replace('+', ''), id: `wamid.MOCKIN${crypto.randomBytes(10).toString('hex').toUpperCase()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
    } }] }],
  };
}
