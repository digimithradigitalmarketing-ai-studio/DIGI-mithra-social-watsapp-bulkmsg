import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const envSchema = z
  .object({
    APP_ENV: z.enum(['local', 'test', 'staging', 'production']).default('local'),
    PORT: z.coerce.number().int().default(8080),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),

    /** Comma separated list of allowed browser origins. */
    WEB_ORIGINS: z.string().default('http://localhost:5173'),
    /** Used to build links in emails (verify, reset, invitations). */
    PUBLIC_WEB_URL: z.string().url().default('http://localhost:5173'),
    COOKIE_DOMAIN: z.string().optional(),

    DATABASE_DRIVER: z.enum(['pglite', 'pg']).default('pglite'),
    DATABASE_URL: z.string().optional(),
    /** Directory for PGlite data, or "memory" for an in-memory database. */
    PGLITE_DATA_DIR: z.string().default('./.data/pglite'),
    DB_AUTO_MIGRATE: bool.default(true),

    AUTH_PROVIDER: z.enum(['local', 'supabase']).default('local'),
    LOCAL_JWT_SECRET: z.string().min(32).optional(),
    LOCAL_AUTO_VERIFY_EMAIL: bool.default(true),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),

    SUPABASE_URL: z.string().url().optional(),
    SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
    /** Optional legacy HS256 secret; when absent the project's JWKS endpoint is used. */
    SUPABASE_JWT_SECRET: z.string().optional(),

    ADMIN_REQUIRE_MFA: bool.default(true),
    /** base64-encoded 32-byte key for AES-256-GCM encryption of integration credentials */
    INTEGRATION_ENCRYPTION_KEY: z.string().optional(),

    /** Public base URL of this API (shown to users as the Meta webhook callback URL). */
    PUBLIC_API_URL: z.string().url().default('http://localhost:8080'),

    // ---- Meta WhatsApp Cloud API ----
    META_APP_SECRET: z.string().optional(),
    META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
    /** Set to the latest version listed at developers.facebook.com/docs/graph-api/changelog */
    META_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v23.0'),
    META_GRAPH_BASE_URL: z.string().url().default('https://graph.facebook.com'),
    /** Allow the mock WhatsApp provider (development/staging demos). Never sends real messages. */
    ALLOW_MOCK_WHATSAPP: bool.default(true),

    // ---- AI (Phase 5) ----
    /** gemini = Google Gemini API; mock = deterministic local answers from the knowledge base (dev/tests); disabled = AI off. */
    AI_PROVIDER: z.enum(['gemini', 'mock', 'disabled']).default('mock'),
    GEMINI_API_KEY: z.string().optional(),
    /** Set to a current model id from ai.google.dev/gemini-api/docs/models */
    GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
    GEMINI_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com'),
    /** Cost estimates for usage/spend limits, in paise per 1,000 tokens (configure to match your Google billing). */
    AI_INPUT_COST_PAISE_PER_1K: z.coerce.number().min(0).default(3),
    AI_OUTPUT_COST_PAISE_PER_1K: z.coerce.number().min(0).default(25),

    // ---- Billing (Phase 6) ----
    /** mock = no network and no money moves (dev, tests, demos); razorpay = live Razorpay Subscriptions API. */
    BILLING_PROVIDER: z.enum(['mock', 'razorpay']).default('mock'),
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
    RAZORPAY_BASE_URL: z.string().url().default('https://api.razorpay.com'),

    // ---- Background worker ----
    /** Run the job worker inside the API process (required with PGlite; use a separate worker in production). */
    WORKER_IN_PROCESS: bool.default(true),
    WORKER_POLL_MS: z.coerce.number().int().min(50).max(60_000).default(1000),
    WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(25),
    CAMPAIGN_SEND_RATE_PER_SECOND: z.coerce.number().min(0.1).max(500).default(20),
    JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    JOB_RETRY_BASE_SECONDS: z.coerce.number().min(0).max(3600).default(15),
  })
  .superRefine((env, ctx) => {
    const prodLike = env.APP_ENV === 'production' || env.APP_ENV === 'staging';
    if (prodLike && env.AUTH_PROVIDER !== 'supabase')
      ctx.addIssue({ code: 'custom', path: ['AUTH_PROVIDER'], message: 'must be "supabase" in staging/production' });
    if (prodLike && env.DATABASE_DRIVER !== 'pg')
      ctx.addIssue({ code: 'custom', path: ['DATABASE_DRIVER'], message: 'must be "pg" in staging/production' });
    if (prodLike && !env.ADMIN_REQUIRE_MFA)
      ctx.addIssue({ code: 'custom', path: ['ADMIN_REQUIRE_MFA'], message: 'must be true in staging/production' });
    if (prodLike && !env.INTEGRATION_ENCRYPTION_KEY)
      ctx.addIssue({ code: 'custom', path: ['INTEGRATION_ENCRYPTION_KEY'], message: 'required in staging/production' });
    if (prodLike && env.WORKER_IN_PROCESS && env.APP_ENV === 'production')
      ctx.addIssue({ code: 'custom', path: ['WORKER_IN_PROCESS'], message: 'must be false in production (run the dedicated worker service)' });
    if (env.APP_ENV === 'production' && env.ALLOW_MOCK_WHATSAPP)
      ctx.addIssue({ code: 'custom', path: ['ALLOW_MOCK_WHATSAPP'], message: 'must be false in production' });
    if (env.APP_ENV === 'production' && env.AI_PROVIDER === 'mock')
      ctx.addIssue({ code: 'custom', path: ['AI_PROVIDER'], message: 'must be gemini or disabled in production' });
    if (env.AI_PROVIDER === 'gemini' && !env.GEMINI_API_KEY)
      ctx.addIssue({ code: 'custom', path: ['GEMINI_API_KEY'], message: 'required when AI_PROVIDER=gemini' });
    if (env.APP_ENV === 'production' && env.BILLING_PROVIDER === 'mock')
      ctx.addIssue({ code: 'custom', path: ['BILLING_PROVIDER'], message: 'must be razorpay in production' });
    if (env.BILLING_PROVIDER === 'razorpay' && (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET || !env.RAZORPAY_WEBHOOK_SECRET))
      ctx.addIssue({ code: 'custom', path: ['RAZORPAY_KEY_ID'], message: 'RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET are required when BILLING_PROVIDER=razorpay' });
    if (env.DATABASE_DRIVER === 'pg' && !env.DATABASE_URL)
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'required when DATABASE_DRIVER=pg' });
    if (env.AUTH_PROVIDER === 'local' && !env.LOCAL_JWT_SECRET)
      ctx.addIssue({ code: 'custom', path: ['LOCAL_JWT_SECRET'], message: 'required (>=32 chars) when AUTH_PROVIDER=local' });
    if (env.AUTH_PROVIDER === 'supabase' && (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY))
      ctx.addIssue({ code: 'custom', path: ['SUPABASE_URL'], message: 'SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required when AUTH_PROVIDER=supabase' });
  });

export type AppConfig = z.infer<typeof envSchema> & { webOrigins: string[]; isProdLike: boolean };

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  // Treat empty strings (e.g. `SUPABASE_URL=` in .env) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${lines}`);
  }
  const c = parsed.data;
  return {
    ...c,
    webOrigins: c.WEB_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    isProdLike: c.APP_ENV === 'production' || c.APP_ENV === 'staging',
  };
}
