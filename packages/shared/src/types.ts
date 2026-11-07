import type { BusinessRole } from './roles';

export interface ApiSuccess<T> {
  data: T;
  meta?: PageMeta;
}
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}
export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
}

export interface SessionDto {
  accessToken: string;
  expiresAt: number; // epoch seconds
  user: { id: string; email: string; emailVerified: boolean };
  aal: 'aal1' | 'aal2';
}

export interface SignupResultDto {
  /** null when email verification is required before the first login */
  session: SessionDto | null;
  emailVerificationRequired: boolean;
}

export interface MembershipDto {
  businessId: string;
  businessName: string;
  businessSlug: string;
  businessStatus: 'active' | 'suspended' | 'closed';
  role: BusinessRole;
}

export interface MeDto {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  preferredLanguage: 'en' | 'kn';
  isPlatformAdmin: boolean;
  aal: 'aal1' | 'aal2';
  memberships: MembershipDto[];
}

export interface BusinessDto {
  id: string;
  name: string;
  slug: string;
  industry: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string;
  timezone: string;
  currency: string;
  defaultLanguage: 'en' | 'kn';
  status: 'active' | 'suspended' | 'closed';
  createdAt: string;
  myRole: BusinessRole;
  subscription: SubscriptionDto | null;
}

export interface SubscriptionDto {
  status: 'trialing' | 'active' | 'past_due' | 'paused' | 'cancelled' | 'expired';
  billingCycle: 'monthly' | 'annual';
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  plan: PlanDto;
}

export interface PlanDto {
  id: string;
  code: string;
  name: string;
  description: string;
  currency: string;
  monthlyPricePaise: number;
  annualPricePaise: number;
  trialDays: number;
  limits: Record<string, number>;
  features: string[];
  isActive: boolean;
}

export interface MemberDto {
  id: string;
  userId: string;
  email: string;
  fullName: string;
  role: BusinessRole;
  status: 'active' | 'disabled';
  createdAt: string;
}

export interface InvitationDto {
  id: string;
  email: string;
  role: 'manager' | 'agent';
  expiresAt: string;
  createdAt: string;
  invitedByName: string | null;
}

export interface DashboardDto {
  totals: {
    contacts: number;
    contactsWithMarketingConsent: number;
    activeCampaigns: number;
    openConversations: number;
    leadsThisMonth: number;
    leadsWonThisMonth: number;
    teamMembers: number;
  };
  messages30d: { sent: number; delivered: number; read: number; failed: number; received: number };
  dailyMessages: Array<{ date: string; outbound: number; inbound: number }>;
  channels: { whatsappConnected: boolean; phoneNumbers: number };
  setupChecklist: Array<{ key: string; label: string; done: boolean; phase: number }>;
}

export interface AuditLogDto {
  id: string;
  action: string;
  actorEmail: string | null;
  actorType: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  businessId: string | null;
  businessName: string | null;
  createdAt: string;
}

export interface AdminOverviewDto {
  businesses: { total: number; active: number; suspended: number; newLast30d: number };
  subscriptions: { trialing: number; active: number; pastDue: number; cancelled: number };
  mrrPaise: number;
  revenueByPlan: Array<{ planCode: string; planName: string; activeCount: number; trialingCount: number; mrrPaise: number }>;
  users: { total: number; newLast30d: number };
  whatsappConnections: number;
  campaigns: { total: number; processing: number };
  webhooks: { received24h: number; failed24h: number };
  failedPayments30d: number;
  openSupportTickets: number;
  signupsByDay: Array<{ date: string; count: number }>;
}

export interface AdminBusinessDto {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended' | 'closed';
  suspendedReason: string | null;
  city: string | null;
  industry: string | null;
  ownerEmail: string | null;
  memberCount: number;
  contactCount: number;
  planName: string | null;
  subscriptionStatus: string | null;
  trialEndsAt: string | null;
  createdAt: string;
}
