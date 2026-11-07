import crypto from 'node:crypto';
import type { AppConfig } from '../config';
import type { Queryable } from '../db';
import { decryptSecret } from '../lib/crypto';
import { HttpError } from '../lib/errors';
import { ProviderError, classifyMetaError } from './errors';

export interface SendTemplateInput {
  phoneNumberId: string;
  to: string; // E.164 with +
  templateName: string;
  language: string;
  bodyParams: string[];
}

export interface TemplateSubmission {
  name: string;
  language: string;
  category: string;
  components: unknown[];
}

export interface RemoteTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  rejected_reason?: string;
}

export interface WhatsAppProvider {
  readonly kind: 'meta_cloud' | 'mock';
  sendTemplate(input: SendTemplateInput): Promise<{ providerMessageId: string }>;
  /** Free-form text; only allowed inside the 24-hour customer service window. */
  sendText(input: { phoneNumberId: string; to: string; body: string }): Promise<{ providerMessageId: string }>;
  submitTemplate(wabaId: string, t: TemplateSubmission): Promise<{ id: string; status: string }>;
  listTemplates(wabaId: string): Promise<RemoteTemplate[]>;
}

// ---------------------------------------------------------------------------
// Meta WhatsApp Cloud API (official Graph API). Not yet verified against a live
// WABA: requires a real WABA, phone number ID and system-user token.
// ---------------------------------------------------------------------------
export function createMetaClient(config: Pick<AppConfig, 'META_GRAPH_BASE_URL' | 'META_GRAPH_API_VERSION'>, token: string) {
  const base = `${config.META_GRAPH_BASE_URL.replace(/\/$/, '')}/${config.META_GRAPH_API_VERSION}`;
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new ProviderError(`Network error calling Meta: ${(err as Error).message}`, 'network', true);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw classifyMetaError(res.status, json);
    return json as T;
  }
  return {
    call,
    getPhoneNumber: (id: string) =>
      call<{ id: string; display_phone_number: string; verified_name?: string; quality_rating?: string; messaging_limit_tier?: string }>(
        'GET', `/${id}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier`),
    getWaba: (id: string) => call<{ id: string; name?: string; currency?: string; timezone_id?: string; message_template_namespace?: string }>(
      'GET', `/${id}?fields=name,currency,timezone_id,message_template_namespace`),
    /** Subscribe our app to this WABA's webhooks. */
    subscribeApp: (wabaId: string) => call<{ success: boolean }>('POST', `/${wabaId}/subscribed_apps`),
  };
}

export function createMetaProvider(config: AppConfig, token: string): WhatsAppProvider {
  const client = createMetaClient(config, token);
  return {
    kind: 'meta_cloud',
    async sendTemplate(i) {
      const body = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: i.to.replace(/^\+/, ''),
        type: 'template',
        template: {
          name: i.templateName,
          language: { code: i.language },
          ...(i.bodyParams.length ? { components: [{ type: 'body', parameters: i.bodyParams.map((text) => ({ type: 'text', text })) }] } : {}),
        },
      };
      const r = await client.call<{ messages?: Array<{ id: string }> }>('POST', `/${i.phoneNumberId}/messages`, body);
      const id = r.messages?.[0]?.id;
      if (!id) throw new ProviderError('Meta did not return a message id', 'no_message_id', true);
      return { providerMessageId: id };
    },
    async sendText(i) {
      const r = await client.call<{ messages?: Array<{ id: string }> }>('POST', `/${i.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp', recipient_type: 'individual', to: i.to.replace(/^\+/, ''), type: 'text', text: { body: i.body, preview_url: false },
      });
      const id = r.messages?.[0]?.id;
      if (!id) throw new ProviderError('Meta did not return a message id', 'no_message_id', true);
      return { providerMessageId: id };
    },
    async submitTemplate(wabaId, t) {
      return client.call<{ id: string; status: string }>('POST', `/${wabaId}/message_templates`, t);
    },
    async listTemplates(wabaId) {
      const r = await client.call<{ data: RemoteTemplate[] }>('GET', `/${wabaId}/message_templates?fields=id,name,language,status,category,rejected_reason&limit=200`);
      return r.data;
    },
  };
}

// ---------------------------------------------------------------------------
// Mock provider — development/testing only. Sends nothing. Delivery receipts are
// simulated by the worker through the real webhook-processing code path.
// Deterministic test numbers (last 4 digits):
//   0000 -> permanent failure 131026 (undeliverable)
//   9999 -> retryable 130429 on every attempt (exercises backoff + dead-letter)
//   1050 -> 131050 user stopped marketing messages (auto opt-out)
//   5050 -> accepted, then a 'failed' status webhook (131049)
// ---------------------------------------------------------------------------
export function createMockProvider(): WhatsAppProvider {
  return {
    kind: 'mock',
    async sendTemplate(i) {
      if (i.to.endsWith('0000')) throw new ProviderError('(mock) Message undeliverable', '131026', false);
      if (i.to.endsWith('9999')) throw new ProviderError('(mock) Rate limit hit', '130429', true, 1);
      if (i.to.endsWith('1050')) throw new ProviderError('(mock) Recipient stopped marketing messages', '131050', false, undefined, 'opt_out');
      return { providerMessageId: `wamid.MOCK${crypto.randomBytes(12).toString('hex').toUpperCase()}` };
    },
    async sendText(i) {
      if (i.to.endsWith('0000')) throw new ProviderError('(mock) Message undeliverable', '131026', false);
      if (i.to.endsWith('9999')) throw new ProviderError('(mock) Rate limit hit', '130429', true, 1);
      return { providerMessageId: `wamid.MOCKT${crypto.randomBytes(12).toString('hex').toUpperCase()}` };
    },
    async submitTemplate() {
      return { id: `mock-tpl-${crypto.randomBytes(6).toString('hex')}`, status: 'PENDING' };
    },
    async listTemplates() {
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// Resolve the connected channel for a business
// ---------------------------------------------------------------------------
export interface ConnectedChannel {
  channelId: string;
  provider: 'meta_cloud' | 'mock';
  status: string;
  wabaId: string;
  phone: { id: string; phoneNumberId: string; displayPhoneNumber: string; messagingLimitTier: string | null; status: string };
}

export async function loadChannel(db: Queryable, businessId: string): Promise<ConnectedChannel | null> {
  const r = await db.query<{
    channel_id: string; provider: 'meta_cloud' | 'mock'; status: string; waba_id: string;
    phone_id: string; phone_number_id: string; display_phone_number: string; messaging_limit_tier: string | null; phone_status: string;
  }>(
    `select c.id as channel_id, c.provider, c.status, a.waba_id,
            p.id as phone_id, p.phone_number_id, p.display_phone_number, p.messaging_limit_tier, p.status as phone_status
     from public.connected_channels c
     join public.whatsapp_accounts a on a.channel_id = c.id
     join public.whatsapp_phone_numbers p on p.whatsapp_account_id = a.id
     where c.business_id = $1 and c.channel = 'whatsapp' and c.status <> 'disconnected'
     order by p.is_default desc, p.created_at limit 1`,
    [businessId],
  );
  const x = r.rows[0];
  if (!x) return null;
  return {
    channelId: x.channel_id, provider: x.provider, status: x.status, wabaId: x.waba_id,
    phone: { id: x.phone_id, phoneNumberId: x.phone_number_id, displayPhoneNumber: x.display_phone_number, messagingLimitTier: x.messaging_limit_tier, status: x.phone_status },
  };
}

/** Service-only: decrypts the stored token. Never call with a user (RLS) connection or return the result to clients. */
export async function providerFor(db: Queryable, config: AppConfig, businessId: string, channel: ConnectedChannel): Promise<WhatsAppProvider> {
  if (channel.provider === 'mock') {
    if (!config.ALLOW_MOCK_WHATSAPP) throw new HttpError(409, 'mock_disabled', 'The mock WhatsApp provider is disabled in this environment');
    return createMockProvider();
  }
  const cred = await db.query<{ ciphertext: string; iv: string; auth_tag: string }>(
    `select ciphertext, iv, auth_tag from public.integration_credentials where business_id = $1 and provider = 'meta_whatsapp' and label = 'system_user_token'`,
    [businessId],
  );
  if (!cred.rows[0] || !config.INTEGRATION_ENCRYPTION_KEY) throw new ProviderError('WhatsApp access token missing', 'no_token', false, undefined, 'channel_auth');
  const token = decryptSecret({ ciphertext: cred.rows[0].ciphertext, iv: cred.rows[0].iv, authTag: cred.rows[0].auth_tag }, config.INTEGRATION_ENCRYPTION_KEY);
  return createMetaProvider(config, token);
}

/** Meta messaging limit tiers -> unique business-initiated recipients per rolling 24h. */
export function tierCapacity(tier: string | null): number | null {
  switch (tier) {
    case 'TIER_50': return 50;
    case 'TIER_250': return 250;
    case 'TIER_1K': return 1000;
    case 'TIER_2K': return 2000;
    case 'TIER_10K': return 10_000;
    case 'TIER_100K': return 100_000;
    case 'TIER_UNLIMITED': return null;
    default: return tier ? null : 250; // unknown/new numbers: be conservative
  }
}
