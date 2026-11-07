import { Router } from 'express';
import { createTemplateSchema, type TemplateDto } from '@socialpilot/shared';
import type { Deps } from '../deps';
import { withService, withUser } from '../db/context';
import { HttpError, conflict, notFound } from '../lib/errors';
import { clientInfo, iso, isUuid, parse } from '../lib/http';
import { writeAudit } from '../lib/audit';
import { enqueue } from '../jobs/queue';
import { loadChannel, providerFor } from '../whatsapp/provider';
import { ProviderError } from '../whatsapp/errors';
import { buildComponents, namedBody, variablesOf } from '../whatsapp/templates';
import { currentMembership, currentUser, requireAuth, requireMembership, requirePermission } from '../middleware/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mapTemplate(t: any): TemplateDto {
  const comps: any[] = t.components ?? [];
  const body = comps.find((c) => c.type === 'BODY');
  const vars = variablesOf(t);
  const exampleValues: string[] = body?.example?.body_text?.[0] ?? [];
  return {
    id: t.id, name: t.name, language: t.language, category: t.category, status: t.status, provider: t.provider,
    headerText: comps.find((c) => c.type === 'HEADER' && c.format === 'TEXT')?.text ?? null,
    body: namedBody(t), footerText: comps.find((c) => c.type === 'FOOTER')?.text ?? null,
    variables: vars, examples: Object.fromEntries(vars.map((v, i) => [v, exampleValues[i] ?? ''])),
    rejectionReason: t.rejection_reason, submittedAt: iso(t.submitted_at), lastSyncedAt: iso(t.last_synced_at), createdAt: iso(t.created_at)!,
  };
}

export function templatesRouter(deps: Deps): Router {
  const r = Router();
  const base = '/businesses/:businessId/templates';
  const guard = [requireAuth(deps), requireMembership(deps)];

  r.get(base, ...guard, requirePermission('campaigns.read'), async (req, res) => {
    const m = currentMembership(req);
    const rows = await withUser(deps.db, currentUser(req), (tx) => tx.query('select * from public.message_templates where business_id = $1 order by created_at desc', [m.businessId]));
    res.json({ data: rows.rows.map(mapTemplate) });
  });

  r.post(base, ...guard, requirePermission('templates.manage'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const input = parse(createTemplateSchema, req.body);
    const { components, mapping } = buildComponents(input);
    const channel = await loadChannel(deps.db, m.businessId);
    const row = await withUser(deps.db, user, async (tx) => {
      const dup = await tx.query('select 1 from public.message_templates where business_id = $1 and name = $2 and language = $3', [m.businessId, input.name, input.language]);
      if (dup.rows.length) throw conflict('A template with this name and language already exists', 'duplicate_template');
      return (await tx.query(
        `insert into public.message_templates (business_id, name, language, category, status, components, variable_mapping, provider)
         values ($1, $2, $3, $4, 'DRAFT', $5, $6, $7) returning *`,
        [m.businessId, input.name, input.language, input.category, JSON.stringify(components), JSON.stringify(mapping), channel?.provider ?? 'meta_cloud'])).rows[0];
    });
    res.status(201).json({ data: mapTemplate(row) });
  });

  r.post(`${base}/:templateId/submit`, ...guard, requirePermission('templates.manage'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const id = String(req.params.templateId);
    if (!isUuid(id)) throw notFound('Template not found');
    const channel = await loadChannel(deps.db, m.businessId);
    if (!channel || channel.status !== 'connected') throw new HttpError(409, 'not_connected', 'Connect WhatsApp before submitting templates for review');
    const t = await deps.db.query<any>('select * from public.message_templates where id = $1 and business_id = $2', [id, m.businessId]);
    const tpl = t.rows[0];
    if (!tpl) throw notFound('Template not found');
    if (!['DRAFT', 'REJECTED'].includes(tpl.status)) throw conflict(`Template is already ${tpl.status.toLowerCase()}`, 'invalid_status');
    const provider = await providerFor(deps.db, deps.config, m.businessId, channel);
    let remote;
    try {
      remote = await provider.submitTemplate(channel.wabaId, { name: tpl.name, language: tpl.language, category: tpl.category, components: tpl.components });
    } catch (err) {
      if (err instanceof ProviderError) throw new HttpError(400, 'meta_rejected', `Meta rejected the template: ${err.message}`, { metaCode: err.code });
      throw err;
    }
    const status = ['APPROVED', 'PENDING', 'REJECTED'].includes(remote.status) ? remote.status : 'PENDING';
    const row = await withService(deps.db, async (tx) => {
      const u = await tx.query(
        `update public.message_templates set status = $2, meta_template_id = $3, submitted_at = now(), rejection_reason = null, provider = $4 where id = $1 returning *`,
        [id, status, remote.id, provider.kind]);
      if (provider.kind === 'mock') await enqueue(tx, 'template.mock_review', { templateId: id }, { businessId: m.businessId, runAt: new Date(Date.now() + 3000) });
      await writeAudit(tx, { businessId: m.businessId, actorUserId: user.sub, action: 'template.submitted', targetType: 'message_template', targetId: id, metadata: { name: tpl.name, provider: provider.kind }, ...clientInfo(req) });
      return u.rows[0];
    });
    res.json({ data: mapTemplate(row) });
  });

  /** Pull approval status (and templates created in WhatsApp Manager) from Meta. */
  r.post(`${base}/sync`, ...guard, requirePermission('templates.manage'), async (req, res) => {
    const m = currentMembership(req);
    const channel = await loadChannel(deps.db, m.businessId);
    if (!channel || channel.status !== 'connected') throw new HttpError(409, 'not_connected', 'Connect WhatsApp first');
    if (channel.provider === 'mock') {
      res.json({ data: { updated: 0, imported: 0, note: 'Mock connection: templates are reviewed automatically' } });
      return;
    }
    const provider = await providerFor(deps.db, deps.config, m.businessId, channel);
    let remote;
    try {
      remote = await provider.listTemplates(channel.wabaId);
    } catch (err) {
      if (err instanceof ProviderError) throw new HttpError(400, 'meta_rejected', `Meta: ${err.message}`);
      throw err;
    }
    let updated = 0;
    let imported = 0;
    const statusMap: Record<string, string> = { APPROVED: 'APPROVED', PENDING: 'PENDING', REJECTED: 'REJECTED', PAUSED: 'PAUSED', DISABLED: 'DISABLED', IN_APPEAL: 'REJECTED', PENDING_DELETION: 'DISABLED' };
    await withService(deps.db, async (tx) => {
      for (const t of remote as any[]) {
        const status = statusMap[t.status] ?? 'PENDING';
        const u = await tx.query(
          `update public.message_templates set status = $4, meta_template_id = $5, rejection_reason = $6, last_synced_at = now()
           where business_id = $1 and name = $2 and language = $3 returning id`,
          [m.businessId, t.name, t.language, status, t.id, t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null]);
        if (u.rows.length) { updated++; continue; }
        if (!['MARKETING', 'UTILITY'].includes(t.category) || !Array.isArray(t.components)) continue;
        // Imported templates keep positional placeholders; they map to param_1, param_2… (fill via campaign defaults or custom fields).
        const body = t.components.find((c: any) => c.type === 'BODY')?.text ?? '';
        const nums = [...new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map((x: any) => x[1]))];
        const mapping = Object.fromEntries(nums.map((n) => [n, `param_${n}`]));
        await tx.query(
          `insert into public.message_templates (business_id, name, language, category, status, meta_template_id, components, variable_mapping, provider, last_synced_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, 'meta_cloud', now()) on conflict (business_id, name, language) do nothing`,
          [m.businessId, t.name, t.language, t.category, status, t.id, JSON.stringify(t.components), JSON.stringify(mapping)]);
        imported++;
      }
    });
    res.json({ data: { updated, imported } });
  });

  r.delete(`${base}/:templateId`, ...guard, requirePermission('templates.manage'), async (req, res) => {
    const m = currentMembership(req);
    const id = String(req.params.templateId);
    if (!isUuid(id)) throw notFound('Template not found');
    await withUser(deps.db, currentUser(req), async (tx) => {
      const t = await tx.query<{ status: string }>('select status from public.message_templates where id = $1 and business_id = $2', [id, m.businessId]);
      if (!t.rows[0]) throw notFound('Template not found');
      if (!['DRAFT', 'REJECTED'].includes(t.rows[0].status)) throw conflict('Only draft or rejected templates can be deleted here. Delete approved templates in WhatsApp Manager, then sync.', 'invalid_status');
      const used = await tx.query('select 1 from public.campaigns where template_id = $1 limit 1', [id]);
      if (used.rows.length) throw conflict('This template is used by a campaign', 'template_in_use');
      await tx.query('delete from public.message_templates where id = $1', [id]);
    });
    res.status(204).end();
  });

  return r;
}
