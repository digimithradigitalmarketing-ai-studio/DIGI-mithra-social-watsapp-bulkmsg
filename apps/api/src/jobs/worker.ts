import crypto from 'node:crypto';
import type { Deps } from '../deps';
import type { Queryable } from '../db';
import { claimJobs, completeJob, cancelJob, enqueue, recoverStaleJobs, retryOrFail, backoffSeconds, type JobRow } from './queue';
import { recomputeCampaign, startCampaign } from '../campaigns/service';
import { loadChannel, providerFor } from '../whatsapp/provider';
import { ProviderError } from '../whatsapp/errors';
import { mockStatusPayload, processMetaPayload } from '../whatsapp/webhook';
import { renderBody, type StoredTemplate } from '../whatsapp/templates';
import { optOut } from '../contacts/consent';
import { writeAudit } from '../lib/audit';
import { runExecution, scanSchedules } from '../automation/engine';
import { runAutoReply } from '../ai/assistant';
import { applyRazorpayEvent } from '../billing/service';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Handler = (deps: Deps, job: JobRow) => Promise<'done' | { retryIn: number; error: string } | { cancel: string }>;

const handlers: Record<string, Handler> = {
  'campaign.start': async (deps, job) => {
    await deps.db.transaction((tx) => startCampaign(tx, deps.config, String(job.payload.campaignId)));
    return 'done';
  },
  'message.send': sendCampaignMessage,
  'conversation.send': sendConversationMessage,
  'automation.run': async (deps, job) => {
    await runExecution(deps.db, deps.config, String(job.payload.executionId), job.attempts, job.max_attempts);
    return 'done';
  },
  'ai.reply': async (deps, job) => {
    const outcome = await runAutoReply(deps.db, deps.config, String(job.payload.conversationId), String(job.payload.messageId));
    deps.logger.debug({ outcome, conversationId: job.payload.conversationId }, 'ai auto-reply');
    return 'done';
  },
  'automation.scan': async (deps) => {
    const n = await scanSchedules(deps.db);
    if (n) deps.logger.info({ started: n }, 'scheduled automations started');
    await scheduleNextScan(deps.db);
    return 'done';
  },
  'webhook.process': async (deps, job) => {
    const ev = await deps.db.query<any>('select id, provider, payload, status from public.webhook_events where id = $1', [job.payload.webhookEventId]);
    const row = ev.rows[0];
    if (!row || row.status === 'processed') return 'done';
    try {
      if (row.provider === 'razorpay') {
        const outcome = await deps.db.transaction((tx) => applyRazorpayEvent(tx, row.payload));
        await deps.db.query(`update public.webhook_events set status = $2, processed_at = now(), attempts = attempts + 1, error = null where id = $1`,
          [row.id, outcome === 'applied' ? 'processed' : 'ignored']);
        return 'done';
      }
      const result = await deps.db.transaction((tx) => processMetaPayload(tx, row.payload));
      await deps.db.query(`update public.webhook_events set status = $2, processed_at = now(), attempts = attempts + 1, error = null where id = $1`,
        [row.id, result.statuses + result.inbound + result.templates > 0 ? 'processed' : 'ignored']);
      return 'done';
    } catch (err) {
      await deps.db.query(`update public.webhook_events set status = 'failed', attempts = attempts + 1, error = $2 where id = $1`, [row.id, (err as Error).message]);
      throw err;
    }
  },
  'mock.webhook': async (deps, job) => {
    await deps.db.transaction((tx) => processMetaPayload(tx, job.payload.body));
    return 'done';
  },
  'template.mock_review': async (deps, job) => {
    const t = await deps.db.query<any>('select id, status, components from public.message_templates where id = $1', [job.payload.templateId]);
    const row = t.rows[0];
    if (!row || row.status !== 'PENDING') return 'done';
    const body = (row.components as StoredTemplate['components']).find((c) => c.type === 'BODY')?.text ?? '';
    // Test hook: bodies containing "[reject]" are rejected so the rejection flow can be exercised.
    const rejected = body.toLowerCase().includes('[reject]');
    await deps.db.query(`update public.message_templates set status = $2, rejection_reason = $3, last_synced_at = now() where id = $1`,
      [row.id, rejected ? 'REJECTED' : 'APPROVED', rejected ? '(mock) Rejected because the body contains [reject]' : null]);
    return 'done';
  },
};

async function sendCampaignMessage(deps: Deps, job: JobRow): ReturnType<Handler> {
  const { db, config } = deps;
  const recipientId = String(job.payload.recipientId);
  const r = await db.query<any>(
    `select r.*, c.status as campaign_status, c.template_id, c.name as campaign_name, ct.opted_out_at, ct.marketing_opt_in, ct.utility_opt_in, ct.archived_at,
            exists (select 1 from public.suppression_lists s where (s.business_id = r.business_id or s.business_id is null) and s.phone_e164 = r.phone_e164) as suppressed
     from public.campaign_recipients r
     join public.campaigns c on c.id = r.campaign_id
     join public.contacts ct on ct.id = r.contact_id
     where r.id = $1`,
    [recipientId],
  );
  const rec = r.rows[0];
  if (!rec || rec.status !== 'pending') return 'done';
  if (rec.campaign_status === 'paused') return { cancel: 'campaign paused' };
  if (rec.campaign_status === 'cancelled') return { cancel: 'campaign cancelled' };

  const t = await db.query<any>('select id, name, language, category, status, components, variable_mapping from public.message_templates where id = $1', [rec.template_id]);
  const template = t.rows[0];

  // Re-check consent at send time: it may have changed since the campaign started.
  const purposeOk = template?.category === 'MARKETING' ? rec.marketing_opt_in : rec.utility_opt_in || rec.marketing_opt_in;
  const skip = rec.archived_at ? 'archived' : rec.opted_out_at ? 'opted_out' : rec.suppressed ? 'suppressed' : !purposeOk ? 'no_consent' : null;
  if (skip) {
    await db.query(`update public.campaign_recipients set status = 'skipped', skip_reason = $2 where id = $1`, [recipientId, skip]);
    await recomputeCampaign(db, rec.campaign_id);
    return 'done';
  }
  const channel = await loadChannel(db, rec.business_id);
  if (!channel || channel.status !== 'connected' || !template || template.status !== 'APPROVED') {
    const msg = !channel || channel.status !== 'connected' ? 'WhatsApp channel is not connected' : 'Template is no longer approved';
    await failRecipient(db, recipientId, rec.campaign_id, 'not_sendable', msg);
    return 'done';
  }

  const values: string[] = rec.variables ?? [];
  const body = renderBody(template, values);

  // Idempotent message row per recipient
  const msg = await db.transaction(async (tx) => {
    const existing = await tx.query<any>('select id, provider_message_id from public.messages where business_id = $1 and idempotency_key = $2', [rec.business_id, `cr:${recipientId}`]);
    if (existing.rows[0]) return existing.rows[0];
    let conv = await tx.query<{ id: string }>(`select id from public.conversations where business_id = $1 and contact_id = $2 and channel = 'whatsapp' and status <> 'closed'`, [rec.business_id, rec.contact_id]);
    if (!conv.rows[0]) conv = await tx.query<{ id: string }>(`insert into public.conversations (business_id, contact_id, phone_number_id) values ($1, $2, $3) returning id`, [rec.business_id, rec.contact_id, channel.phone.id]);
    const m = await tx.query<any>(
      `insert into public.messages (business_id, conversation_id, contact_id, direction, message_type, body, template_id, campaign_id, status, idempotency_key)
       values ($1, $2, $3, 'outbound', 'template', $4, $5, $6, 'queued', $7) returning id, provider_message_id`,
      [rec.business_id, conv.rows[0]!.id, rec.contact_id, body, template.id, rec.campaign_id, `cr:${recipientId}`],
    );
    await tx.query('update public.campaign_recipients set message_id = $2 where id = $1', [recipientId, m.rows[0].id]);
    return m.rows[0];
  });
  if (msg.provider_message_id) {
    // Already accepted by the provider in an earlier attempt: never send twice.
    await db.query(`update public.campaign_recipients set status = 'queued' where id = $1 and status = 'pending'`, [recipientId]);
    await recomputeCampaign(db, rec.campaign_id);
    return 'done';
  }

  await db.query(`update public.campaign_recipients set attempts = attempts + 1 where id = $1`, [recipientId]);
  try {
    const provider = await providerFor(db, config, rec.business_id, channel);
    const { providerMessageId } = await provider.sendTemplate({
      phoneNumberId: channel.phone.phoneNumberId, to: rec.phone_e164, templateName: template.name, language: template.language, bodyParams: values,
    });
    await db.transaction(async (tx) => {
      await tx.query(`update public.messages set provider_message_id = $2, status = 'sending', sent_by = null where id = $1`, [msg.id, providerMessageId]);
      await tx.query(`update public.campaign_recipients set status = 'queued', sent_at = now(), error_code = null, error_message = null where id = $1`, [recipientId]);
      await tx.query(`update public.contacts set last_contacted_at = now() where id = $1`, [rec.contact_id]);
      await tx.query(`update public.conversations set last_message_at = now(), last_outbound_at = now(), last_message_preview = $2 where id = (select conversation_id from public.messages where id = $1)`,
        [msg.id, body.slice(0, 140)]);
      if (provider.kind === 'mock') await scheduleMockReceipts(tx, rec.business_id, channel.phone.phoneNumberId, providerMessageId, rec.phone_e164);
      await recomputeCampaign(tx, rec.campaign_id);
    });
    return 'done';
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    if (err.effect === 'opt_out') {
      await db.transaction((tx) => optOut(tx, { businessId: rec.business_id, contactId: rec.contact_id, phone: rec.phone_e164, source: `meta_error_${err.code}`, reason: 'opt_out' }));
    }
    if (err.effect === 'channel_auth') {
      await db.query(`update public.connected_channels set status = 'error', last_error = $2 where id = $1`, [channel.channelId, `${err.code}: ${err.message}`]);
      await writeAudit(db, { businessId: rec.business_id, actorType: 'system', action: 'channel.error', targetType: 'connected_channel', targetId: channel.channelId, metadata: { code: err.code } });
    }
    if (err.retryable && job.attempts < job.max_attempts) {
      await db.query(`update public.campaign_recipients set error_code = $2, error_message = $3 where id = $1`, [recipientId, err.code, err.message]);
      return { retryIn: backoffSeconds(job.attempts, config.JOB_RETRY_BASE_SECONDS, err.retryAfterSeconds), error: `${err.code}: ${err.message}` };
    }
    await db.query(`update public.messages set status = 'failed', failed_at = now(), error_code = $2, error_message = $3 where id = $1`, [msg.id, err.code, err.message]);
    await failRecipient(db, recipientId, rec.campaign_id, err.code, err.message);
    // Exhausted retries go to the dead-letter state for operator review; permanent errors are simply recorded.
    return err.retryable ? { retryIn: -1, error: `${err.code}: ${err.message} (retries exhausted)` } : 'done';
  }
}

/** One-to-one message from the team inbox (text inside the 24h window, or an approved template). */
async function sendConversationMessage(deps: Deps, job: JobRow): ReturnType<Handler> {
  const { db, config } = deps;
  const r = await db.query<any>(
    `select m.*, c.last_inbound_at, ct.phone_e164, ct.opted_out_at, t.name as template_name, t.language as template_language, t.status as template_status, t.category as template_category
     from public.messages m join public.conversations c on c.id = m.conversation_id join public.contacts ct on ct.id = m.contact_id
     left join public.message_templates t on t.id = m.template_id where m.id = $1`,
    [job.payload.messageId],
  );
  const m = r.rows[0];
  if (!m || m.status !== 'queued' || m.provider_message_id) return 'done';
  const fail = async (code: string, message: string) => {
    await db.query(`update public.messages set status = 'failed', failed_at = now(), error_code = $2, error_message = $3 where id = $1`, [m.id, code, message]);
    return 'done' as const;
  };
  const windowOpen = m.last_inbound_at && new Date(m.last_inbound_at).getTime() > Date.now() - 24 * 3600_000;
  if (m.message_type === 'text' && !windowOpen) return fail('outside_24h_window', 'The 24-hour customer service window has closed. Send an approved template instead.');
  if (m.message_type === 'template') {
    if (m.template_status !== 'APPROVED') return fail('template_not_approved', 'Template is no longer approved');
    if (m.template_category === 'MARKETING' && m.opted_out_at) return fail('opted_out', 'Contact opted out of marketing messages');
  }
  const channel = await loadChannel(db, m.business_id);
  if (!channel || channel.status !== 'connected') return fail('not_connected', 'WhatsApp channel is not connected');
  try {
    const provider = await providerFor(db, config, m.business_id, channel);
    const { providerMessageId } = m.message_type === 'text'
      ? await provider.sendText({ phoneNumberId: channel.phone.phoneNumberId, to: m.phone_e164, body: m.body })
      : await provider.sendTemplate({ phoneNumberId: channel.phone.phoneNumberId, to: m.phone_e164, templateName: m.template_name, language: m.template_language, bodyParams: (job.payload.params as string[]) ?? [] });
    await db.transaction(async (tx) => {
      await tx.query(`update public.messages set provider_message_id = $2, status = 'sending' where id = $1`, [m.id, providerMessageId]);
      await tx.query(`update public.contacts set last_contacted_at = now() where id = $1`, [m.contact_id]);
      if (provider.kind === 'mock') await scheduleMockReceipts(tx, m.business_id, channel.phone.phoneNumberId, providerMessageId, m.phone_e164, m.message_type === 'text' ? 'service' : String(m.template_category).toLowerCase());
    });
    return 'done';
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    if (err.effect === 'channel_auth') await db.query(`update public.connected_channels set status = 'error', last_error = $2 where id = $1`, [channel.channelId, `${err.code}: ${err.message}`]);
    if (err.retryable && job.attempts < job.max_attempts) {
      await db.query(`update public.messages set error_code = $2, error_message = $3 where id = $1`, [m.id, err.code, err.message]);
      return { retryIn: backoffSeconds(job.attempts, config.JOB_RETRY_BASE_SECONDS, err.retryAfterSeconds), error: `${err.code}: ${err.message}` };
    }
    await fail(err.code, err.message);
    return err.retryable ? { retryIn: -1, error: `${err.code}: ${err.message} (retries exhausted)` } : 'done';
  }
}

const SCAN_INTERVAL_MS = 5 * 60_000;
/** The scheduler re-enqueues itself; the dedupe key per time bucket keeps exactly one pending scan. */
export async function scheduleNextScan(db: Queryable, from = Date.now()) {
  const next = Math.floor(from / SCAN_INTERVAL_MS) * SCAN_INTERVAL_MS + SCAN_INTERVAL_MS;
  await enqueue(db, 'automation.scan', {}, { runAt: new Date(next), dedupeKey: `automation.scan:${next}`, maxAttempts: 3 });
}

async function failRecipient(db: Queryable, recipientId: string, campaignId: string, code: string, message: string) {
  await db.query(`update public.campaign_recipients set status = 'failed', failed_at = now(), error_code = $2, error_message = $3 where id = $1`, [recipientId, code, message.slice(0, 500)]);
  await recomputeCampaign(db, campaignId);
}

async function scheduleMockReceipts(tx: Queryable, businessId: string, phoneNumberId: string, wamid: string, to: string, category = 'marketing') {
  const at = (ms: number) => new Date(Date.now() + ms);
  const steps: Array<[string, number, number?]> = to.endsWith('5050')
    ? [['sent', 500], ['failed', 1500, 131049]]
    : Number(to.slice(-1)) % 2 === 0
      ? [['sent', 500], ['delivered', 1500], ['read', 4000]]
      : [['sent', 500], ['delivered', 1500]];
  for (const [status, ms, code] of steps) {
    await enqueue(tx, 'mock.webhook', { body: mockStatusPayload(phoneNumberId, wamid, to, status, code, category) }, { businessId, runAt: at(ms), dedupeKey: `mock:${wamid}:${status}` });
  }
}

export interface Worker {
  /** Process due jobs once. Returns the number handled. */
  tick(): Promise<number>;
  /** Test helper: make every pending job due and process until the queue is empty. */
  drain(maxLoops?: number): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

export function createWorker(deps: Deps): Worker {
  const id = `worker-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<number> | null = null;
  let ticks = 0;

  async function runJob(job: JobRow) {
    const handler = handlers[job.kind];
    if (!handler) {
      await retryOrFail(deps.db, job, `No handler for job kind ${job.kind}`, null);
      return;
    }
    try {
      const outcome = await handler(deps, job);
      if (outcome === 'done') await completeJob(deps.db, job.id);
      else if ('cancel' in outcome) await cancelJob(deps.db, job.id, outcome.cancel);
      else await retryOrFail(deps.db, job, outcome.error, outcome.retryIn < 0 ? null : outcome.retryIn);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      deps.logger.error({ err, jobId: job.id, kind: job.kind }, 'job failed');
      const willRetry = await retryOrFail(deps.db, job, message, backoffSeconds(job.attempts, deps.config.JOB_RETRY_BASE_SECONDS));
      if (!willRetry && job.kind === 'message.send') {
        const rec = await deps.db.query<{ campaign_id: string; status: string }>('select campaign_id, status from public.campaign_recipients where id = $1', [job.payload.recipientId]);
        if (rec.rows[0]?.status === 'pending') await failRecipient(deps.db, String(job.payload.recipientId), rec.rows[0].campaign_id, 'internal_error', message);
      }
      if (!willRetry && job.kind === 'conversation.send') {
        await deps.db.query(`update public.messages set status = 'failed', failed_at = now(), error_code = 'internal_error', error_message = $2 where id = $1 and status = 'queued'`,
          [job.payload.messageId, message.slice(0, 500)]);
      }
    }
  }

  async function tick(): Promise<number> {
    if (ticks++ % 60 === 0) await recoverStaleJobs(deps.db);
    const jobs = await claimJobs(deps.db, id, deps.config.WORKER_BATCH_SIZE);
    for (const job of jobs) await runJob(job);
    return jobs.length;
  }

  const guardedTick = () => {
    if (running) return running;
    running = tick().finally(() => (running = null));
    return running;
  };

  return {
    tick: guardedTick,
    async drain(maxLoops = 200) {
      let total = 0;
      for (let i = 0; i < maxLoops; i++) {
        await deps.db.query(`update public.scheduled_jobs set run_at = now() where status = 'pending' and run_at > now() and kind <> 'automation.scan'`);
        const n = await guardedTick();
        total += n;
        if (n === 0) {
          const left = await deps.db.query<{ n: number }>(`select count(*)::int as n from public.scheduled_jobs where status = 'pending' and kind <> 'automation.scan'`);
          if (!left.rows[0]?.n) break;
        }
      }
      return total;
    },
    start() {
      if (timer) return;
      // Kick off the automation scheduler (date-based and scheduled workflows) right away.
      void enqueue(deps.db, 'automation.scan', {}, { dedupeKey: `automation.scan:boot:${Math.floor(Date.now() / 60_000)}`, maxAttempts: 3 })
        .catch((err) => deps.logger.error({ err }, 'could not schedule automation scan'));
      timer = setInterval(() => {
        guardedTick().catch((err) => deps.logger.error({ err }, 'worker tick failed'));
      }, deps.config.WORKER_POLL_MS);
      deps.logger.info({ workerId: id, pollMs: deps.config.WORKER_POLL_MS }, 'job worker started');
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (running) await running;
    },
  };
}
