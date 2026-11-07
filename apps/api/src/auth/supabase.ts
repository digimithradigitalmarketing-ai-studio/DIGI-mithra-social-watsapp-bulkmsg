import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { HttpError, unauthorized } from '../lib/errors';
import type { AuthProvider, IssuedSession, VerifiedToken } from './provider';

/**
 * Supabase Auth (GoTrue) provider — used in staging/production.
 * Talks to the documented GoTrue REST endpoints under {SUPABASE_URL}/auth/v1.
 *
 * STATUS: implemented against Supabase's public API but NOT yet verified
 * against a live project (no credentials were available while building).
 * Run the "Supabase smoke test" in docs/DEPLOYMENT.md before go-live.
 */
export function createSupabaseAuthProvider(o: { url: string; publishableKey: string; jwtSecret?: string; publicWebUrl: string }): AuthProvider {
  const base = `${o.url.replace(/\/$/, '')}/auth/v1`;
  const jwks = createRemoteJWKSet(new URL(`${base}/.well-known/jwks.json`));
  const hsKey = o.jwtSecret ? new TextEncoder().encode(o.jwtSecret) : null;

  async function call<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'POST',
      headers: {
        apikey: o.publishableKey,
        'content-type': 'application/json',
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const code: string = json.error_code ?? json.code ?? json.error ?? 'auth_error';
      const message: string = json.msg ?? json.message ?? json.error_description ?? 'Authentication failed';
      if (code === 'invalid_credentials' || (res.status === 400 && /invalid login/i.test(message)))
        throw new HttpError(401, 'invalid_credentials', 'Incorrect email or password');
      if (code === 'email_not_confirmed') throw new HttpError(403, 'email_not_verified', 'Please verify your email address before signing in');
      if (code === 'user_already_exists' || code === 'email_exists') throw new HttpError(409, 'email_taken', 'An account with this email already exists');
      if (code === 'weak_password') throw new HttpError(422, 'weak_password', message);
      if (res.status === 429) throw new HttpError(429, 'rate_limited', 'Too many attempts. Please wait and try again.');
      if (res.status === 401 || res.status === 403) throw unauthorized(message);
      throw new HttpError(res.status >= 500 ? 502 : 400, code, message);
    }
    return json as T;
  }

  interface GoTrueSession {
    access_token: string;
    refresh_token: string;
    expires_at?: number;
    expires_in: number;
    user: { id: string; email: string; email_confirmed_at?: string | null };
  }

  async function toSession(s: GoTrueSession): Promise<IssuedSession> {
    const claims = await verify(s.access_token);
    return {
      accessToken: s.access_token,
      refreshToken: s.refresh_token,
      expiresAt: s.expires_at ?? Math.floor(Date.now() / 1000) + s.expires_in,
      aal: claims.aal,
      user: { id: s.user.id, email: s.user.email, emailVerified: !!s.user.email_confirmed_at },
    };
  }

  async function verify(token: string): Promise<VerifiedToken> {
    let payload: JWTPayload;
    try {
      const opts = { issuer: base, audience: 'authenticated' };
      payload = hsKey ? (await jwtVerify(token, hsKey, opts)).payload : (await jwtVerify(token, jwks, opts)).payload;
    } catch {
      throw unauthorized('Session expired. Please sign in again.');
    }
    if (!payload.sub || typeof payload.email !== 'string') throw unauthorized();
    // Supabase only issues sessions to confirmed users when email confirmation is enabled.
    return { sub: payload.sub, email: payload.email, aal: payload.aal === 'aal2' ? 'aal2' : 'aal1', emailVerified: true };
  }

  const redirect = (path: string) => `?redirect_to=${encodeURIComponent(o.publicWebUrl + path)}`;

  return {
    name: 'supabase',

    async signUp({ email, password, fullName }) {
      const r = await call<Partial<GoTrueSession> & { id?: string; user?: { id: string } }>(`/signup${redirect('/verify-email')}`, {
        body: { email, password, data: { full_name: fullName } },
      });
      if (r.access_token && r.refresh_token && r.user)
        return { userId: r.user.id, session: await toSession(r as GoTrueSession), emailVerificationRequired: false };
      return { userId: r.id ?? r.user?.id ?? null, session: null, emailVerificationRequired: true };
    },

    async signIn(email, password) {
      return toSession(await call<GoTrueSession>('/token?grant_type=password', { body: { email, password } }));
    },

    async refresh(refreshToken) {
      return toSession(await call<GoTrueSession>('/token?grant_type=refresh_token', { body: { refresh_token: refreshToken } }));
    },

    async signOut(accessToken) {
      if (accessToken) await call('/logout', { token: accessToken }).catch(() => undefined);
    },

    verifyAccessToken: verify,

    async verifyEmail() {
      // Supabase verifies the email itself when the user clicks the link it sent.
    },

    async requestPasswordReset(email) {
      await call(`/recover${redirect('/reset-password')}`, { body: { email } }).catch((err) => {
        if (err instanceof HttpError && err.status === 429) throw err; // other failures are hidden to avoid account enumeration
      });
    },

    async resetPassword(recoveryAccessToken, newPassword) {
      await verify(recoveryAccessToken);
      await call('/user', { method: 'PUT', token: recoveryAccessToken, body: { password: newPassword } });
    },

    async mfaEnroll(accessToken) {
      const r = await call<{ id: string; totp: { secret: string; uri: string } }>('/factors', {
        token: accessToken,
        body: { factor_type: 'totp', friendly_name: `Authenticator ${new Date().toISOString().slice(0, 10)}` },
      });
      return { factorId: r.id, secret: r.totp.secret, otpauthUrl: r.totp.uri };
    },

    async mfaVerify(accessToken, _user, factorId, code) {
      const challenge = await call<{ id: string }>(`/factors/${encodeURIComponent(factorId)}/challenge`, { token: accessToken, body: {} });
      const s = await call<GoTrueSession>(`/factors/${encodeURIComponent(factorId)}/verify`, {
        token: accessToken,
        body: { challenge_id: challenge.id, code },
      });
      return toSession(s);
    },

    async mfaFactors(accessToken) {
      const u = await call<{ factors?: Array<{ id: string; status: string }> }>('/user', { method: 'GET', token: accessToken });
      return (u.factors ?? []).map((f) => ({ id: f.id, verified: f.status === 'verified' }));
    },
  };
}
