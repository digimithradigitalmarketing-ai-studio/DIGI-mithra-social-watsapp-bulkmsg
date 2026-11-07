import { loadConfig, type AppConfig } from './config';
import { createDatabase, migrate } from './db';
import { createConsoleMailer } from './auth/mailer';
import { createLogger } from './lib/logger';
import { createAuthProvider, type Deps } from './deps';

export async function bootstrap(overrides: Partial<Record<string, string>> = {}): Promise<Deps> {
  const config: AppConfig = loadConfig({ ...process.env, ...overrides });
  const logger = createLogger(config.APP_ENV === 'test' && !process.env.TEST_LOGS ? 'silent' : config.LOG_LEVEL);
  const db = await createDatabase(config);
  if (config.DB_AUTO_MIGRATE) await migrate(db, (m) => logger.info(m));
  const mailer = createConsoleMailer(logger);
  const auth = createAuthProvider(config, db, mailer);
  return { config, db, auth, mailer, logger };
}
