import type { Queryable } from '../db';

/**
 * Postgres-backed job queue on public.scheduled_jobs.
 * - enqueue is transactional with the business change that caused it
 * - workers claim with FOR UPDATE SKIP LOCKED (safe with many workers)
 * - dedupe_key makes enqueue idempotent
 * - jobs that exhaust max_attempts stay as status='failed' = dead-letter queue
 */
export interface JobRow {
  id: string;
  business_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  run_at: Date;
  attempts: number;
  max_attempts: number;
  dedupe_key: string | null;
}

export interface EnqueueOptions {
  businessId?: string | null;
  runAt?: Date;
  dedupeKey?: string;
  maxAttempts?: number;
}

export async function enqueue(tx: Queryable, kind: string, payload: Record<string, unknown>, o: EnqueueOptions = {}): Promise<string | null> {
  const r = await tx.query<{ id: string }>(
    `insert into public.scheduled_jobs (business_id, kind, payload, run_at, dedupe_key, max_attempts)
     values ($1, $2, $3, $4, $5, coalesce($6, 5))
     on conflict (dedupe_key) do nothing returning id`,
    [o.businessId ?? null, kind, JSON.stringify(payload), (o.runAt ?? new Date()).toISOString(), o.dedupeKey ?? null, o.maxAttempts ?? null],
  );
  return r.rows[0]?.id ?? null;
}

export async function claimJobs(db: Queryable, workerId: string, limit: number): Promise<JobRow[]> {
  const r = await db.query<JobRow>(
    `update public.scheduled_jobs j set status = 'running', locked_at = now(), locked_by = $1, attempts = j.attempts + 1
     where j.id in (
       select id from public.scheduled_jobs
       where status = 'pending' and run_at <= now()
       order by run_at, created_at
       limit $2
       for update skip locked)
     returning j.id, j.business_id, j.kind, j.payload, j.run_at, j.attempts, j.max_attempts, j.dedupe_key, j.created_at`,
    [workerId, limit],
  );
  // UPDATE … RETURNING does not preserve the subquery order; process oldest first.
  r.rows.sort((a, b) => new Date(a.run_at).getTime() - new Date(b.run_at).getTime()
    || new Date((a as JobRow & { created_at: Date }).created_at).getTime() - new Date((b as JobRow & { created_at: Date }).created_at).getTime());
  return r.rows;
}

export async function completeJob(db: Queryable, id: string): Promise<void> {
  await db.query(`update public.scheduled_jobs set status = 'done', finished_at = now(), locked_at = null, last_error = null where id = $1`, [id]);
}

export async function cancelJob(db: Queryable, id: string, reason: string): Promise<void> {
  await db.query(`update public.scheduled_jobs set status = 'cancelled', finished_at = now(), locked_at = null, last_error = $2 where id = $1`, [id, reason]);
}

/** Reschedule with backoff, or move to the dead-letter state when attempts are exhausted. Returns true if it will retry. */
export async function retryOrFail(db: Queryable, job: JobRow, error: string, delaySeconds: number | null): Promise<boolean> {
  if (delaySeconds !== null && job.attempts < job.max_attempts) {
    await db.query(
      `update public.scheduled_jobs set status = 'pending', run_at = now() + make_interval(secs => $2), locked_at = null, locked_by = null, last_error = $3 where id = $1`,
      [job.id, delaySeconds, error.slice(0, 2000)],
    );
    return true;
  }
  await db.query(`update public.scheduled_jobs set status = 'failed', finished_at = now(), locked_at = null, last_error = $2 where id = $1`, [job.id, error.slice(0, 2000)]);
  return false;
}

/** Jobs stuck in 'running' (worker crashed) go back to pending. */
export async function recoverStaleJobs(db: Queryable, olderThanSeconds = 300): Promise<number> {
  const r = await db.query(
    `update public.scheduled_jobs set status = 'pending', locked_at = null, locked_by = null
     where status = 'running' and locked_at < now() - make_interval(secs => $1) returning id`,
    [olderThanSeconds],
  );
  return r.rows.length;
}

/** Exponential backoff with jitter: base * 2^(attempt-1), capped at 1 hour. */
export function backoffSeconds(attempt: number, baseSeconds: number, retryAfter?: number): number {
  if (retryAfter && retryAfter > 0) return Math.min(retryAfter, 3600);
  const exp = baseSeconds * 2 ** Math.max(0, attempt - 1);
  const jitter = exp * 0.2 * Math.random();
  return Math.min(Math.round((exp + jitter) * 1000) / 1000, 3600);
}
