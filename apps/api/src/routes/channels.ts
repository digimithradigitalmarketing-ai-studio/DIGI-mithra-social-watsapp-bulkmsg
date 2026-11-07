import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { connectWhatsAppSchema, normalizeIndianPhone, type ChannelDto } from '@socialpilot/shared';
import type { Deps } from '../deps';
import { withService, withUser } from '../db/context';
import { HttpError, conflict, notFound } from '../lib/errors';
import { clientInfo, iso, parse } from '../lib/http';
import { writeAudit } from '../lib/audit';
import { encryptSecret } from '../lib/crypto';
import { createMetaClient, loadChannel } from '../whatsapp/provider';
import { ProviderError } from '../whatsapp/errors';
import { mockInboundPayload, processMetaPayload } from '../whatsapp/webhook';
import { currentMembership, currentUser, requireAuth, requireMembership, requirePermission } from '../middleware/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function channelsRouter(deps: Deps): Router {
  const r = Router();
  const base = '/businesses/:businessId/channels/whatsapp';
  const guard = [requireAuth(deps), requireMembership(deps)];

  async function getDto(businessId: string, tx: any): Promise<ChannelDto | null> {
    const c = await tx.query(
      `select c.*, a.waba_id from public.connected_channels c join public.whatsapp_accounts a on a.channel_id = c.id
       where c.business_id = $1 and c.channel = 'whatsapp' order by c.created_at desc limit 1`,
      [businessId],
    );
    const ch = c.rows[0];
    if (!ch) return null;
    const phones = await tx.query(
      `select p.* from public.whatsapp_phone_numbers p join public.whatsapp_accounts a on a.id = p.whatsapp_account_id where a.channel_id = $1 order by p.created_at`,
      [ch.id],
    );
    return {
      id: ch.id, mode: ch.provider === 'mock' ? 'mock' : 'meta', status: ch.status, name: ch.name, wabaId: ch.waba_id, lastError: ch.last_error,
      connectedAt: iso(ch.connected_at), tokenLastFour: null,
      phoneNumbers: phones.rows.map((p: any) => ({
        id: p.id, phoneNumberId: p.phone_number_id, displayPhoneNumber: p.display_phone_number, verifiedName: p.verified_name,
        qualityRating: p.quality_rating, messagingLimitTier: p.messaging_limit_tier, status: p.status,
      })),
      webhook: { callbackUrl: `${deps.config.PUBLIC_API_URL}/v1/webhooks/meta`, verifyTokenConfigured: !!deps.config.META_WEBHOOK_VERIFY_TOKEN, appSecretConfigured: !!deps.config.META_APP_SECRET },
    };
  }

  /** integration_credentials is not readable under RLS, so the token hint comes from a separate service query. */
  async function withTokenHint(businessId: string, dto: ChannelDto | null) {
    if (!dto) return dto;
    const cred = await deps.db.query<{ last_four: string }>(
      `select last_four from public.integration_credentials where business_id = $1 and provider = 'meta_whatsapp' and label = 'system_user_token'`, [businessId]);
    return { ...dto, tokenLastFour: cred.rows[0]?.last_four ?? null };
  }

  r.get(base, ...guard, async (req, res) => {
    const m = currentMembership(req);
    const data = await withTokenHint(m.businessId, await withUser(deps.db, currentUser(req), (tx) => getDto(m.businessId, tx)));
    res.json({ data, meta: { mockAllowed: deps.config.ALLOW_MOCK_WHATSAPP } });
  });

  r.post(base, ...guard, requirePermission('channels.manage'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const input = parse(connectWhatsAppSchema, req.body);
    const existing = await loadChannel(deps.db, m.businessId);
    if (existing) throw conflict('A WhatsApp number is already connected. Disconnect it first.', 'already_connected');

    if (input.mode === 'mock') {
      if (!deps.config.ALLOW_MOCK_WHATSAPP) throw new HttpError(403, 'mock_disabled', 'Mock connections are disabled in this environment');
      const b = await deps.db.query<{ name: string; phone: string | null }>('select name, phone from public.businesses where id = $1', [m.businessId]);
      const display = (input.displayPhoneNumber && normalizeIndianPhone(input.displayPhoneNumber)) || b.rows[0]?.phone || '+910000000000';
      await withService(deps.db, async (tx) => {
        const ch = await tx.query<{ id: string }>(
          `insert into public.connected_channels (business_id, channel, provider, name, status, connected_at, connected_by)
           values ($1, 'whatsapp', 'mock', 'WhatsApp (mock test connection)', 'connected', now(), $2) returning id`, [m.businessId, user.sub]);
        const acc = await tx.query<{ id: string }>(
          `insert into public.whatsapp_accounts (business_id, channel_id, waba_id, name) values ($1, $2, $3, $4) returning id`,
          [m.businessId, ch.rows[0]!.id, `mock-waba-${crypto.randomBytes(4).toString('hex')}`, `${b.rows[0]?.name} (mock)`]);
        await tx.query(
          `insert into public.whatsapp_phone_numbers (business_id, whatsapp_account_id, phone_number_id, display_phone_number, verified_name, quality_rating, messaging_limit_tier, status, is_default)
           values ($1, $2, $3, $4, $5, 'GREEN', 'TIER_1K', 'connected', true)`,
          [m.businessId, acc.rows[0]!.id, `mock-${crypto.randomUUID()}`, display, b.rows[0]?.name]);
        await writeAudit(tx, { businessId: m.businessId, actorUserId: user.sub, action: 'channel.connected', targetType: 'connected_channel', targetId: ch.rows[0]!.id, metadata: { mode: 'mock' }, ...clientInfo(req) });
      });
    } else {
      if (!deps.config.INTEGRATION_ENCRYPTION_KEY) throw new HttpError(503, 'encryption_not_configured', 'Server encryption key is not configured');
      const client = createMetaClient(deps.config, input.accessToken);
      let phone, waba;
      try {
        phone = await client.getPhoneNumber(input.phoneNumberId);
        waba = await client.getWaba(input.wabaId);
        await client.subscribeApp(input.wabaId);
      } catch (err) {
        if (err instanceof ProviderError) throw new HttpError(400, 'meta_rejected', `Meta rejected the connection: ${err.message}`, { metaCode: err.code });
        throw err;
      }
      const box = encryptSecret(input.accessToken, deps.config.INTEGRATION_ENCRYPTION_KEY);
      await withService(deps.db, async (tx) => {
        const taken = await tx.query('select 1 from public.whatsapp_phone_numbers where phone_number_id = $1', [input.phoneNumberId]);
        if (taken.rows.length) throw conflict('This phone number is already connected to another workspace', 'phone_in_use');
        const ch = await tx.query<{ id: string }>(
          `insert into public.connected_channels (business_id, channel, provider, name, status, external_id, connected_at, connected_by)
           values ($1, 'whatsapp', 'meta_cloud', $2, 'connected', $3, now(), $4) returning id`,
          [m.businessId, waba.name ?? 'WhatsApp Business', input.wabaId, user.sub]);
        const acc = await tx.query<{ id: string }>(
          `insert into public.whatsapp_accounts (business_id, channel_id, waba_id, name, currency, timezone_id, message_template_namespace)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [m.businessId, ch.rows[0]!.id, input.wabaId, waba.name ?? null, waba.currency ?? null, waba.timezone_id ?? null, waba.message_template_namespace ?? null]);
        await tx.query(
          `insert into public.whatsapp_phone_numbers (business_id, whatsapp_account_id, phone_number_id, display_phone_number, verified_name, quality_rating, messaging_limit_tier, status, is_default)
           values ($1, $2, $3, $4, $5, $6, $7, 'connected', true)`,
          [m.businessId, acc.rows[0]!.id, input.phoneNumberId, phone.display_phone_number, phone.verified_name ?? null, phone.quality_rating ?? null, phone.messaging_limit_tier ?? null]);
        await tx.query(
          `insert into public.integration_credentials (business_id, provider, label, ciphertext, iv, auth_tag, key_version, last_four, created_by)
           values ($1, 'meta_whatsapp', 'system_user_token', $2, $3, $4, $5, $6, $7)
           on conflict (business_id, provider, label) do update set ciphertext = excluded.ciphertext, iv = excluded.iv, auth_tag = excluded.auth_tag,
             key_version = excluded.key_version, last_four = excluded.last_four, rotated_at = now()`,
          [m.businessId, box.ciphertext, box.iv, box.authTag, box.keyVersion, box.lastFour, user.sub]);
        await writeAudit(tx, { businessId: m.businessId, actorUserId: user.sub, action: 'channel.connected', targetType: 'connected_channel', targetId: ch.rows[0]!.id, metadata: { mode: 'meta', wabaId: input.wabaId, phoneNumberId: input.phoneNumberId }, ...clientInfo(req) });
      });
    }
    const data = await withTokenHint(m.businessId, await withUser(deps.db, user, (tx) => getDto(m.businessId, tx)));
    res.status(201).json({ data });
  });

  r.delete(base, ...guard, requirePermission('channels.manage'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    await withService(deps.db, async (tx) => {
      const ch = await tx.query<{ id: string }>(`select id from public.connected_channels where business_id = $1 and channel = 'whatsapp'`, [m.businessId]);
      if (!ch.rows.length) throw notFound('No WhatsApp connection');
      const active = await tx.query(`select 1 from public.campaigns where business_id = $1 and status in ('scheduled', 'processing')`, [m.businessId]);
      if (active.rows.length) throw conflict('Pause or cancel running and scheduled campaigns before disconnecting', 'campaigns_active');
      await tx.query(`delete from public.connected_channels where business_id = $1 and channel = 'whatsapp'`, [m.businessId]);
      await tx.query(`delete from public.integration_credentials where business_id = $1 and provider = 'meta_whatsapp'`, [m.businessId]);
      await writeAudit(tx, { businessId: m.businessId, actorUserId: user.sub, action: 'channel.disconnected', targetType: 'connected_channel', targetId: ch.rows[0]!.id, ...clientInfo(req) });
    });
    res.status(204).end();
  });

  /** Development tool: simulate a customer message on a MOCK connection (goes through the real webhook processor). */
  r.post(`${base}/mock/inbound`, ...guard, requirePermission('conversations.reply'), async (req, res) => {
    const m = currentMembership(req);
    const input = parse(z.object({ phone: z.string().trim().min(5), name: z.string().trim().max(80).default(''), text: z.string().trim().min(1).max(1000) }), req.body);
    const channel = await loadChannel(deps.db, m.businessId);
    if (!channel || channel.provider !== 'mock') throw new HttpError(409, 'not_mock', 'Customer simulation is only available on a mock connection');
    const phone = normalizeIndianPhone(input.phone);
    if (!phone) throw new HttpError(422, 'validation_failed', 'Invalid phone', { fields: { phone: 'Invalid phone number' } });
    const result = await deps.db.transaction((tx) => processMetaPayload(tx, mockInboundPayload(channel.phone.phoneNumberId, phone, input.name, input.text)));
    res.status(201).json({ data: result });
  });

  return r;
}
