import type { CampaignPreviewDto, CampaignStatsDto } from '@socialpilot/shared';
import type { AppConfig } from '../config';
import type { Queryable } from '../db';
import { enqueue } from '../jobs/queue';
import { writeAudit } from '../lib/audit';
import { loadChannel, tierCapacity } from '../whatsapp/provider';
import { renderBody, resolveAll, type StoredTemplate } from '../whatsapp/templates';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CampaignRow {
  id: string;
  business_id: string;
  name: string;
  status: string;
  template_id: string | null;
  audience: { type: 'all' | 'tags'; tagIds: string[] };
  variable_mapping: Record<string, string>; // campaign variable defaults
  scheduled_at: Date | null;
}

export interface TemplateRow extends StoredTemplate {
  id: string;
  status: string;
}

interface AudienceMember {
  contactId: string;
  name: string;
  phone: string;
  eligible: boolean;
  skipReason: string | null;
  values: string[];
}

/** Which contacts would receive this campaign, and why others are excluded. Service context with explicit business filter. */
export async function evaluateAudience(db: Queryable, campaign: CampaignRow, template: TemplateRow, businessName: string): Promise<AudienceMember[]> {
  const params: unknown[] = [campaign.business_id];
  let tagFilter = '';
  if (campaign.audience.type === 'tags') {
    params.push(campaign.audience.tagIds);
    tagFilter = `and exists (select 1 from public.contact_tags ct where ct.contact_id = c.id and ct.tag_id = any($2::uuid[]))`;
  }
  const rows = await db.query<any>(
    `select c.id, c.name, c.phone_e164, c.custom_fields, c.opted_out_at, c.marketing_opt_in, c.utility_opt_in,
            exists (select 1 from public.suppression_lists s
                    where (s.business_id = c.business_id or s.business_id is null) and s.phone_e164 = c.phone_e164) as suppressed
     from public.contacts c
     where c.business_id = $1 and c.archived_at is null ${tagFilter}
     order by c.created_at`,
    params,
  );
  const purpose = template.category === 'MARKETING' ? 'marketing' : 'utility';
  const seenPhones = new Set<string>();
  const out: AudienceMember[] = [];
  for (const c of rows.rows) {
    if (seenPhones.has(c.phone_e164)) continue; // duplicate recipients are never messaged twice
    seenPhones.add(c.phone_e164);
    const { values, missing } = resolveAll(template, {
      contact: { name: c.name, phone_e164: c.phone_e164, custom_fields: c.custom_fields ?? {} },
      businessName,
      defaults: campaign.variable_mapping ?? {},
    });
    let skipReason: string | null = null;
    if (c.opted_out_at) skipReason = 'opted_out';
    else if (c.suppressed) skipReason = 'suppressed';
    else if (purpose === 'marketing' ? !c.marketing_opt_in : !(c.utility_opt_in || c.marketing_opt_in)) skipReason = 'no_consent';
    else if (missing.length) skipReason = 'missing_variable';
    out.push({ contactId: c.id, name: c.name, phone: c.phone_e164, eligible: !skipReason, skipReason, values });
  }
  return out;
}

export async function usedLast24h(db: Queryable, businessId: string): Promise<number> {
  const r = await db.query<{ n: number }>(
    `select count(distinct contact_id)::int as n from public.messages
     where business_id = $1 and direction = 'outbound' and message_type = 'template' and created_at > now() - interval '24 hours'`,
    [businessId],
  );
  return r.rows[0]?.n ?? 0;
}

async function broadcastUsage(db: Queryable, businessId: string, excludeCampaignId: string) {
  const r = await db.query<{ used: number; lim: number | null }>(
    `select (select count(*)::int from public.campaigns where business_id = $1 and id <> $2
               and (started_at >= date_trunc('month', now()) or status = 'scheduled')) as used,
            (select limit_value from public.subscription_entitlements where business_id = $1 and key = 'broadcasts_monthly') as lim`,
    [businessId, excludeCampaignId],
  );
  return { used: r.rows[0]?.used ?? 0, limit: r.rows[0]?.lim == null ? null : Number(r.rows[0].lim) };
}

/** Account eligibility: active workspace + live subscription (trial not expired). */
export async function subscriptionBlocker(db: Queryable, businessId: string): Promise<string | null> {
  const r = await db.query<{ status: string; trial_ends_at: Date | null; business_status: string }>(
    `select s.status, s.trial_ends_at, b.status as business_status from public.businesses b
     left join public.subscriptions s on s.business_id = b.id where b.id = $1`,
    [businessId],
  );
  const x = r.rows[0];
  if (!x) return 'Workspace not found';
  if (x.business_status !== 'active') return 'This workspace is suspended';
  if (x.status === 'trialing' && x.trial_ends_at && new Date(x.trial_ends_at).getTime() < Date.now()) return 'Your free trial has ended. Choose a plan to keep sending.';
  if (!['trialing', 'active'].includes(x.status ?? '')) return 'Your subscription is not active';
  return null;
}

export async function loadTemplate(db: Queryable, businessId: string, templateId: string | null): Promise<TemplateRow | null> {
  if (!templateId) return null;
  const r = await db.query<TemplateRow>(
    `select id, name, language, category, status, components, variable_mapping from public.message_templates where id = $1 and business_id = $2`,
    [templateId, businessId],
  );
  return r.rows[0] ?? null;
}

export async function businessName(db: Queryable, businessId: string): Promise<string> {
  const r = await db.query<{ name: string }>('select name from public.businesses where id = $1', [businessId]);
  return r.rows[0]?.name ?? '';
}

/** Full pre-send validation used by preview and schedule. */
export async function previewCampaign(db: Queryable, campaign: CampaignRow): Promise<CampaignPreviewDto> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const template = await loadTemplate(db, campaign.business_id, campaign.template_id);
  const channel = await loadChannel(db, campaign.business_id);
  const sub = await subscriptionBlocker(db, campaign.business_id);
  if (sub) blockers.push(sub);
  if (!channel || channel.status !== 'connected') blockers.push('Connect a WhatsApp Business number first');
  if (channel?.provider === 'mock') warnings.push('Mock connection: no real WhatsApp messages will be sent');
  if (!template) blockers.push('Choose a message template');
  else {
    if (template.status !== 'APPROVED') blockers.push(`Template "${template.name}" is ${template.status.toLowerCase()} — only Meta-approved templates can be sent`);
    if (template.category === 'AUTHENTICATION') blockers.push('Authentication templates cannot be used for broadcasts');
  }
  const bu = await broadcastUsage(db, campaign.business_id, campaign.id);
  if (bu.limit !== null && bu.used >= bu.limit) blockers.push(`Your plan allows ${bu.limit} broadcasts per month`);
  const tier = channel?.phone.messagingLimitTier ?? null;
  const capacity = channel ? tierCapacity(tier) : null;
  const used = await usedLast24h(db, campaign.business_id);

  let audience: AudienceMember[] = [];
  if (template) audience = await evaluateAudience(db, campaign, template, await businessName(db, campaign.business_id));
  const skipped: Record<string, number> = {};
  for (const a of audience) if (a.skipReason) skipped[a.skipReason] = (skipped[a.skipReason] ?? 0) + 1;
  let eligible = audience.filter((a) => a.eligible).length;
  if (capacity !== null && eligible > Math.max(capacity - used, 0)) {
    const over = eligible - Math.max(capacity - used, 0);
    warnings.push(`${over} recipient(s) exceed your WhatsApp messaging limit (${tier ?? 'default'}: ${capacity} unique customers / 24h) and will be skipped`);
    skipped.messaging_limit = over;
    eligible -= over;
  }
  if (template && audience.length && eligible === 0) blockers.push('No eligible recipients: check consent, opt-outs and personalisation values');
  if (template && !audience.length) blockers.push('The selected audience has no contacts');
  return {
    audienceSize: audience.length,
    eligible,
    skipped,
    sample: template ? audience.filter((a) => a.eligible).slice(0, 3).map((a) => ({ contactName: a.name, phone: a.phone, rendered: renderBody(template, a.values) })) : [],
    blockers,
    warnings,
    limits: { messagingTier: tier, tierCapacity: capacity, usedLast24h: used, broadcastsThisMonth: bu.used, broadcastsLimit: bu.limit },
  };
}

/** Job handler for campaign.start: materialise recipients and queue paced sends. Idempotent. */
export async function startCampaign(db: Queryable, config: AppConfig, campaignId: string): Promise<void> {
  const c = await db.query<CampaignRow>('select * from public.campaigns where id = $1 for update', [campaignId]);
  const campaign = c.rows[0];
  if (!campaign || campaign.status !== 'scheduled') return;
  const fail = async (reason: string) => {
    await db.query(`update public.campaigns set status = 'failed', cancelled_reason = $2, completed_at = now() where id = $1`, [campaignId, reason]);
    await writeAudit(db, { businessId: campaign.business_id, actorType: 'system', action: 'campaign.failed', targetType: 'campaign', targetId: campaignId, metadata: { reason } });
  };
  const preview = await previewCampaign(db, campaign);
  if (preview.blockers.length) return fail(preview.blockers.join('; '));
  const template = (await loadTemplate(db, campaign.business_id, campaign.template_id))!;
  const audience = await evaluateAudience(db, campaign, template, await businessName(db, campaign.business_id));
  const channel = (await loadChannel(db, campaign.business_id))!;
  const capacity = tierCapacity(channel.phone.messagingLimitTier);
  let remaining = capacity === null ? Number.POSITIVE_INFINITY : Math.max(capacity - (await usedLast24h(db, campaign.business_id)), 0);

  let order = 0;
  for (const a of audience) {
    let skip = a.skipReason;
    if (!skip && remaining <= 0) skip = 'messaging_limit';
    const r = await db.query<{ id: string }>(
      `insert into public.campaign_recipients (business_id, campaign_id, contact_id, phone_e164, variables, status, skip_reason)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (campaign_id, contact_id) do nothing returning id`,
      [campaign.business_id, campaignId, a.contactId, a.phone, JSON.stringify(a.values), skip ? 'skipped' : 'pending', skip],
    );
    if (!skip && r.rows[0]) {
      remaining--;
      const delayMs = Math.floor((order++ / config.CAMPAIGN_SEND_RATE_PER_SECOND) * 1000);
      await enqueue(db, 'message.send', { recipientId: r.rows[0].id }, {
        businessId: campaign.business_id, dedupeKey: `send:${r.rows[0].id}`, runAt: new Date(Date.now() + delayMs), maxAttempts: config.JOB_MAX_ATTEMPTS,
      });
    }
  }
  await db.query(`update public.campaigns set status = 'processing', started_at = now() where id = $1`, [campaignId]);
  await writeAudit(db, { businessId: campaign.business_id, actorType: 'system', action: 'campaign.started', targetType: 'campaign', targetId: campaignId, metadata: { queued: order } });
  await recomputeCampaign(db, campaignId);
}

export async function campaignStats(db: Queryable, campaignId: string): Promise<CampaignStatsDto> {
  const r = await db.query<CampaignStatsDto>(
    `select count(*)::int as total,
            count(*) filter (where status = 'skipped')::int as skipped,
            count(*) filter (where status = 'pending')::int as pending,
            count(*) filter (where status = 'queued')::int as queued,
            count(*) filter (where status in ('sent', 'delivered', 'read', 'replied'))::int as sent,
            count(*) filter (where status in ('delivered', 'read', 'replied'))::int as delivered,
            count(*) filter (where status = 'read' or (status = 'replied' and read_at is not null))::int as read,
            count(*) filter (where status = 'replied')::int as replied,
            count(*) filter (where status = 'failed')::int as failed
     from public.campaign_recipients where campaign_id = $1`,
    [campaignId],
  );
  return r.rows[0]!;
}

/** Refresh denormalised counters and move processing campaigns to their terminal state. */
export async function recomputeCampaign(db: Queryable, campaignId: string): Promise<void> {
  const s = await campaignStats(db, campaignId);
  const c = await db.query<{ status: string; business_id: string }>('select status, business_id from public.campaigns where id = $1', [campaignId]);
  const status = c.rows[0]?.status;
  if (!status) return;
  let next = status;
  const settled = ['processing', 'completed', 'partially_completed', 'failed'].includes(status) && s.pending === 0;
  // A campaign that failed before creating recipients (e.g. blocked at start) keeps its failed status.
  if (settled && !(status === 'failed' && s.total === 0)) {
    const attempted = s.total - s.skipped;
    if (attempted === 0 || s.failed === attempted) next = 'failed';
    else if (s.failed > 0) next = 'partially_completed';
    else next = 'completed';
  }
  await db.query(
    `update public.campaigns set total_recipients = $2, skipped_count = $3, queued_count = $4, sent_count = $5, delivered_count = $6,
       read_count = $7, replied_count = $8, failed_count = $9, status = $10,
       completed_at = case when $10 in ('completed', 'partially_completed', 'failed') and completed_at is null then now() else completed_at end
     where id = $1`,
    [campaignId, s.total, s.skipped, s.queued, s.sent, s.delivered, s.read, s.replied, s.failed, next],
  );
}

/** Pause: stop pending sends (they are re-queued on resume). */
export async function pauseCampaign(db: Queryable, campaignId: string) {
  await db.query(
    `update public.scheduled_jobs set status = 'cancelled', finished_at = now(), last_error = 'campaign paused'
     where kind = 'message.send' and status = 'pending' and payload->>'recipientId' in (
       select id::text from public.campaign_recipients where campaign_id = $1 and status = 'pending')`,
    [campaignId],
  );
}

export async function resumeCampaign(db: Queryable, config: AppConfig, campaignId: string, businessId: string) {
  const pending = await db.query<{ id: string }>(`select id from public.campaign_recipients where campaign_id = $1 and status = 'pending' order by created_at`, [campaignId]);
  let i = 0;
  for (const r of pending.rows) {
    // Clear any cancelled job so the dedupe key can be reused.
    await db.query(`delete from public.scheduled_jobs where dedupe_key = $1 and status in ('cancelled', 'done', 'failed')`, [`send:${r.id}`]);
    await enqueue(db, 'message.send', { recipientId: r.id }, {
      businessId, dedupeKey: `send:${r.id}`, runAt: new Date(Date.now() + Math.floor((i++ / config.CAMPAIGN_SEND_RATE_PER_SECOND) * 1000)), maxAttempts: config.JOB_MAX_ATTEMPTS,
    });
  }
}
