import { loadConfig } from '../config';
import { createDatabase, migrate } from '../db';

const config = loadConfig();
const db = await createDatabase(config);
const applied = await migrate(db, (m) => console.log(m));
console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
await db.close();
process.exit(0);
