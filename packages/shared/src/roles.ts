// Single source of truth for business roles and permissions.
// Mirrors the seeded rows in public.business_roles (migration 0001) and is
// enforced by the API (requirePermission) and, coarsely, by Postgres RLS.

export const BUSINESS_ROLES = ['owner', 'manager', 'agent'] as const;
export type BusinessRole = (typeof BUSINESS_ROLES)[number];

export const PERMISSIONS = [
  'business.read',
  'business.update',
  'members.read',
  'members.manage',
  'members.invite_agent',
  'billing.read',
  'billing.manage',
  'channels.manage',
  'contacts.read',
  'contacts.write',
  'contacts.export',
  'campaigns.read',
  'campaigns.manage',
  'templates.manage',
  'conversations.read_all',
  'conversations.read_assigned',
  'conversations.reply',
  'conversations.assign',
  'leads.update',
  'automation.manage',
  'ai.manage',
  'analytics.read',
  'audit.read',
  'api_keys.manage',
  'privacy.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const OWNER: readonly Permission[] = PERMISSIONS;

const MANAGER: readonly Permission[] = [
  'business.read',
  'members.read',
  'members.invite_agent',
  'billing.read',
  'contacts.read',
  'contacts.write',
  'contacts.export',
  'campaigns.read',
  'campaigns.manage',
  'templates.manage',
  'conversations.read_all',
  'conversations.read_assigned',
  'conversations.reply',
  'conversations.assign',
  'leads.update',
  'automation.manage',
  'ai.manage',
  'analytics.read',
  'audit.read',
];

const AGENT: readonly Permission[] = [
  'business.read',
  'members.read',
  'contacts.read',
  'conversations.read_assigned',
  'conversations.reply',
  'leads.update',
];

export const ROLE_PERMISSIONS: Record<BusinessRole, readonly Permission[]> = {
  owner: OWNER,
  manager: MANAGER,
  agent: AGENT,
};

export const ROLE_LABELS: Record<BusinessRole, string> = {
  owner: 'Business Owner',
  manager: 'Business Manager',
  agent: 'Business Agent',
};

export function can(role: BusinessRole | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Which roles may an actor with `actorRole` assign / invite / remove? */
export function manageableRoles(actorRole: BusinessRole): BusinessRole[] {
  if (actorRole === 'owner') return ['owner', 'manager', 'agent'];
  if (actorRole === 'manager') return ['agent'];
  return [];
}

export function invitableRoles(actorRole: BusinessRole): Array<Exclude<BusinessRole, 'owner'>> {
  if (actorRole === 'owner') return ['manager', 'agent'];
  if (actorRole === 'manager') return ['agent'];
  return [];
}
