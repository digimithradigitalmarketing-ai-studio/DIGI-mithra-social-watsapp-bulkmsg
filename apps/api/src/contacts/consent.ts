import type { Queryable } from '../db';
import { writeAudit } from '../lib/audit';

export interface ConsentRecord {
  businessId: string;
  contactId: string;
  purpose: 'marketing' | 'utility' | 'service';
  status: 'granted' | 'revoked';
  source: string;
  evidence?: Record<string, unknown>;
  capturedBy?: string | null;
}

/** Append a consent record. The DB trigger updates the cached flags on contacts. */
export async function recordConsent(tx: Queryable, c: ConsentRecord): Promise<void> {
  await tx.query(
    `insert into public.contact_consents (business_id, contact_id, channel, purpose, status, source, evidence, captured_by)
     values ($1, $2, 'whatsapp', $3, $4, $5, $6, $7)`,
    [c.businessId, c.contactId, c.purpose, c.status, c.source, JSON.stringify(c.evidence ?? {}), c.capturedBy ?? null],
  );
}

/** Opt a contact out of all broadcasts: revoke marketing consent and add to the tenant suppression list. Service context. */
export async function optOut(tx: Queryable, o: { businessId: string; contactId: string; phone: string; source: string; reason: 'stop_keyword' | 'opt_out' | 'manual'; evidence?: Record<string, unknown>; actorUserId?: string | null }) {
  await recordConsent(tx, { businessId: o.businessId, contactId: o.contactId, purpose: 'marketing', status: 'revoked', source: o.source, evidence: o.evidence, capturedBy: o.actorUserId });
  await tx.query(`update public.contacts set opted_out_at = coalesce(opted_out_at, now()) where id = $1`, [o.contactId]);
  await tx.query(
    `insert into public.suppression_lists (business_id, phone_e164, reason, source, created_by) values ($1, $2, $3, $4, $5)
     on conflict do nothing`,
    [o.businessId, o.phone, o.reason, o.source, o.actorUserId ?? null],
  );
  await writeAudit(tx, { businessId: o.businessId, actorUserId: o.actorUserId ?? null, actorType: o.actorUserId ? 'user' : 'system', action: 'contact.opted_out', targetType: 'contact', targetId: o.contactId, metadata: { source: o.source } });
}

/** Re-subscribe (e.g. customer sends START). Removes the tenant-level suppression entry; global suppression is untouched. */
export async function optIn(tx: Queryable, o: { businessId: string; contactId: string; phone: string; source: string; evidence?: Record<string, unknown> }) {
  await tx.query(`delete from public.suppression_lists where business_id = $1 and phone_e164 = $2 and reason in ('stop_keyword', 'opt_out')`, [o.businessId, o.phone]);
  await recordConsent(tx, { businessId: o.businessId, contactId: o.contactId, purpose: 'marketing', status: 'granted', source: o.source, evidence: o.evidence });
  await writeAudit(tx, { businessId: o.businessId, actorType: 'system', action: 'contact.opted_in', targetType: 'contact', targetId: o.contactId, metadata: { source: o.source } });
}
