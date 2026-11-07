import { Router } from 'express';
import type { DashboardDto } from '@socialpilot/shared';
import type { Deps } from '../deps';
import { withUser } from '../db/context';
import { currentMembership, currentUser, requireAuth, requireMembership, requirePermission } from '../middleware/auth';

/**
 * Workspace dashboard.  All queries run under RLS, so an agent automatically
 * sees counts for only the conversations they can access.
 * Numbers are real aggregates; they are zero until Phase 2 starts writing messages.
 */
export function dashboardRouter(deps: Deps): Router {
  const r = Router();
  r.get('/businesses/:businessId/dashboard', requireAuth(deps), requireMembership(deps), requirePermission('business.read'), async (req, res) => {
    const m = currentMembership(req);
    const data = await withUser(deps.db, currentUser(req), async (tx): Promise<DashboardDto> => {
      const totals = await tx.query<DashboardDto['totals']>(
        `select
           (select count(*)::int from public.contacts where business_id = $1 and archived_at is null) as "contacts",
           (select count(distinct c.contact_id)::int from (
              select distinct on (contact_id) contact_id, status from public.contact_consents
              where business_id = $1 and purpose = 'marketing' order by contact_id, occurred_at desc) c
            where c.status = 'granted') as "contactsWithMarketingConsent",
           (select count(*)::int from public.campaigns where business_id = $1 and status in ('scheduled', 'processing')) as "activeCampaigns",
           (select count(*)::int from public.conversations where business_id = $1 and status <> 'closed') as "openConversations",
           (select count(*)::int from public.leads where business_id = $1 and created_at >= date_trunc('month', now())) as "leadsThisMonth",
           (select count(*)::int from public.leads where business_id = $1 and status = 'won' and updated_at >= date_trunc('month', now())) as "leadsWonThisMonth",
           (select count(*)::int from public.business_members where business_id = $1 and status = 'active') as "teamMembers"`,
        [m.businessId],
      );
      const msgs = await tx.query<DashboardDto['messages30d']>(
        `select
           count(*) filter (where direction = 'outbound' and status in ('sent', 'delivered', 'read'))::int as sent,
           count(*) filter (where direction = 'outbound' and status in ('delivered', 'read'))::int as delivered,
           count(*) filter (where direction = 'outbound' and status = 'read')::int as read,
           count(*) filter (where direction = 'outbound' and status = 'failed')::int as failed,
           count(*) filter (where direction = 'inbound')::int as received
         from public.messages where business_id = $1 and created_at >= now() - interval '30 days'`,
        [m.businessId],
      );
      const daily = await tx.query<{ date: string; outbound: number; inbound: number }>(
        `select to_char(d.day, 'YYYY-MM-DD') as date,
                coalesce(count(msg.id) filter (where msg.direction = 'outbound'), 0)::int as outbound,
                coalesce(count(msg.id) filter (where msg.direction = 'inbound'), 0)::int as inbound
         from generate_series(date_trunc('day', now() - interval '13 days'), date_trunc('day', now()), interval '1 day') as d(day)
         left join public.messages msg on msg.business_id = $1 and date_trunc('day', msg.created_at) = d.day
         group by d.day order by d.day`,
        [m.businessId],
      );
      const ch = await tx.query<{ connected: boolean; numbers: number }>(
        `select exists (select 1 from public.connected_channels where business_id = $1 and channel = 'whatsapp' and status = 'connected') as connected,
                (select count(*)::int from public.whatsapp_phone_numbers where business_id = $1 and status = 'connected') as numbers`,
        [m.businessId],
      );
      const profile = await tx.query<{ complete: boolean; campaigns: number }>(
        `select (phone is not null and city is not null) as complete,
                (select count(*)::int from public.campaigns where business_id = $1 and started_at is not null) as campaigns
         from public.businesses where id = $1`,
        [m.businessId],
      );
      const t = totals.rows[0]!;
      const channels = { whatsappConnected: !!ch.rows[0]?.connected, phoneNumbers: ch.rows[0]?.numbers ?? 0 };
      return {
        totals: t,
        messages30d: msgs.rows[0]!,
        dailyMessages: daily.rows,
        channels,
        setupChecklist: [
          { key: 'workspace', label: 'Create your workspace', done: true, phase: 1 },
          { key: 'profile', label: 'Complete business profile', done: !!profile.rows[0]?.complete, phase: 1 },
          { key: 'team', label: 'Invite your team', done: t.teamMembers > 1, phase: 1 },
          { key: 'whatsapp', label: 'Connect WhatsApp Business', done: channels.whatsappConnected, phase: 2 },
          { key: 'contacts', label: 'Import opted-in contacts', done: t.contacts > 0, phase: 2 },
          { key: 'campaign', label: 'Send your first campaign', done: (profile.rows[0]?.campaigns ?? 0) > 0, phase: 2 },
        ],
      };
    });
    res.json({ data });
  });
  return r;
}
