import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import * as OTPAuth from 'otpauth';
import type { Database } from '../db';
import { HttpError, conflict, unauthorized } from '../lib/errors';
import { randomToken, sha256 } from '../lib/crypto';
import type { Mailer } from './mailer';
import type { AuthProvider, IssuedSession, VerifiedToken } from './provider';

interface LocalOptions {
  db: Database;
  mailer: Mailer;
  jwtSecret: string;
  accessTtlSeconds: number;
  refreshTtlDays: number;
  autoVerifyEmail: boolean;
  publicWebUrl: string;
  bcryptRounds: number;
}

const ISSUER = 'socialpilot-local';
const AUDIENCE = 'authenticated';

interface UserRow {
  id: string;
  email: string;
  encrypted_password: string | null;
  email_confirmed_at: Date | null;
}

/**
 * Local authentication for development and automated tests.
 * Issues JWTs with the same claim shape Supabase uses (sub, email, role, aal).
 * Refuses to load in staging/production (see config.ts).
 */
export function createLocalAuthProvider(o: LocalOptions): AuthProvider {
  const key = new TextEncoder().encode(o.jwtSecret);

  async function issue(user: UserRow, aal: 'aal1' | 'aal2'): Promise<IssuedSession> {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + o.accessTtlSeconds;
    const accessToken = await new SignJWT({ email: user.email, role: 'authenticated', aal, email_verified: !!user.email_confirmed_at })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(expiresAt)
      .sign(key);
    const refreshToken = randomToken(32);
    await o.db.query(
      `insert into auth.local_tokens (user_id, kind, token_hash, meta, expires_at)
       values ($1, 'refresh', $2, $3, now() + make_interval(days => $4))`,
      [user.id, sha256(refreshToken), JSON.stringify({ aal }), o.refreshTtlDays],
    );
    await o.db.query('update auth.users set last_sign_in_at = now() where id = $1', [user.id]);
    return { accessToken, refreshToken, expiresAt, aal, user: { id: user.id, email: user.email, emailVerified: !!user.email_confirmed_at } };
  }

  async function createOneTimeToken(userId: string, kind: 'verify_email' | 'reset_password', hours: number) {
    const token = randomToken(32);
    await o.db.query(
      `insert into auth.local_tokens (user_id, kind, token_hash, expires_at) values ($1, $2, $3, now() + make_interval(hours => $4))`,
      [userId, kind, sha256(token), hours],
    );
    return token;
  }

  async function consumeOneTimeToken(token: string, kind: string): Promise<string> {
    const r = await o.db.query<{ user_id: string }>(
      `update auth.local_tokens set used_at = now()
       where token_hash = $1 and kind = $2 and used_at is null and expires_at > now()
       returning user_id`,
      [sha256(token), kind],
    );
    if (!r.rows[0]) throw new HttpError(400, 'invalid_token', 'This link is invalid or has expired');
    return r.rows[0].user_id;
  }

  async function userById(id: string) {
    const r = await o.db.query<UserRow>('select id, email, encrypted_password, email_confirmed_at from auth.users where id = $1', [id]);
    return r.rows[0] ?? null;
  }

  const totpFor = (email: string, secret: string) =>
    new OTPAuth.TOTP({ issuer: 'DigiMithra Social Pilot', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });

  return {
    name: 'local',

    async signUp({ email, password, fullName }) {
      const existing = await o.db.query('select 1 from auth.users where lower(email) = lower($1)', [email]);
      if (existing.rows.length) throw conflict('An account with this email already exists', 'email_taken');
      const hash = await bcrypt.hash(password, o.bcryptRounds);
      const r = await o.db.query<UserRow>(
        `insert into auth.users (email, encrypted_password, email_confirmed_at, raw_user_meta_data)
         values ($1, $2, $3, $4) returning id, email, encrypted_password, email_confirmed_at`,
        [email, hash, o.autoVerifyEmail ? new Date() : null, JSON.stringify({ full_name: fullName })],
      );
      const user = r.rows[0]!;
      if (o.autoVerifyEmail) return { userId: user.id, session: await issue(user, 'aal1'), emailVerificationRequired: false };
      const token = await createOneTimeToken(user.id, 'verify_email', 48);
      const link = `${o.publicWebUrl}/verify-email?token=${token}`;
      await o.mailer.send({ to: email, subject: 'Verify your DigiMithra Social Pilot email', text: `Confirm your email: ${link}`, link });
      return { userId: user.id, session: null, emailVerificationRequired: true };
    },

    async signIn(email, password) {
      const r = await o.db.query<UserRow>(
        'select id, email, encrypted_password, email_confirmed_at from auth.users where lower(email) = lower($1)',
        [email],
      );
      const user = r.rows[0];
      // Always run bcrypt to keep timing similar for unknown emails.
      const ok = await bcrypt.compare(password, user?.encrypted_password ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
      if (!user || !ok) throw new HttpError(401, 'invalid_credentials', 'Incorrect email or password');
      if (!user.email_confirmed_at) throw new HttpError(403, 'email_not_verified', 'Please verify your email address before signing in');
      return issue(user, 'aal1');
    },

    async refresh(refreshToken) {
      const hash = sha256(refreshToken);
      const r = await o.db.query<{ id: string; user_id: string; used_at: Date | null; expires_at: Date; meta: { aal?: 'aal1' | 'aal2' } }>(
        `select id, user_id, used_at, expires_at, meta from auth.local_tokens where token_hash = $1 and kind = 'refresh'`,
        [hash],
      );
      const row = r.rows[0];
      if (!row) throw unauthorized('Session expired. Please sign in again.');
      if (row.used_at) {
        // Reuse of a rotated refresh token => possible theft. Revoke every session for this user.
        await o.db.query(`update auth.local_tokens set used_at = now() where user_id = $1 and kind = 'refresh' and used_at is null`, [row.user_id]);
        throw unauthorized('Session expired. Please sign in again.');
      }
      if (new Date(row.expires_at).getTime() < Date.now()) throw unauthorized('Session expired. Please sign in again.');
      await o.db.query('update auth.local_tokens set used_at = now() where id = $1', [row.id]);
      const user = await userById(row.user_id);
      if (!user) throw unauthorized();
      return issue(user, row.meta?.aal === 'aal2' ? 'aal2' : 'aal1');
    },

    async signOut(_accessToken, refreshToken) {
      if (refreshToken) await o.db.query('update auth.local_tokens set used_at = now() where token_hash = $1 and used_at is null', [sha256(refreshToken)]);
    },

    async verifyAccessToken(token) {
      try {
        const { payload } = await jwtVerify(token, key, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] });
        if (!payload.sub || typeof payload.email !== 'string') throw new Error('bad claims');
        return { sub: payload.sub, email: payload.email, aal: payload.aal === 'aal2' ? 'aal2' : 'aal1', emailVerified: payload.email_verified === true };
      } catch {
        throw unauthorized('Session expired. Please sign in again.');
      }
    },

    async verifyEmail(token) {
      const userId = await consumeOneTimeToken(token, 'verify_email');
      await o.db.query('update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = $1', [userId]);
    },

    async requestPasswordReset(email) {
      const r = await o.db.query<{ id: string }>('select id from auth.users where lower(email) = lower($1)', [email]);
      if (!r.rows[0]) return; // do not reveal whether the account exists
      const token = await createOneTimeToken(r.rows[0].id, 'reset_password', 1);
      const link = `${o.publicWebUrl}/reset-password?token=${token}`;
      await o.mailer.send({ to: email, subject: 'Reset your DigiMithra Social Pilot password', text: `Reset your password: ${link}`, link });
    },

    async resetPassword(token, newPassword) {
      const userId = await consumeOneTimeToken(token, 'reset_password');
      const hash = await bcrypt.hash(newPassword, o.bcryptRounds);
      await o.db.query('update auth.users set encrypted_password = $2, updated_at = now() where id = $1', [userId, hash]);
      await o.db.query(`update auth.local_tokens set used_at = now() where user_id = $1 and kind = 'refresh' and used_at is null`, [userId]);
    },

    async mfaEnroll(_accessToken, user) {
      const verified = await o.db.query('select 1 from auth.local_mfa_factors where user_id = $1 and verified_at is not null', [user.sub]);
      if (verified.rows.length) throw conflict('An authenticator app is already set up for this account', 'mfa_already_enrolled');
      await o.db.query('delete from auth.local_mfa_factors where user_id = $1 and verified_at is null', [user.sub]);
      const secret = new OTPAuth.Secret({ size: 20 }).base32;
      const r = await o.db.query<{ id: string }>('insert into auth.local_mfa_factors (user_id, secret) values ($1, $2) returning id', [user.sub, secret]);
      return { factorId: r.rows[0]!.id, secret, otpauthUrl: totpFor(user.email, secret).toString() };
    },

    async mfaVerify(_accessToken, user, factorId, code) {
      const r = await o.db.query<{ id: string; secret: string }>('select id, secret from auth.local_mfa_factors where id = $1 and user_id = $2', [factorId, user.sub]);
      const factor = r.rows[0];
      if (!factor) throw new HttpError(400, 'invalid_factor', 'Authenticator not found. Start setup again.');
      if (totpFor(user.email, factor.secret).validate({ token: code, window: 1 }) === null)
        throw new HttpError(400, 'invalid_mfa_code', 'That code is incorrect or expired');
      await o.db.query('update auth.local_mfa_factors set verified_at = coalesce(verified_at, now()) where id = $1', [factor.id]);
      const u = await userById(user.sub);
      if (!u) throw unauthorized();
      return issue(u, 'aal2');
    },

    async mfaFactors(_accessToken, user) {
      const r = await o.db.query<{ id: string; verified_at: Date | null }>('select id, verified_at from auth.local_mfa_factors where user_id = $1', [user.sub]);
      return r.rows.map((f) => ({ id: f.id, verified: !!f.verified_at }));
    },
  };
}
