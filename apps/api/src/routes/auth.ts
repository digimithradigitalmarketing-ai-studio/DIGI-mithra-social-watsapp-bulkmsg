import { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  forgotPasswordSchema,
  loginSchema,
  mfaVerifySchema,
  resetPasswordSchema,
  signupSchema,
  type SessionDto,
} from '@socialpilot/shared';
import { z } from 'zod';
import type { Deps } from '../deps';
import type { IssuedSession } from '../auth/provider';
import { HttpError, forbidden, unauthorized } from '../lib/errors';
import { clientInfo, parse } from '../lib/http';
import { writeAudit } from '../lib/audit';
import { currentUser, requireAuth } from '../middleware/auth';

export const REFRESH_COOKIE = 'sp_rt';
const COOKIE_PATH = '/v1/auth';

export function authRouter(deps: Deps): Router {
  const r = Router();
  const { config } = deps;
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.APP_ENV === 'test' ? 10_000 : 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'rate_limited', message: 'Too many attempts. Please wait a few minutes and try again.' } },
  });

  const setRefreshCookie = (res: Response, token: string) =>
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: config.isProdLike,
      sameSite: 'strict',
      path: COOKIE_PATH,
      domain: config.COOKIE_DOMAIN || undefined,
      maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86400 * 1000,
    });
  const clearRefreshCookie = (res: Response) =>
    res.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH, domain: config.COOKIE_DOMAIN || undefined });

  const toDto = (s: IssuedSession): SessionDto => ({ accessToken: s.accessToken, expiresAt: s.expiresAt, user: s.user, aal: s.aal });

  /** Cookie-authenticated endpoints need CSRF protection: custom header (forces CORS preflight) + Origin allow-list. */
  const assertCsrf = (req: Request) => {
    if (req.get('x-requested-with') !== 'socialpilot') throw forbidden('Missing CSRF header');
    const origin = req.get('origin');
    if (origin && !config.webOrigins.includes(origin)) throw forbidden('Origin not allowed');
  };

  r.post('/signup', limiter, async (req, res) => {
    const input = parse(signupSchema, req.body);
    const setting = await deps.db.query<{ value: unknown }>(`select value from public.system_settings where key = 'signups_enabled'`);
    if (setting.rows[0]?.value === false) throw new HttpError(403, 'signups_disabled', 'New registrations are temporarily closed');
    const result = await deps.auth.signUp({ email: input.email, password: input.password, fullName: input.fullName });
    if (result.userId) {
      await writeAudit(deps.db, { actorUserId: null, actorType: 'system', action: 'auth.signup', targetType: 'user', targetId: result.userId, metadata: { email: input.email }, ...clientInfo(req) });
    }
    if (result.session) setRefreshCookie(res, result.session.refreshToken);
    res.status(201).json({ data: { session: result.session ? toDto(result.session) : null, emailVerificationRequired: result.emailVerificationRequired } });
  });

  r.post('/login', limiter, async (req, res) => {
    const input = parse(loginSchema, req.body);
    const session = await deps.auth.signIn(input.email, input.password);
    setRefreshCookie(res, session.refreshToken);
    res.json({ data: toDto(session) });
  });

  r.post('/refresh', async (req, res) => {
    assertCsrf(req);
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) throw unauthorized('No active session');
    try {
      const session = await deps.auth.refresh(token);
      setRefreshCookie(res, session.refreshToken);
      res.json({ data: toDto(session) });
    } catch (err) {
      clearRefreshCookie(res);
      throw err;
    }
  });

  r.post('/logout', async (req, res) => {
    assertCsrf(req);
    const bearer = /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '')?.[1] ?? null;
    await deps.auth.signOut(bearer, req.cookies?.[REFRESH_COOKIE] ?? null);
    clearRefreshCookie(res);
    res.status(204).end();
  });

  r.post('/verify-email', limiter, async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(4096) }), req.body);
    await deps.auth.verifyEmail(token);
    res.json({ data: { verified: true } });
  });

  r.post('/forgot-password', limiter, async (req, res) => {
    const { email } = parse(forgotPasswordSchema, req.body);
    await deps.auth.requestPasswordReset(email);
    res.status(202).json({ data: { message: 'If an account exists for this email, a reset link has been sent.' } });
  });

  r.post('/reset-password', limiter, async (req, res) => {
    const input = parse(resetPasswordSchema, req.body);
    await deps.auth.resetPassword(input.token, input.password);
    clearRefreshCookie(res);
    res.json({ data: { reset: true } });
  });

  // ---- MFA (TOTP) ---------------------------------------------------------
  const auth = requireAuth(deps);

  r.get('/mfa/factors', auth, async (req, res) => {
    res.json({ data: await deps.auth.mfaFactors(req.accessToken!, currentUser(req)) });
  });

  r.post('/mfa/enroll', auth, async (req, res) => {
    const enrollment = await deps.auth.mfaEnroll(req.accessToken!, currentUser(req));
    res.status(201).json({ data: enrollment });
  });

  r.post('/mfa/verify', limiter, auth, async (req, res) => {
    const input = parse(mfaVerifySchema, req.body);
    const user = currentUser(req);
    const session = await deps.auth.mfaVerify(req.accessToken!, user, input.factorId, input.code);
    await writeAudit(deps.db, { actorUserId: user.sub, action: 'auth.mfa_verified', targetType: 'user', targetId: user.sub, ...clientInfo(req) });
    setRefreshCookie(res, session.refreshToken);
    res.json({ data: toDto(session) });
  });

  return r;
}
