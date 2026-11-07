import { bootstrap } from './bootstrap';
import { createApp } from './app';
import { createWorker } from './jobs/worker';

const deps = await bootstrap();
const app = createApp(deps);
const worker = deps.config.WORKER_IN_PROCESS ? createWorker(deps) : null;
worker?.start();
const server = app.listen(deps.config.PORT, () => {
  deps.logger.info(
    { port: deps.config.PORT, env: deps.config.APP_ENV, auth: deps.auth.name, db: deps.db.driver },
    `DigiMithra Social Pilot API listening on :${deps.config.PORT}`,
  );
});

const shutdown = (signal: string) => {
  deps.logger.info({ signal }, 'shutting down');
  server.close(async () => {
    await worker?.stop();
    deps.db.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
