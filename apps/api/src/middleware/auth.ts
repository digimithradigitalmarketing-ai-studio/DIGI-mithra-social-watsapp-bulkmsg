import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { can, type BusinessRole, type Permission } from '@socialpilot/shared';
import type { Deps } from '../deps';
import type { VerifiedToken } from '../auth/provider';
import { HttpError, forbidden, notFound, unauthorized } from '../lib/errors';
import { isUuid } from '../lib/http';

export interface Membership {
  businessId: string;
  businessName: string;
  role: BusinessRole;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: VerifiedToken;
      accessToken?: string;
      membership?: Membership;
    }
  }
}

export function currentUser(req: Request): VerifiedToken {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function currentMembership(req: Request): Membership {
  if (!req.membership) throw forbidden();
  return req.membership;
}

export function requireAuth(deps: Deps): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.get('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return next(unauthorized());
    const claims = await deps.auth.verifyAccessToken(match[1]!);
    if (!claims.emailVerified) return next(new HttpError(403, 'email_not_verified', 'Please verify your email address'));
    req.user = claims;
    req.accessToken = match[1]!;
    next();
  };
}

/**
 * Loads the caller's membership for :businessId.  Non-members get 404 (we do
 * not reveal that another tenant's workspace exists).  Suspended workspaces
 * get 423 so the UI can explain why.
 */
export function requireMembership(deps: Deps): RequestHandler {
  return async (req, _res, next) => {
    const user = currentUser(req);
    const businessId = String(req.params.businessId ?? '');
    if (!isUuid(businessId)) return next(notFound('Workspace not found'));
    const r = await deps.db.query<{ role: BusinessRole; member_status: string; business_status: string; name: string; suspended_reason: string | null }>(
      `select m.role, m.status as member_status, b.status as business_status, b.name, b.suspended_reason
       from public.business_members m join public.businesses b on b.id = m.business_id
       where m.business_id = $1 and m.user_id = $2`,
      [businessId, user.sub],
    );
    const row = r.rows[0];
    if (!row || row.member_status !== 'active') return next(notFound('Workspace not found'));
    if (row.business_status !== 'active')
      return next(new HttpError(423, 'business_suspended', 'This workspace is suspended. Contact DigiMithra support.', { reason: row.suspended_reason }));
    req.membership = { businessId, businessName: row.name, role: row.role };
    next();
  };
}

export function requirePermission(...perms: Permission[]): RequestHandler {
  return (req, _res, next) => {
    const m = currentMembership(req);
    if (!perms.some((p) => can(m.role, p))) return next(forbidden());
    next();
  };
}

/** Super Admin guard: explicit platform_admins row + MFA (aal2) when ADMIN_REQUIRE_MFA. */
export function requirePlatformAdmin(deps: Deps): RequestHandler {
  return async (req, _res, next) => {
    const user = currentUser(req);
    const r = await deps.db.query('select 1 from public.platform_admins where user_id = $1', [user.sub]);
    if (!r.rows.length) return next(notFound());
    if (deps.config.ADMIN_REQUIRE_MFA && user.aal !== 'aal2')
      return next(new HttpError(403, 'mfa_required', 'Super Admin access requires two-factor authentication'));
    next();
  };
}
