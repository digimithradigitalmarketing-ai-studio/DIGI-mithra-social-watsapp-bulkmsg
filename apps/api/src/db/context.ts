import type { Database, Queryable } from './index';

export interface UserClaims {
  sub: string;
  email: string;
  aal: 'aal1' | 'aal2';
}

/**
 * Run `fn` inside a transaction as the Postgres role `authenticated` with the
 * caller's verified JWT claims. Every query is therefore subject to RLS —
 * exactly as if the request had come through Supabase's own data API.
 */
export function withUser<T>(db: Database, user: UserClaims, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const claims = JSON.stringify({ sub: user.sub, email: user.email, role: 'authenticated', aal: user.aal });
    await tx.query(
      `select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`,
      [claims, user.sub],
    );
    await tx.query('set local role authenticated');
    return fn(tx);
  });
}

/**
 * Privileged transaction (database owner, bypasses RLS).  Only for explicit,
 * server-authorised operations: workspace bootstrap, invitation acceptance,
 * webhook ingestion, Super Admin actions.  Callers must authorise first and
 * write an audit log entry.
 */
export function withService<T>(db: Database, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}
