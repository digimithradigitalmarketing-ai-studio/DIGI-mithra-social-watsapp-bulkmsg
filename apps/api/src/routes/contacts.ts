import { Router } from 'express';
import {
  bulkTagSchema, consentCaptureSchema, contactImportSchema, contactListQuerySchema, createContactSchema, normalizeIndianPhone, tagSchema,
  updateContactSchema, type ConsentRecordDto, type ContactDto, type ImportResultDto, type TagDto, type TimelineMessageDto,
} from '@socialpilot/shared';
import type { Deps } from '../deps';
import type { Queryable } from '../db';
import { withService, withUser } from '../db/context';
import { HttpError, conflict, notFound } from '../lib/errors';
import { clientInfo, iso, isUuid, parse } from '../lib/http';
import { writeAudit } from '../lib/audit';
import { parseCsv, toCsv } from '../lib/csv';
import { optOut, recordConsent } from '../contacts/consent';
import { emitSafe } from '../automation/emit';
import type { AutomationEvent } from '../automation/engine';
import { currentMembership, currentUser, requireAuth, requireMembership, requirePermission } from '../middleware/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */
const CONTACT_COLUMNS = `c.*, coalesce((select json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) order by t.name)
  from public.contact_tags ct join public.tags t on t.id = ct.tag_id where ct.contact_id = c.id), '[]'::json) as tag_list`;

export function mapContact(c: any): ContactDto {
  return {
    id: c.id, name: c.name, phone: c.phone_e164, email: c.email, language: c.language,
    birthday: c.birthday ? (c.birthday instanceof Date ? c.birthday.toISOString().slice(0, 10) : String(c.birthday).slice(0, 10)) : null,
    source: c.source, customFields: c.custom_fields ?? {}, tags: c.tag_list ?? [],
    marketingOptIn: c.marketing_opt_in, marketingConsentAt: iso(c.marketing_consent_at), marketingConsentSource: c.marketing_consent_source,
    utilityOptIn: c.utility_opt_in, optedOutAt: iso(c.opted_out_at), lastContactedAt: iso(c.last_contacted_at), archivedAt: iso(c.archived_at), createdAt: iso(c.created_at)!,
  };
}

export async function contactLimit(db: Queryable, businessId: string) {
  const r = await db.query<{ lim: number | null; used: number }>(
    `select (select limit_value from public.subscription_entitlements where business_id = $1 and key = 'contacts') as lim,
            (select count(*)::int from public.contacts where business_id = $1 and archived_at is null) as used`,
    [businessId],
  );
  return { limit: r.rows[0]?.lim == null ? null : Number(r.rows[0].lim), used: r.rows[0]?.used ?? 0 };
}

/** Adds tags; returns the newly created links (for tag_added automations). */
async function setTags(tx: Queryable, businessId: string, contactId: string, tagIds: string[]) {
  const added: Array<{ id: string; tagId: string }> = [];
  for (const tagId of tagIds) {
    const r = await tx.query<{ id: string }>(`insert into public.contact_tags (business_id, contact_id, tag_id) values ($1, $2, $3) on conflict do nothing returning id`, [businessId, contactId, tagId]);
    if (r.rows[0]) added.push({ id: r.rows[0].id, tagId });
  }
  return added;
}

const tagEvents = (businessId: string, contactId: string, links: Array<{ id: string; tagId: string }>): AutomationEvent[] =>
  links.map((l) => ({ businessId, type: 'tag_added', contactId, eventId: l.id, data: { tagId: l.tagId } }));

export function contactsRouter(deps: Deps): Router {
  const r = Router();
  const base = '/businesses/:businessId';
  const guard = [requireAuth(deps), requireMembership(deps)];

  // ---- list / search ---------------------------------------------------------
  r.get(`${base}/contacts`, ...guard, requirePermission('contacts.read'), async (req, res) => {
    const m = currentMembership(req);
    const q = parse(contactListQuerySchema, req.query);
    const where = ['c.business_id = $1', q.archived === 'true' ? 'c.archived_at is not null' : 'c.archived_at is null'];
    const params: unknown[] = [m.businessId];
    if (q.q) {
      params.push(`%${q.q.toLowerCase()}%`);
      const digits = q.q.replace(/\D/g, '');
      const like = params.length;
      let phoneClause = '';
      if (digits.length >= 3) {
        params.push(`%${digits}%`);
        phoneClause = ` or c.phone_e164 like $${params.length}`;
      }
      where.push(`(lower(c.name) like $${like} or lower(coalesce(c.email, '')) like $${like}${phoneClause})`);
    }
    if (q.tagId) {
      params.push(q.tagId);
      where.push(`exists (select 1 from public.contact_tags ct where ct.contact_id = c.id and ct.tag_id = $${params.length})`);
    }
    if (q.consent === 'marketing') where.push('c.marketing_opt_in and c.opted_out_at is null');
    if (q.consent === 'none') where.push('not c.marketing_opt_in and c.opted_out_at is null');
    if (q.consent === 'opted_out') where.push('c.opted_out_at is not null');
    const sql = where.join(' and ');
    const result = await withUser(deps.db, currentUser(req), async (tx) => {
      const total = await tx.query<{ n: number }>(`select count(*)::int as n from public.contacts c where ${sql}`, params);
      const rows = await tx.query(`select ${CONTACT_COLUMNS} from public.contacts c where ${sql} order by c.created_at desc limit $${params.length + 1} offset $${params.length + 2}`,
        [...params, q.pageSize, (q.page - 1) * q.pageSize]);
      return { total: total.rows[0]?.n ?? 0, rows: rows.rows };
    });
    const lim = await contactLimit(deps.db, m.businessId);
    res.json({ data: result.rows.map(mapContact), meta: { page: q.page, pageSize: q.pageSize, total: result.total, contactLimit: lim.limit, contactsUsed: lim.used } });
  });

  // ---- create ------------------------------------------------------------------
  r.post(`${base}/contacts`, ...guard, requirePermission('contacts.write'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const input = parse(createContactSchema, req.body);
    const lim = await contactLimit(deps.db, m.businessId);
    if (lim.limit !== null && lim.used >= lim.limit) throw new HttpError(402, 'contact_limit_reached', `Your plan allows ${lim.limit} contacts. Upgrade to add more.`);
    let links: Array<{ id: string; tagId: string }> = [];
    const contact: any = await withUser(deps.db, user, async (tx) => {
      const dup = await tx.query('select id from public.contacts where business_id = $1 and phone_e164 = $2', [m.businessId, input.phone]);
      if (dup.rows.length) throw conflict('A contact with this phone number already exists', 'duplicate_contact');
      const c = await tx.query<{ id: string }>(
        `insert into public.contacts (business_id, name, phone_e164, email, language, birthday, custom_fields, source, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, 'manual', $8) returning id`,
        [m.businessId, input.name, input.phone, input.email ?? null, input.language, input.birthday ?? null, JSON.stringify(input.customFields), user.sub]);
      const id = c.rows[0]!.id;
      links = await setTags(tx, m.businessId, id, input.tagIds);
      for (const purpose of ['marketing', 'utility'] as const)
        if (input.consent?.[purpose])
          await recordConsent(tx, { businessId: m.businessId, contactId: id, purpose, status: 'granted', source: input.consent.source, capturedBy: user.sub, evidence: { method: 'manual_entry', ...clientInfo(req) } });
      return (await tx.query(`select ${CONTACT_COLUMNS} from public.contacts c where c.id = $1`, [id])).rows[0];
    });
    await emitSafe(deps, [
      { businessId: m.businessId, type: 'contact_created', contactId: contact.id, eventId: contact.id, data: { source: 'manual' } },
      ...tagEvents(m.businessId, contact.id, links),
    ]);
    res.status(201).json({ data: mapContact(contact) });
  });

  // ---- detail ------------------------------------------------------------------
  r.get(`${base}/contacts/:contactId`, ...guard, requirePermission('contacts.read'), async (req, res) => {
    const m = currentMembership(req);
    const id = String(req.params.contactId);
    if (!isUuid(id)) throw notFound('Contact not found');
    const data = await withUser(deps.db, currentUser(req), async (tx) => {
      const c = await tx.query(`select ${CONTACT_COLUMNS} from public.contacts c where c.id = $1 and c.business_id = $2`, [id, m.businessId]);
      if (!c.rows[0]) throw notFound('Contact not found');
      const consents = await tx.query<any>(
        `select cc.*, p.full_name as captured_by_name from public.contact_consents cc left join public.profiles p on p.id = cc.captured_by
         where cc.contact_id = $1 order by cc.occurred_at desc`, [id]);
      const msgs = await tx.query<any>(
        `select m.*, cp.name as campaign_name from public.messages m left join public.campaigns cp on cp.id = m.campaign_id
         where m.contact_id = $1 order by m.created_at desc limit 50`, [id]);
      return {
        contact: mapContact(c.rows[0]),
        consents: consents.rows.map((x): ConsentRecordDto => ({ id: x.id, purpose: x.purpose, status: x.status, source: x.source, evidence: x.evidence, capturedBy: x.captured_by_name, occurredAt: iso(x.occurred_at)! })),
        messages: msgs.rows.map((x): TimelineMessageDto => ({ id: x.id, direction: x.direction, type: x.message_type, body: x.body, status: x.status, campaignName: x.campaign_name, errorCode: x.error_code, createdAt: iso(x.created_at)! })),
      };
    });
    res.json({ data });
  });

  r.patch(`${base}/contacts/:contactId`, ...guard, requirePermission('contacts.write'), async (req, res) => {
    const m = currentMembership(req);
    const id = String(req.params.contactId);
    if (!isUuid(id)) throw notFound('Contact not found');
    const input = parse(updateContactSchema, req.body);
    const cols: Record<string, string> = { name: 'name', email: 'email', language: 'language', birthday: 'birthday', customFields: 'custom_fields', assignedTo: 'assigned_to' };
    const sets: string[] = [];
    const vals: unknown[] = [id, m.businessId];
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined || !cols[k]) continue;
      vals.push(k === 'customFields' ? JSON.stringify(v) : v === '' ? null : v);
      sets.push(`${cols[k]} = $${vals.length}`);
    }
    if (!sets.length) throw new HttpError(400, 'nothing_to_update', 'Nothing to update');
    const row = await withUser(deps.db, currentUser(req), async (tx) => {
      const u = await tx.query('update public.contacts set ' + sets.join(', ') + ' where id = $1 and business_id = $2 returning id', vals);
      if (!u.rows[0]) throw notFound('Contact not found');
      return (await tx.query(`select ${CONTACT_COLUMNS} from public.contacts c where c.id = $1`, [id])).rows[0];
    });
    res.json({ data: mapContact(row) });
  });

  for (const action of ['archive', 'restore'] as const) {
    r.post(`${base}/contacts/:contactId/${action}`, ...guard, requirePermission('contacts.write'), async (req, res) => {
      const m = currentMembership(req);
      const id = String(req.params.contactId);
      if (!isUuid(id)) throw notFound('Contact not found');
      const archive = action === 'archive';
      const u = await withUser(deps.db, currentUser(req), (tx) =>
        tx.query(`update public.contacts set archived_at = ${archive ? 'now()' : 'null'} where id = $1 and business_id = $2 returning id`, [id, m.businessId]));
      if (!u.rows[0]) throw notFound('Contact not found');
      res.json({ data: { archived: archive } });
    });
  }

  // ---- consent ------------------------------------------------------------------
  r.post(`${base}/contacts/:contactId/consents`, ...guard, requirePermission('contacts.write'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const id = String(req.params.contactId);
    if (!isUuid(id)) throw notFound('Contact not found');
    const input = parse(consentCaptureSchema, req.body);
    const c = await deps.db.query<{ phone_e164: string; opted_out_at: Date | null }>('select phone_e164, opted_out_at from public.contacts where id = $1 and business_id = $2', [id, m.businessId]);
    if (!c.rows[0]) throw notFound('Contact not found');
    await withService(deps.db, async (tx) => {
      if (input.purpose === 'marketing' && input.status === 'revoked') {
        await optOut(tx, { businessId: m.businessId, contactId: id, phone: c.rows[0]!.phone_e164, source: input.source, reason: 'manual', actorUserId: user.sub, evidence: { note: input.note } });
      } else {
        if (input.purpose === 'marketing' && input.status === 'granted')
          await tx.query(`delete from public.suppression_lists where business_id = $1 and phone_e164 = $2 and reason in ('opt_out', 'stop_keyword', 'manual')`, [m.businessId, c.rows[0]!.phone_e164]);
        await recordConsent(tx, { businessId: m.businessId, contactId: id, purpose: input.purpose, status: input.status, source: input.source, capturedBy: user.sub, evidence: { note: input.note, method: 'manual_entry', ...clientInfo(req) } });
        await writeAudit(tx, { businessId: m.businessId, actorUserId: user.sub, action: `contact.consent_${input.status}`, targetType: 'contact', targetId: id, metadata: { purpose: input.purpose, source: input.source }, ...clientInfo(req) });
      }
    });
    res.status(201).json({ data: { recorded: true } });
  });

  // ---- bulk tagging ----------------------------------------------------------------
  r.post(`${base}/contacts/bulk-tag`, ...guard, requirePermission('contacts.write'), async (req, res) => {
    const m = currentMembership(req);
    const input = parse(bulkTagSchema, req.body);
    let added: Array<{ id: string; contact_id: string }> = [];
    const n = await withUser(deps.db, currentUser(req), async (tx) => {
      const tag = await tx.query('select 1 from public.tags where id = $1 and business_id = $2', [input.tagId, m.businessId]);
      if (!tag.rows.length) throw notFound('Tag not found');
      if (input.action === 'add') {
        const r2 = await tx.query<{ id: string; contact_id: string }>(
          `insert into public.contact_tags (business_id, contact_id, tag_id)
           select $1, c.id, $2 from public.contacts c where c.business_id = $1 and c.id = any($3::uuid[]) on conflict do nothing returning id, contact_id`,
          [m.businessId, input.tagId, input.contactIds]);
        added = r2.rows;
        return r2.rows.length;
      }
      const r2 = await tx.query(`delete from public.contact_tags where business_id = $1 and tag_id = $2 and contact_id = any($3::uuid[]) returning id`, [m.businessId, input.tagId, input.contactIds]);
      return r2.rows.length;
    });
    await emitSafe(deps, added.map((a) => ({ businessId: m.businessId, type: 'tag_added' as const, contactId: a.contact_id, eventId: a.id, data: { tagId: input.tagId } })));
    res.json({ data: { changed: n } });
  });

  // ---- CSV import ----------------------------------------------------------------
  r.post(`${base}/contacts/import`, ...guard, requirePermission('contacts.write'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const input = parse(contactImportSchema, req.body);
    const rows = parseCsv(input.csv);
    if (rows.length < 2) throw new HttpError(422, 'validation_failed', 'The file needs a header row and at least one contact', { fields: { csv: 'No data rows found' } });
    if (rows.length - 1 > 10_000) throw new HttpError(422, 'validation_failed', 'Import at most 10,000 contacts per file', { fields: { csv: 'Too many rows' } });
    const header = rows[0]!.map((h) => h.trim());
    const colFor = (field: string) => header.findIndex((h) => input.mapping[h] === field);
    const phoneCol = colFor('phone');
    if (phoneCol < 0) throw new HttpError(422, 'validation_failed', 'Map one column to Phone', { fields: { mapping: 'Phone column is required' } });
    const customCols = header.map((h, i) => [i, input.mapping[h]] as const).filter(([, f]) => f?.startsWith('custom:')).map(([i, f]) => [i, f!.slice(7)] as const);
    const lim = await contactLimit(deps.db, m.businessId);
    let capacity = lim.limit === null ? Number.POSITIVE_INFINITY : lim.limit - lim.used;

    const result: ImportResultDto = { totalRows: rows.length - 1, created: 0, updated: 0, skipped: 0, errors: [] };
    const importId = `import-${Date.now()}`;
    const events: AutomationEvent[] = [];
    await withUser(deps.db, user, async (tx) => {
      const tagCache = new Map<string, string>();
      const tagIdFor = async (name: string) => {
        const key = name.trim().toLowerCase();
        if (!key) return null;
        if (tagCache.has(key)) return tagCache.get(key)!;
        const t = await tx.query<{ id: string }>(
          `insert into public.tags (business_id, name) values ($1, $2) on conflict (business_id, lower(name)) do update set name = public.tags.name returning id`,
          [m.businessId, name.trim().slice(0, 40)]);
        tagCache.set(key, t.rows[0]!.id);
        return t.rows[0]!.id;
      };
      const seen = new Set<string>();
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i]!;
        const cell = (field: string) => { const c = colFor(field); return c >= 0 ? (row[c] ?? '').trim() : ''; };
        const phone = normalizeIndianPhone(row[phoneCol] ?? '');
        if (!phone) { result.errors.push({ row: i + 1, message: `Invalid phone "${row[phoneCol] ?? ''}"` }); result.skipped++; continue; }
        if (seen.has(phone)) { result.errors.push({ row: i + 1, message: `Duplicate of an earlier row (${phone})` }); result.skipped++; continue; }
        seen.add(phone);
        const email = cell('email');
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) result.errors.push({ row: i + 1, message: `Ignored invalid email "${email}"` });
        const lang = cell('language').toLowerCase();
        const birthday = cell('birthday');
        const custom: Record<string, string> = {};
        for (const [ci, key] of customCols) if ((row[ci] ?? '').trim()) custom[key] = row[ci]!.trim().slice(0, 500);
        const existing = await tx.query<{ id: string; opted_out_at: Date | null }>('select id, opted_out_at from public.contacts where business_id = $1 and phone_e164 = $2', [m.businessId, phone]);
        let contactId: string;
        let optedOut = false;
        if (existing.rows[0]) {
          if (input.onDuplicate === 'skip') { result.skipped++; continue; }
          contactId = existing.rows[0].id;
          optedOut = !!existing.rows[0].opted_out_at;
          await tx.query(
            `update public.contacts set name = case when $2 <> '' then $2 else name end, email = coalesce(nullif($3, ''), email),
               custom_fields = custom_fields || $4::jsonb, archived_at = null where id = $1`,
            [contactId, cell('name'), /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email.toLowerCase() : '', JSON.stringify(custom)]);
          result.updated++;
        } else {
          if (capacity <= 0) { result.errors.push({ row: i + 1, message: 'Contact limit for your plan reached' }); result.skipped++; continue; }
          const c = await tx.query<{ id: string }>(
            `insert into public.contacts (business_id, name, phone_e164, email, language, birthday, custom_fields, source, created_by)
             values ($1, $2, $3, $4, $5, $6, $7, 'csv_import', $8) returning id`,
            [m.businessId, cell('name'), phone, /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email.toLowerCase() : null, lang === 'kn' ? 'kn' : 'en',
             /^\d{4}-\d{2}-\d{2}$/.test(birthday) ? birthday : null, JSON.stringify(custom), user.sub]);
          contactId = c.rows[0]!.id;
          capacity--;
          result.created++;
          events.push({ businessId: m.businessId, type: 'contact_created', contactId, eventId: contactId, data: { source: 'csv_import' } });
        }
        const tagIds = [...input.tagIds];
        for (const name of cell('tags').split(/[;|]/)) { const t = await tagIdFor(name); if (t) tagIds.push(t); }
        events.push(...tagEvents(m.businessId, contactId, await setTags(tx, m.businessId, contactId, tagIds)));
        for (const purpose of ['marketing', 'utility'] as const) {
          if (!input.consent[purpose]) continue;
          if (purpose === 'marketing' && optedOut) { result.errors.push({ row: i + 1, message: `${phone} previously opted out — marketing consent not re-granted` }); continue; }
          await recordConsent(tx, { businessId: m.businessId, contactId, purpose, status: 'granted', source: input.consent.source, capturedBy: user.sub,
            evidence: { method: 'csv_import', importId, row: i + 1, confirmedBy: user.email } });
        }
      }
    });
    await writeAudit(deps.db, { businessId: m.businessId, actorUserId: user.sub, action: 'contacts.imported', targetType: 'import', targetId: importId,
      metadata: { created: result.created, updated: result.updated, skipped: result.skipped, consent: input.consent }, ...clientInfo(req) });
    await emitSafe(deps, events);
    result.errors = result.errors.slice(0, 200);
    res.json({ data: result });
  });

  // ---- export --------------------------------------------------------------------
  r.get(`${base}/contacts-export.csv`, ...guard, requirePermission('contacts.export'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const rows = await withUser(deps.db, user, (tx) =>
      tx.query<any>(`select ${CONTACT_COLUMNS} from public.contacts c where c.business_id = $1 and c.archived_at is null order by c.created_at`, [m.businessId]));
    const customKeys = [...new Set(rows.rows.flatMap((c) => Object.keys(c.custom_fields ?? {})))].sort();
    const out = [[
      'name', 'phone', 'email', 'language', 'birthday', 'tags', 'marketing_opt_in', 'marketing_consent_at', 'marketing_consent_source', 'utility_opt_in', 'opted_out_at', 'source', 'created_at', ...customKeys,
    ]];
    for (const c of rows.rows) {
      const d = mapContact(c);
      out.push([d.name, d.phone, d.email ?? '', d.language, d.birthday ?? '', d.tags.map((t) => t.name).join(';'), String(d.marketingOptIn), d.marketingConsentAt ?? '',
        d.marketingConsentSource ?? '', String(d.utilityOptIn), d.optedOutAt ?? '', d.source, d.createdAt, ...customKeys.map((k) => d.customFields[k] ?? '')]);
    }
    await writeAudit(deps.db, { businessId: m.businessId, actorUserId: user.sub, action: 'contacts.exported', targetType: 'export', metadata: { count: rows.rows.length }, ...clientInfo(req) });
    res.type('text/csv').attachment(`contacts-${new Date().toISOString().slice(0, 10)}.csv`).send(toCsv(out));
  });

  // ---- tags ------------------------------------------------------------------------
  r.get(`${base}/tags`, ...guard, requirePermission('contacts.read'), async (req, res) => {
    const m = currentMembership(req);
    const rows = await withUser(deps.db, currentUser(req), (tx) =>
      tx.query<any>(`select t.*, (select count(*)::int from public.contact_tags ct join public.contacts c on c.id = ct.contact_id where ct.tag_id = t.id and c.archived_at is null) as contact_count
                     from public.tags t where t.business_id = $1 order by t.name`, [m.businessId]));
    res.json({ data: rows.rows.map((t): TagDto => ({ id: t.id, name: t.name, color: t.color, contactCount: t.contact_count })) });
  });

  r.post(`${base}/tags`, ...guard, requirePermission('contacts.write'), async (req, res) => {
    const m = currentMembership(req);
    const input = parse(tagSchema, req.body);
    const row = await withUser(deps.db, currentUser(req), async (tx) => {
      const dup = await tx.query('select 1 from public.tags where business_id = $1 and lower(name) = lower($2)', [m.businessId, input.name]);
      if (dup.rows.length) throw conflict('A tag with this name already exists', 'duplicate_tag');
      return (await tx.query<any>('insert into public.tags (business_id, name, color) values ($1, $2, $3) returning *', [m.businessId, input.name, input.color])).rows[0];
    });
    res.status(201).json({ data: { id: row.id, name: row.name, color: row.color, contactCount: 0 } satisfies TagDto });
  });

  r.delete(`${base}/tags/:tagId`, ...guard, requirePermission('contacts.write'), async (req, res) => {
    const m = currentMembership(req);
    const id = String(req.params.tagId);
    if (!isUuid(id)) throw notFound('Tag not found');
    const d = await withUser(deps.db, currentUser(req), (tx) => tx.query('delete from public.tags where id = $1 and business_id = $2 returning id', [id, m.businessId]));
    if (!d.rows[0]) throw notFound('Tag not found');
    res.status(204).end();
  });

  return r;
}
