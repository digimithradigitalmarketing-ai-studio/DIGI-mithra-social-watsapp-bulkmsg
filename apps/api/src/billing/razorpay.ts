import crypto from 'node:crypto';
import type { AppConfig } from '../config';
import { HttpError } from '../lib/errors';

/**
 * Billing provider. `mock` never touches the network and never moves money (dev, tests, demos).
 * `razorpay` calls the official Razorpay Subscriptions REST API with the server-side key secret.
 */
export interface BillingProvider {
  readonly mode: 'mock' | 'live';
  /** Public key id for the checkout widget (null in mock mode). */
  readonly keyId: string | null;
  createSubscription(input: { planId: string; totalCount: number; notes: Record<string, string> }): Promise<{ id: string; shortUrl: string | null }>;
  cancelSubscription(subscriptionId: string, atCycleEnd: boolean): Promise<void>;
}

/** Razorpay signs webhook bodies with HMAC-SHA256 (hex) using the webhook secret. */
export function verifyWebhookSignature(raw: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(raw).digest('hex'));
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

export function createBillingProvider(config: AppConfig): BillingProvider {
  if (config.BILLING_PROVIDER === 'mock') {
    return {
      mode: 'mock',
      keyId: null,
      async createSubscription() {
        return { id: `mock_sub_${crypto.randomBytes(8).toString('hex')}`, shortUrl: null };
      },
      async cancelSubscription() {
        /* nothing to cancel remotely in mock mode */
      },
    };
  }
  const auth = `Basic ${Buffer.from(`${config.RAZORPAY_KEY_ID}:${config.RAZORPAY_KEY_SECRET}`).toString('base64')}`;
  const base = config.RAZORPAY_BASE_URL.replace(/\/$/, '');

  async function call(method: 'POST', path: string, body: Record<string, unknown>): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new HttpError(502, 'billing_unavailable', 'Could not reach Razorpay. Please try again.');
    }
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(502, 'billing_provider_error', json?.error?.description ?? `Razorpay returned ${res.status}`);
    return json;
  }

  return {
    mode: 'live',
    keyId: config.RAZORPAY_KEY_ID!,
    async createSubscription({ planId, totalCount, notes }) {
      const j = await call('POST', '/v1/subscriptions', { plan_id: planId, total_count: totalCount, quantity: 1, customer_notify: 1, notes });
      return { id: String(j.id), shortUrl: j.short_url ?? null };
    },
    async cancelSubscription(subscriptionId, atCycleEnd) {
      await call('POST', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, { cancel_at_cycle_end: atCycleEnd ? 1 : 0 });
    },
  };
}
