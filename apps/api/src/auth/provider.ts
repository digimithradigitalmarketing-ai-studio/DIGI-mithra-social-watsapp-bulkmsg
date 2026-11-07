import type { UserClaims } from '../db/context';

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch seconds
  user: { id: string; email: string; emailVerified: boolean };
  aal: 'aal1' | 'aal2';
}

export interface VerifiedToken extends UserClaims {
  emailVerified: boolean;
}

export interface MfaEnrollment {
  factorId: string;
  secret: string;
  otpauthUrl: string;
}

/**
 * Auth facade.  The browser only ever talks to our API; the provider decides
 * whether credentials live in Supabase Auth (staging/production) or in the
 * local shim tables (development and automated tests).
 */
export interface AuthProvider {
  readonly name: 'local' | 'supabase';
  signUp(input: { email: string; password: string; fullName: string }): Promise<{
    userId: string | null;
    session: IssuedSession | null;
    emailVerificationRequired: boolean;
  }>;
  signIn(email: string, password: string): Promise<IssuedSession>;
  refresh(refreshToken: string): Promise<IssuedSession>;
  signOut(accessToken: string | null, refreshToken: string | null): Promise<void>;
  verifyAccessToken(token: string): Promise<VerifiedToken>;
  verifyEmail(token: string): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  /** token is the local reset token, or the Supabase recovery access token from the email link */
  resetPassword(token: string, newPassword: string): Promise<void>;
  mfaEnroll(accessToken: string, user: VerifiedToken): Promise<MfaEnrollment>;
  mfaVerify(accessToken: string, user: VerifiedToken, factorId: string, code: string): Promise<IssuedSession>;
  mfaFactors(accessToken: string, user: VerifiedToken): Promise<Array<{ id: string; verified: boolean }>>;
}
