import type { BusinessDto, BusinessRole, MembershipDto, PlanDto, SubscriptionDto } from '@socialpilot/shared';
import type { Queryable } from '../db';
import { iso } from './http';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mapPlan(r: any): PlanDto {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    currency: r.currency,
    monthlyPricePaise: Number(r.monthly_price_paise),
    annualPricePaise: Number(r.annual_price_paise),
    trialDays: Number(r.trial_days),
    limits: r.limits ?? {},
    features: r.features ?? [],
    isActive: !!r.is_active,
  };
}

export function mapBusiness(r: any, myRole: BusinessRole, subscription: SubscriptionDto | null): BusinessDto {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    industry: r.industry,
    phone: r.phone,
    email: r.email,
    website: r.website,
    address: r.address,
    city: r.city,
    state: r.state,
    country: r.country,
    timezone: r.timezone,
    currency: r.currency,
    defaultLanguage: r.default_language,
    status: r.status,
    createdAt: iso(r.created_at)!,
    myRole,
    subscription,
  };
}

/** Loads the subscription + plan for a business. Works under RLS (members) or service. */
export async function loadSubscription(tx: Queryable, businessId: string): Promise<SubscriptionDto | null> {
  const r = await tx.query<any>(
    `select s.status, s.billing_cycle, s.trial_ends_at, s.current_period_end, p.*
     from public.subscriptions s join public.subscription_plans p on p.id = s.plan_id
     where s.business_id = $1`,
    [businessId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    status: row.status,
    billingCycle: row.billing_cycle,
    trialEndsAt: iso(row.trial_ends_at),
    currentPeriodEnd: iso(row.current_period_end),
    plan: mapPlan(row),
  };
}

/** All memberships of a user, including suspended workspaces (so the UI can explain). Service query filtered by user id. */
export async function loadMemberships(db: Queryable, userId: string): Promise<MembershipDto[]> {
  const r = await db.query<any>(
    `select b.id, b.name, b.slug, b.status, m.role
     from public.business_members m join public.businesses b on b.id = m.business_id
     where m.user_id = $1 and m.status = 'active' and b.status <> 'closed'
     order by b.created_at`,
    [userId],
  );
  return r.rows.map((x) => ({ businessId: x.id, businessName: x.name, businessSlug: x.slug, businessStatus: x.status, role: x.role }));
}
