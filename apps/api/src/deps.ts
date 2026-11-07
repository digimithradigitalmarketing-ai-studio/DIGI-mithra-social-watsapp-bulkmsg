import type { AppConfig } from './config';
import type { Database } from './db';
import type { AuthProvider } from './auth/provider';
import type { Mailer } from './auth/mailer';
import type { Logger } from './lib/logger';
import { createLocalAuthProvider } from './auth/local';
import { createSupabaseAuthProvider } from './auth/supabase';

export interface Deps {
  config: AppConfig;
  db: Database;
  auth: AuthProvider;
  mailer: Mailer;
  logger: Logger;
}

export function createAuthProvider(config: AppConfig, db: Database, mailer: Mailer): AuthProvider {
  if (config.AUTH_PROVIDER === 'supabase') {
    return createSupabaseAuthProvider({
      url: config.SUPABASE_URL!,
      publishableKey: config.SUPABASE_PUBLISHABLE_KEY!,
      jwtSecret: config.SUPABASE_JWT_SECRET,
      publicWebUrl: config.PUBLIC_WEB_URL,
    });
  }
  return createLocalAuthProvider({
    db,
    mailer,
    jwtSecret: config.LOCAL_JWT_SECRET!,
    accessTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
    refreshTtlDays: config.REFRESH_TOKEN_TTL_DAYS,
    autoVerifyEmail: config.LOCAL_AUTO_VERIFY_EMAIL,
    publicWebUrl: config.PUBLIC_WEB_URL,
    bcryptRounds: config.APP_ENV === 'test' ? 4 : 12,
  });
}
