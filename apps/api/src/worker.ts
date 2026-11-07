/** Dedicated background worker process (production: Render Background Worker with DATABASE_DRIVER=pg). */
import { bootstrap } from './bootstrap';
import { createWorker } from './jobs/worker';

const deps = await bootstrap({ DB_AUTO_MIGRATE: 'false' });
const worker = createWorker(deps);
worker.start();
const shutdown = async () => {
  await worker.stop();
  await deps.db.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
