import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import type { Deps } from './deps';
import { HttpError } from './lib/errors';
import { findSupabaseDir } from './db';
import { authRouter } from './routes/auth';
import { businessesRouter } from './routes/businesses';
import { membersRouter } from './routes/members';
import { dashboardRouter } from './routes/dashboard';
import { adminRouter } from './routes/admin';
import { channelsRouter } from './routes/channels';
import { contactsRouter } from './routes/contacts';
import { templatesRouter } from './routes/templates';
import { campaignsRouter } from './routes/campaigns';
import { webhooksRouter } from './routes/webhooks';
import { inboxRouter } from './routes/inbox';
import { crmRouter } from './routes/crm';
import { automationRouter } from './routes/automation';
import { aiRouter } from './routes/ai';
import { billingRouter } from './routes/billing';
import { integrationsRouter } from './routes/integrations';

export function createApp(deps: Deps) {
  const { config, logger } = deps;
  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY) app.set('trust proxy', config.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = (req.headers['x-request-id'] as string | undefined)?.slice(0, 64) || crypto.randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: config.APP_ENV !== 'test',
      // Keep request logs small and free of headers/cookies.
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url.split('?')[0] }),
        res: (res: { statusCode: number }) => ({ status: res.statusCode }),
      },
    }),
  );
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || config.webOrigins.includes(origin)),
      credentials: true,
      allowedHeaders: ['authorization', 'content-type', 'x-requested-with', 'x-request-id'],
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
      maxAge: 600,
    }),
  );
  // Keep the raw body for webhook signature verification; allow larger bodies for CSV imports.
  app.use(express.json({ limit: '6mb', verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(cookieParser());

  app.get('/health', async (_req, res) => {
    let db = 'ok';
    try {
      await deps.db.query('select 1');
    } catch {
      db = 'error';
    }
    res.status(db === 'ok' ? 200 : 503).json({ status: db === 'ok' ? 'ok' : 'degraded', db, env: config.APP_ENV, auth: deps.auth.name });
  });

  app.get('/openapi.yaml', (_req, res) => {
    const file = path.join(path.dirname(findSupabaseDir()), 'apps', 'api', 'openapi.yaml');
    res.type('text/yaml').send(fs.readFileSync(file, 'utf8'));
  });

  app.use('/v1/auth', authRouter(deps));
  app.use('/v1', businessesRouter(deps));
  app.use('/v1', membersRouter(deps));
  app.use('/v1', dashboardRouter(deps));
  app.use('/v1/admin', adminRouter(deps));
  app.use('/v1', channelsRouter(deps));
  app.use('/v1', contactsRouter(deps));
  app.use('/v1', templatesRouter(deps));
  app.use('/v1', campaignsRouter(deps));
  app.use('/v1', inboxRouter(deps));
  app.use('/v1', crmRouter(deps));
  app.use('/v1', automationRouter(deps));
  app.use('/v1', aiRouter(deps));
  app.use('/v1', billingRouter(deps));
  app.use('/v1', integrationsRouter(deps));
  app.use('/v1/webhooks', webhooksRouter(deps));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
  });

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    const requestId = String(req.id ?? '');
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details, requestId } });
      return;
    }
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON', requestId } });
      return;
    }
    // Postgres errors
    if (err?.code === '23505') {
      res.status(409).json({ error: { code: 'duplicate', message: 'This record already exists', requestId } });
      return;
    }
    if (err?.code === '42501') {
      // RLS / privilege violation: the API layer should have caught this first; log it loudly.
      logger.warn({ err, requestId }, 'database denied access (RLS)');
      res.status(403).json({ error: { code: 'forbidden', message: 'You do not have permission to do this', requestId } });
      return;
    }
    logger.error({ err, requestId }, 'unhandled error');
    res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong. Please try again.', requestId } });
  };
  app.use(errorHandler);

  return app;
}
