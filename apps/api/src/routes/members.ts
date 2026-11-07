import { Router } from 'express';
import {
  acceptInvitationSchema,
  inviteMemberSchema,
  invitableRoles,
  manageableRoles,
  updateMemberSchema,
  type BusinessRole,
  type InvitationDto,
  type MemberDto,
} from '@socialpilot/shared';
import type { Deps } from '../deps';
import { withService, withUser } from '../db/context';
import { HttpError, conflict, forbidden, notFound } from '../lib/errors';
import { clientInfo, iso, isUuid, parse } from '../lib/http';
import { writeAudit } from '../lib/audit';
import { randomToken, sha256 } from '../lib/crypto';
import { currentMembership, currentUser, requireAuth, requireMembership, requirePermission } from '../middleware/auth';

const INVITE_TTL_DAYS = 7;

/* eslint-disable @typescript-eslint/no-explicit-any */
const mapMember = (r: any): MemberDto => ({
  id: r.id,
  userId: r.user_id,
  email: r.email,
  fullName: r.full_name,
  role: r.role,
  status: r.status,
  createdAt: iso(r.created_at)!,
});

const mapInvitation = (r: any): InvitationDto => ({
  id: r.id,
  email: r.email,
  role: r.role,
  expiresAt: iso(r.expires_at)!,
  createdAt: iso(r.created_at)!,
  invitedByName: r.invited_by_name ?? null,
});

export function membersRouter(deps: Deps): Router {
  const r = Router();
  const auth = requireAuth(deps);
  const member = requireMembership(deps);
  const base = '/businesses/:businessId';

  r.get(`${base}/members`, auth, member, requirePermission('members.read'), async (req, res) => {
    const m = currentMembership(req);
    const rows = await withUser(deps.db, currentUser(req), (tx) =>
      tx.query(
        `select bm.id, bm.user_id, bm.role, bm.status, bm.created_at, p.email, p.full_name
         from public.business_members bm join public.profiles p on p.id = bm.user_id
         where bm.business_id = $1
         order by case bm.role when 'owner' then 0 when 'manager' then 1 else 2 end, p.full_name`,
        [m.businessId],
      ),
    );
    res.json({ data: rows.rows.map(mapMember) });
  });

  r.patch(`${base}/members/:memberId`, auth, member, requirePermission('members.manage', 'members.invite_agent'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const memberId = String(req.params.memberId);
    if (!isUuid(memberId)) throw notFound('Member not found');
    const input = parse(updateMemberSchema, req.body);
    const allowed = manageableRoles(m.role);

    const updated = await withUser(deps.db, user, async (tx) => {
      const t = await tx.query<{ id: string; user_id: string; role: BusinessRole; status: string }>(
        'select id, user_id, role, status from public.business_members where id = $1 and business_id = $2',
        [memberId, m.businessId],
      );
      const target = t.rows[0];
      if (!target) throw notFound('Member not found');
      if (target.user_id === user.sub) throw forbidden('You cannot change your own role or status');
      if (!allowed.includes(target.role)) throw forbidden('You cannot manage this team member');
      if (input.role && !allowed.includes(input.role)) throw forbidden('You cannot assign this role');
      if (target.role === 'owner' && (input.role && input.role !== 'owner' || input.status === 'disabled')) {
        const owners = await tx.query<{ n: number }>(
          `select count(*)::int as n from public.business_members where business_id = $1 and role = 'owner' and status = 'active'`,
          [m.businessId],
        );
        if ((owners.rows[0]?.n ?? 0) <= 1) throw conflict('A workspace must keep at least one active owner', 'last_owner');
      }
      const u = await tx.query(
        `update public.business_members set role = coalesce($2, role), status = coalesce($3, status)
         where id = $1 returning id`,
        [memberId, input.role ?? null, input.status ?? null],
      );
      if (!u.rows[0]) throw forbidden('You cannot manage this team member'); // RLS rejected the update
      const full = await tx.query(
        `select bm.id, bm.user_id, bm.role, bm.status, bm.created_at, p.email, p.full_name
         from public.business_members bm join public.profiles p on p.id = bm.user_id where bm.id = $1`,
        [memberId],
      );
      return { before: target, after: mapMember(full.rows[0]) };
    });
    await writeAudit(deps.db, {
      businessId: m.businessId, actorUserId: user.sub, action: 'member.updated', targetType: 'business_member', targetId: memberId,
      metadata: { from: { role: updated.before.role, status: updated.before.status }, to: input }, ...clientInfo(req),
    });
    res.json({ data: updated.after });
  });

  r.delete(`${base}/members/:memberId`, auth, member, requirePermission('members.manage', 'members.invite_agent'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const memberId = String(req.params.memberId);
    if (!isUuid(memberId)) throw notFound('Member not found');
    const allowed = manageableRoles(m.role);
    const removed = await withUser(deps.db, user, async (tx) => {
      const t = await tx.query<{ user_id: string; role: BusinessRole }>(
        'select user_id, role from public.business_members where id = $1 and business_id = $2',
        [memberId, m.businessId],
      );
      const target = t.rows[0];
      if (!target) throw notFound('Member not found');
      if (target.user_id === user.sub) throw forbidden('You cannot remove yourself');
      if (!allowed.includes(target.role)) throw forbidden('You cannot remove this team member');
      if (target.role === 'owner') {
        const owners = await tx.query<{ n: number }>(
          `select count(*)::int as n from public.business_members where business_id = $1 and role = 'owner' and status = 'active'`,
          [m.businessId],
        );
        if ((owners.rows[0]?.n ?? 0) <= 1) throw conflict('A workspace must keep at least one active owner', 'last_owner');
      }
      const d = await tx.query('delete from public.business_members where id = $1 returning id', [memberId]);
      if (!d.rows[0]) throw forbidden('You cannot remove this team member');
      return target;
    });
    await writeAudit(deps.db, { businessId: m.businessId, actorUserId: user.sub, action: 'member.removed', targetType: 'business_member', targetId: memberId, metadata: { role: removed.role, userId: removed.user_id }, ...clientInfo(req) });
    res.status(204).end();
  });

  // ---- invitations ---------------------------------------------------------------
  r.get(`${base}/invitations`, auth, member, requirePermission('members.invite_agent'), async (req, res) => {
    const m = currentMembership(req);
    const rows = await withUser(deps.db, currentUser(req), (tx) =>
      tx.query(
        `select i.*, p.full_name as invited_by_name from public.business_invitations i
         left join public.profiles p on p.id = i.invited_by
         where i.business_id = $1 and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
         order by i.created_at desc`,
        [m.businessId],
      ),
    );
    res.json({ data: rows.rows.map(mapInvitation) });
  });

  r.post(`${base}/invitations`, auth, member, requirePermission('members.invite_agent'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const input = parse(inviteMemberSchema, req.body);
    if (!invitableRoles(m.role).includes(input.role)) throw forbidden(`You cannot invite a ${input.role}`);

    // Seat limit (subscription entitlement): active members + pending invitations
    const seats = await deps.db.query<{ limit_value: number | null; used: number }>(
      `select (select limit_value from public.subscription_entitlements where business_id = $1 and key = 'staff_seats') as limit_value,
              (select count(*)::int from public.business_members where business_id = $1 and status = 'active')
            + (select count(*)::int from public.business_invitations where business_id = $1 and accepted_at is null and revoked_at is null and expires_at > now()) as used`,
      [m.businessId],
    );
    const s = seats.rows[0];
    if (s?.limit_value != null && s.used >= Number(s.limit_value))
      throw new HttpError(402, 'seat_limit_reached', `Your plan allows ${s.limit_value} team members. Upgrade to add more.`);

    const existing = await deps.db.query(
      `select 1 from public.business_members bm join public.profiles p on p.id = bm.user_id
       where bm.business_id = $1 and lower(p.email) = lower($2)`,
      [m.businessId, input.email],
    );
    if (existing.rows.length) throw conflict('This person is already a member of the workspace', 'already_member');

    const token = randomToken(32);
    const invitation = await withUser(deps.db, user, async (tx) => {
      const dup = await tx.query(
        `select 1 from public.business_invitations where business_id = $1 and lower(email) = lower($2) and accepted_at is null and revoked_at is null and expires_at > now()`,
        [m.businessId, input.email],
      );
      if (dup.rows.length) throw conflict('An invitation is already pending for this email', 'invitation_pending');
      // Expired-but-unaccepted invitations would block the partial unique index; revoke them first.
      await tx.query(
        `update public.business_invitations set revoked_at = now() where business_id = $1 and lower(email) = lower($2) and accepted_at is null and revoked_at is null`,
        [m.businessId, input.email],
      );
      const ins = await tx.query(
        `insert into public.business_invitations (business_id, email, role, token_hash, invited_by, expires_at)
         values ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) returning *`,
        [m.businessId, input.email, input.role, sha256(token), user.sub, INVITE_TTL_DAYS],
      );
      return ins.rows[0] as any;
    });
    const inviteUrl = `${deps.config.PUBLIC_WEB_URL}/invite/${token}`;
    await deps.mailer.send({
      to: input.email,
      subject: `You're invited to ${m.businessName} on DigiMithra Social Pilot`,
      text: `You have been invited to join ${m.businessName} as ${input.role}. Accept: ${inviteUrl}`,
      link: inviteUrl,
    });
    await writeAudit(deps.db, { businessId: m.businessId, actorUserId: user.sub, action: 'invitation.created', targetType: 'business_invitation', targetId: invitation.id, metadata: { email: input.email, role: input.role }, ...clientInfo(req) });
    // inviteUrl is returned once so the inviter can share it directly (transactional email not yet configured).
    res.status(201).json({ data: { invitation: mapInvitation(invitation), inviteUrl } });
  });

  r.delete(`${base}/invitations/:invitationId`, auth, member, requirePermission('members.invite_agent'), async (req, res) => {
    const m = currentMembership(req);
    const user = currentUser(req);
    const invitationId = String(req.params.invitationId);
    if (!isUuid(invitationId)) throw notFound('Invitation not found');
    const r2 = await withUser(deps.db, user, (tx) =>
      tx.query(
        `update public.business_invitations set revoked_at = now()
         where id = $1 and business_id = $2 and accepted_at is null and revoked_at is null returning id`,
        [invitationId, m.businessId],
      ),
    );
    if (!r2.rows[0]) throw notFound('Invitation not found');
    await writeAudit(deps.db, { businessId: m.businessId, actorUserId: user.sub, action: 'invitation.revoked', targetType: 'business_invitation', targetId: invitationId, ...clientInfo(req) });
    res.status(204).end();
  });

  // ---- invitation acceptance (invitee side) -----------------------------------
  async function findInvitation(token: string) {
    const r2 = await deps.db.query<any>(
      `select i.*, b.name as business_name, b.status as business_status from public.business_invitations i
       join public.businesses b on b.id = i.business_id where i.token_hash = $1`,
      [sha256(token)],
    );
    const inv = r2.rows[0];
    if (!inv || inv.revoked_at || inv.accepted_at || new Date(inv.expires_at).getTime() < Date.now())
      throw new HttpError(410, 'invitation_invalid', 'This invitation is invalid, expired or has already been used');
    return inv;
  }

  r.get('/invitations/:token', auth, async (req, res) => {
    const inv = await findInvitation(String(req.params.token));
    const user = currentUser(req);
    res.json({
      data: {
        businessName: inv.business_name,
        role: inv.role,
        email: inv.email,
        emailMatches: inv.email.toLowerCase() === user.email.toLowerCase(),
        expiresAt: iso(inv.expires_at),
      },
    });
  });

  /** Service operation: the invitee is not yet a member, so RLS cannot authorise this insert. */
  r.post('/invitations/accept', auth, async (req, res) => {
    const user = currentUser(req);
    const { token } = parse(acceptInvitationSchema, req.body);
    const inv = await findInvitation(token);
    if (inv.email.toLowerCase() !== user.email.toLowerCase())
      throw forbidden(`This invitation was sent to ${inv.email}. Sign in with that email to accept it.`);
    if (inv.business_status !== 'active') throw new HttpError(423, 'business_suspended', 'This workspace is suspended');
    const businessId: string = inv.business_id;
    await withService(deps.db, async (tx) => {
      const claimed = await tx.query(
        `update public.business_invitations set accepted_at = now(), accepted_by = $2
         where id = $1 and accepted_at is null and revoked_at is null returning id`,
        [inv.id, user.sub],
      );
      if (!claimed.rows[0]) throw new HttpError(410, 'invitation_invalid', 'This invitation has already been used');
      await tx.query(
        `insert into public.business_members (business_id, user_id, role, invited_by) values ($1, $2, $3, $4)
         on conflict (business_id, user_id) do update set status = 'active'`,
        [businessId, user.sub, inv.role, inv.invited_by],
      );
      await writeAudit(tx, { businessId, actorUserId: user.sub, action: 'invitation.accepted', targetType: 'business_invitation', targetId: inv.id, metadata: { role: inv.role }, ...clientInfo(req) });
    });
    res.json({ data: { businessId, role: inv.role } });
  });

  return r;
}
