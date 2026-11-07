import { Router } from 'express';
import type { Deps } from '../deps';
import { sha256 } from '../lib/crypto';
import { HttpError } from '../lib/errors';
import { enqueue } from '../jobs/queue';
import { verifyMetaSignature } from '../whatsapp/webhook';
import { verifyWebhookSignature } from '../billing/razorpay';

/**
 * Meta WhatsApp webhooks.
 *  GET  /v1/webhooks/meta  — subscription verification (hub.challenge)
 *  POST /v1/webhooks/meta  — events. Signature-checked, stored idempotently, processed by the worker.
 * We answer 200 quickly; Meta retries non-2xx responses.
 */
export function webhooksRouter(deps: Deps): Router {
  const r = Router();

  r.get('/meta', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && deps.config.META_WEBHOOK_VERIFY_TOKEN && token === deps.config.META_WEBHOOK_VERIFY_TOKEN && typeof challenge === 'string') {
      res.type('text/plain').send(challenge);
      return;
    }
    res.status(403).json({ error: { code: 'forbidden', message: 'Verification failed' } });
  });

  r.post('/meta', async (req, res) => {
    if (!deps.config.META_APP_SECRET) throw new HttpError(503, 'webhook_not_configured', 'META_APP_SECRET is not configured');
    const raw: Buffer | undefined = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!raw || !verifyMetaSignature(raw, req.get('x-hub-signature-256'), deps.config.META_APP_SECRET)) {
      deps.logger.warn({ ip: req.ip }, 'rejected Meta webhook with invalid signature');
      throw new HttpError(401, 'invalid_signature', 'Invalid signature');
    }
    const eventId = sha256(raw.toString('utf8'));
    await deps.db.transaction(async (tx) => {
      const ins = await tx.query<{ id: string }>(
        `insert into public.webhook_events (provider, event_id, signature_valid, payload) values ('meta', $1, true, $2)
         on conflict (provider, event_id) do nothing returning id`,
        [eventId, JSON.stringify(req.body)],
      );
      if (ins.rows[0]) await enqueue(tx, 'webhook.process', { webhookEventId: ins.rows[0].id }, { dedupeKey: `wh:${ins.rows[0].id}`, maxAttempts: 8 });
    });
    res.status(200).json({ received: true });
  });

  /**
   * POST /v1/webhooks/razorpay — subscription and payment events. Signature-checked (X-Razorpay-Signature, HMAC-SHA256 of the raw body).
   * Stored idempotently by X-Razorpay-Event-Id and applied by the worker.
   */
  r.post('/razorpay', async (req, res) => {
    const secret = deps.config.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) throw new HttpError(503, 'webhook_not_configured', 'RAZORPAY_WEBHOOK_SECRET is not configured');
    const raw: Buffer | undefined = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!raw || !verifyWebhookSignature(raw, req.get('x-razorpay-signature'), secret)) {
      deps.logger.warn({ ip: req.ip }, 'rejected Razorpay webhook with invalid signature');
      throw new HttpError(401, 'invalid_signature', 'Invalid signature');
    }
    const eventId = req.get('x-razorpay-event-id') || sha256(raw.toString('utf8'));
    await deps.db.transaction(async (tx) => {
      const ins = await tx.query<{ id: string }>(
        `insert into public.webhook_events (provider, event_id, signature_valid, payload) values ('razorpay', $1, true, $2)
         on conflict (provider, event_id) do nothing returning id`,
        [eventId, JSON.stringify(req.body)],
      );
      if (ins.rows[0]) await enqueue(tx, 'webhook.process', { webhookEventId: ins.rows[0].id }, { dedupeKey: `wh:${ins.rows[0].id}`, maxAttempts: 8 });
    });
    res.status(200).json({ received: true });
  });

  return r;
}
