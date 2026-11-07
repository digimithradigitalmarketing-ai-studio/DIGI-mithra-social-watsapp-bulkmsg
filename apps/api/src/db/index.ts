import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../config';

export interface QueryResult<T> {
  rows: T[];
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Database extends Queryable {
  /** Run a multi-statement SQL script (no parameters). */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly driver: 'pglite' | 'pg';
}

async function createPglite(dataDir: string | undefined): Promise<Database> {
  const { PGlite } = await import('@electric-sql/pglite');
  const inMemory = !dataDir || dataDir === 'memory';
  if (!inMemory) fs.mkdirSync(dataDir, { recursive: true });
  const db = await PGlite.create(inMemory ? undefined : dataDir);
  return {
    driver: 'pglite',
    query: async <T>(sql: string, params?: unknown[]) => {
      const r = await db.query<T>(sql, params as unknown[] | undefined);
      return { rows: r.rows };
    },
    exec: async (sql) => {
      await db.exec(sql);
    },
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          query: async <T>(sql: string, params?: unknown[]) => {
            const r = await tx.query<T>(sql, params as unknown[] | undefined);
            return { rows: r.rows };
          },
        }),
      ),
    close: () => db.close(),
  };
}

async function createPg(url: string): Promise<Database> {
  const pg = await import('pg');
  // Return int8/numeric as JS numbers for counts and money in paise (all well below 2^53).
  pg.default.types.setTypeParser(20, (v: string) => Number(v));
  pg.default.types.setTypeParser(1700, (v: string) => Number(v));
  const pool = new pg.default.Pool({ connectionString: url, max: 10, ssl: url.includes('localhost') ? undefined : { rejectUnauthorized: false } });
  return {
    driver: 'pg',
    query: async <T>(sql: string, params?: unknown[]) => {
      const r = await pool.query(sql, params);
      return { rows: r.rows as T[] };
    },
    exec: async (sql) => {
      await pool.query(sql);
    },
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await fn({
          query: async <T>(sql: string, params?: unknown[]) => {
            const r = await client.query(sql, params);
            return { rows: r.rows as T[] };
          },
        });
        await client.query('commit');
        return result;
      } catch (err) {
        await client.query('rollback').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function createDatabase(config: Pick<AppConfig, 'DATABASE_DRIVER' | 'DATABASE_URL' | 'PGLITE_DATA_DIR'>): Promise<Database> {
  if (config.DATABASE_DRIVER === 'pg') return createPg(config.DATABASE_URL!);
  return createPglite(config.PGLITE_DATA_DIR);
}

/** Locate the repository's supabase/ directory from either src/ or dist/. */
export function findSupabaseDir(): string {
  if (process.env.SUPABASE_DIR) return process.env.SUPABASE_DIR;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'supabase', 'migrations');
    if (fs.existsSync(candidate)) return path.join(dir, 'supabase');
    dir = path.dirname(dir);
  }
  throw new Error('Could not locate supabase/migrations. Set SUPABASE_DIR.');
}

/**
 * Applies SQL migrations in order and records them in app_meta.schema_migrations.
 * For local PGlite it first applies supabase/local/*.sql (auth shim).
 * For hosted Supabase prefer `supabase db push`; this runner is safe to use too
 * (it never applies the local shim to a pg database).
 */
export async function migrate(db: Database, log: (msg: string) => void = () => undefined): Promise<string[]> {
  const base = findSupabaseDir();
  await db.exec(`create schema if not exists app_meta;
    create table if not exists app_meta.schema_migrations (name text primary key, applied_at timestamptz not null default now());`);
  const applied = new Set((await db.query<{ name: string }>('select name from app_meta.schema_migrations')).rows.map((r) => r.name));

  const files: Array<{ name: string; file: string }> = [];
  if (db.driver === 'pglite') {
    for (const f of fs.readdirSync(path.join(base, 'local')).filter((f) => f.endsWith('.sql')).sort())
      files.push({ name: `local/${f}`, file: path.join(base, 'local', f) });
  }
  for (const f of fs.readdirSync(path.join(base, 'migrations')).filter((f) => f.endsWith('.sql')).sort())
    files.push({ name: f, file: path.join(base, 'migrations', f) });

  const newlyApplied: string[] = [];
  for (const { name, file } of files) {
    if (applied.has(name)) continue;
    const sql = fs.readFileSync(file, 'utf8');
    await db.exec(`begin;\n${sql}\n;insert into app_meta.schema_migrations (name) values ('${name.replace(/'/g, "''")}');\ncommit;`);
    newlyApplied.push(name);
    log(`applied migration ${name}`);
  }
  return newlyApplied;
}
