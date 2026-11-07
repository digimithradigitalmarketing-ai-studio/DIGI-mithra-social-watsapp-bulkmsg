/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from 'node:crypto';
import { Router } from 'express';
import { createIntegrationKeySchema, leadIntakeSchema, normalizeIndianPhone, type CreatedIntegrationKeyDto, type IntegrationKeyDto, type IntegrationsDto } from '@socialpilot/shared';
import type { Deps } from '../deps';
import { withService } from '../db/context';
import { HttpError, notFound } from '../lib/errors';
import { clientInfo, iso, isUuid, parse } from '../lib/http';
import { writeAudit } from '../lib/audit';
import { decryptSecret, encryptSecret, randomToken, safeEqual } from '../lib/crypto';
import { recordConsent } from '../contacts/consent';
import { emitSafe } from '../automation/emit';
import { contactLimit } from './contacts';
import { currentMembership, currentUser, requireAuth, requireMembership, requirePermission } from '../middleware/auth';

/** Signed requests are accepted for five minutes either side of the server clock. */
const MAX_SKEW_SECONDS = 300;

const mapKey = (r: any): IntegrationKeyDto => ({
  id: r.id, name: r.name, kind: r.kind, keyId: r.key_id, lastFour: r.last_four,
  lastUsedAt: iso(r.last_used_at), revokedAt: iso(r.revoked_at), createdAt: iso(r.created_at)!,
});

/**
 * Integrations: signed lead intake for external enquiry forms (Google Forms via Apps Script).
 *
 * Management (owner, api_keys.manage):
 *   GET  /v1/businesses/:businessId/integrations
 *   POST /v1/businesses/:businessId/integrations/keys            → returns the secret once
 *   POST /v1/businesses/:businessId/integrations/keys/:id/revoke
 *
 * Intake (no session; signed):
 *   POST /v1/integrations/lead-intake
 *     X-DM-Key-Id:     public key id (dmk_…)
 *     X-DM-Timestamp:  unix seconds, within ±5 minutes
 *     X-DM-Signature:  hex HMAC-SHA256(secret, `${timestamp}.${raw body}`)
 */
export function integrationsRouter(deps: Deps): Router {
  const r = Router();
  const guard = [requireAuth(deps), requireMembership(deps)];
  const intakeUrl = `${deps.config.PUBLIC_API_URL.replace(/\/$/, '')}/v1/integrations/lead-intake`;
  const encryptionKey = () => {
    if (!deps.config.INTEGRATION_ENCRYPTION_KEY) throw new HttpError(503, 'encryption_not_configured', 'INTEGRATION_ENCRYPTION_KEY is not configured');
    return deps.config.INTEGRATION_ENCRYPTION_KEY;
  };

  r.get('/businesses/:businessId/integrations', ...guard, requirePermission('api_keys.manage'), async (req, res) => {
    const m = currentMembership(req);
    const rows = await deps.db.query<any>('select * from public.integration_keys where business_id = $1 order by created_at desc', [m.businessId]);
    const data: IntegrationsDto = { intakeUrl, keys: rows.rows.map(mapKey) };
    res.json({ data });
  });

  r.post('/businesses/:businessId/integrations/keys', ...guard, requirePermission('api_keys.manage'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const input = parse(createIntegrationKeySchema, req.body);
    const keyId = `dmk_${randomToken(9)}`;
    const secret = randomToken(32);
    const box = encryptSecret(secret, encryptionKey());
    const row = await withService(deps.db, async (tx) => {
      const ins = await tx.query<any>(
        `insert into public.integration_keys (business_id, name, key_id, secret_ciphertext, secret_iv, secret_auth_tag, key_version, last_four, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
        [m.businessId, input.name, keyId, box.ciphertext, box.iv, box.authTag, box.keyVersion, box.lastFour, user.sub],
      );
      await writeAudit(tx, { businessId: m.businessId, actorUserId: user.sub, action: 'integration.key_created', targetType: 'integration_key', targetId: ins.rows[0].id, metadata: { keyId }, ...clientInfo(req) });
      return ins.rows[0];
    });
    const data: CreatedIntegrationKeyDto = { ...mapKey(row), secret };
    res.status(201).json({ data });
  });

  r.post('/businesses/:businessId/integrations/keys/:keyId/revoke', ...guard, requirePermission('api_keys.manage'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const id = String(req.params.keyId);
    if (!isUuid(id)) throw notFound('Key not found');
    const row = await withService(deps.db, async (tx) => {
      const u = await tx.query<any>(
        `update public.integration_keys set revoked_at = coalesce(revoked_at, now()) where id = $1 and business_id = $2 returning *`,
        [id, m.businessId],
      );
      if (!u.rows[0]) throw notFound('Key not found');
      await writeAudit(tx, { businessId: m.businessId, actorUserId: user.sub, action: 'integration.key_revoked', targetType: 'integration_key', targetId: id, ...clientInfo(req) });
      return u.rows[0];
    });
    res.json({ data: mapKey(row) });
  });

  // ---- signed lead intake (no session) -------------------------------------------------
  r.post('/integrations/lead-intake', async (req, res) => {
    const raw: Buffer | undefined = (req as unknown as { rawBody?: Buffer }).rawBody;
    const keyId = req.get('x-dm-key-id');
    const ts = req.get('x-dm-timestamp');
    const sig = req.get('x-dm-signature');
    const reject = (code: string, message: string) => {
      deps.logger.warn({ ip: req.ip, code }, 'rejected lead intake');
      throw new HttpError(401, code, message);
    };
    if (!raw || !keyId || !ts || !sig) reject('invalid_signature', 'Missing signature headers');
    const keyRow = (await deps.db.query<any>('select * from public.integration_keys where key_id = $1', [keyId!])).rows[0];
    if (!keyRow || keyRow.revoked_at) reject('invalid_key', 'Invalid or revoked integration key');
    const secret = decryptSecret({ ciphertext: keyRow.secret_ciphertext, iv: keyRow.secret_iv, authTag: keyRow.secret_auth_tag }, encryptionKey());
    const t = Number(ts);
    if (!Number.isFinite(t) || Math.abs(Math.floor(Date.now() / 1000) - t) > MAX_SKEW_SECONDS) reject('stale_request', 'Request timestamp is outside the allowed window');
    const expected = crypto.createHmac('sha256', secret).update(`${ts}.`).update(raw!).digest('hex');
    if (!safeEqual(expected, sig!)) reject('invalid_signature', 'Invalid signature');

    const input = parse(leadIntakeSchema, req.body);
    const phone = normalizeIndianPhone(input.phone);
    if (!phone) throw new HttpError(422, 'validation_failed', 'Enter a valid phone number', { fields: { phone: 'Enter a valid phone number' } });
    if (input.consentMarketing && !input.consentText)
      throw new HttpError(422, 'validation_failed', 'Consent text is required', { fields: { consentText: 'Send the exact consent wording shown on the form' } });

    const businessId: string = keyRow.business_id;
    const result = await withService(deps.db, async (tx) => {
      // Idempotency: the same externalId for the same workspace is stored once. Personal data is not stored in the event payload.
      const ev = await tx.query<{ id: string }>(
        `insert into public.webhook_events (provider, event_id, business_id, signature_valid, payload)
         values ('google_forms', $1, $2, true, $3) on conflict (provider, event_id) do nothing returning id`,
        [`${businessId}:${input.externalId}`, businessId, JSON.stringify({ externalId: input.externalId, formKey: input.formKey ?? null })],
      );
      if (!ev.rows[0]) return { duplicate: true as const };

      const existing = (await tx.query<any>('select id, opted_out_at from public.contacts where business_id = $1 and phone_e164 = $2', [businessId, phone])).rows[0];
      let contactId: string;
      let created = false;
      if (existing) {
        contactId = existing.id;
      } else {
        const lim = await contactLimit(tx, businessId);
        if (lim.limit !== null && lim.used >= lim.limit) throw new HttpError(402, 'contact_limit_reached', 'The workspace has reached its contact limit');
        const c = await tx.query<{ id: string }>(
          `insert into public.contacts (business_id, name, phone_e164, email, language, custom_fields, source)
           values ($1, $2, $3, $4, $5, '{}'::jsonb, 'lead_form') returning id`,
          [businessId, input.name, phone, input.email ?? null, input.language ?? 'en'],
        );
        contactId = c.rows[0]!.id;
        created = true;
      }
      // Marketing consent only when the customer ticked the exact wording; never over an opt-out.
      if (input.consentMarketing && !existing?.opted_out_at)
        await recordConsent(tx, {
          businessId, contactId, purpose: 'marketing', status: 'granted', source: 'lead_form',
          evidence: { method: 'signed_form', formKey: input.formKey ?? null, externalId: input.externalId, consentText: input.consentText },
        });

      const stage = (await tx.query<any>(
        `select s.id, s.pipeline_id, s.is_won, s.is_lost from public.lead_stages s join public.lead_pipelines p on p.id = s.pipeline_id
         where s.business_id = $1 order by p.is_default desc, s.position limit 1`, [businessId])).rows[0];
      const lead = await tx.query<{ id: string }>(
        `insert into public.leads (business_id, contact_id, pipeline_id, stage_id, title, source, status, notes)
         values ($1, $2, $3, $4, $5, 'enquiry_form', $6, $7) returning id`,
        [businessId, contactId, stage?.pipeline_id ?? null, stage?.id ?? null, input.interest || 'Website enquiry',
         stage?.is_won ? 'won' : stage?.is_lost ? 'lost' : 'open', input.message ?? null],
      );
      const leadId = lead.rows[0]!.id;
      if (stage) await tx.query(`insert into public.lead_stage_events (business_id, lead_id, to_stage_id, changed_by) values ($1, $2, $3, null)`, [businessId, leadId, stage.id]);
      await tx.query('update public.webhook_events set status = $2, processed_at = now() where id = $1', [ev.rows[0].id, 'processed']);
      await tx.query('update public.integration_keys set last_used_at = now() where id = $1', [keyRow.id]);
      await writeAudit(tx, { businessId, actorType: 'integration', action: 'lead.intake_received', targetType: 'contact', targetId: contactId, metadata: { leadId, created, formKey: input.formKey ?? null } });
      return { duplicate: false as const, contactId, leadId, created };
    });

    if (result.duplicate) return res.status(200).json({ data: { duplicate: true } });
    await emitSafe(deps, [
      ...(result.created ? [{ businessId, type: 'contact_created' as const, contactId: result.contactId, eventId: result.contactId, data: { source: 'lead_form' } }] : []),
      { businessId, type: 'enquiry_submitted' as const, contactId: result.contactId, eventId: result.leadId, data: { formKey: input.formKey, leadId: result.leadId, source: 'enquiry_form' } },
    ]);
    res.status(202).json({ data: { duplicate: false, contactId: result.contactId, leadId: result.leadId, contactCreated: result.created } });
  });

  return r;
}
