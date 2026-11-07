import type { Queryable } from '../db';

export interface AuditEntry {
  businessId?: string | null;
  actorUserId?: string | null;
  actorType?: 'user' | 'platform_admin' | 'system' | 'integration';
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

/** Must be called with a service (owner) connection: authenticated has no insert grant on audit_logs. */
export async function writeAudit(tx: Queryable, e: AuditEntry): Promise<void> {
  await tx.query(
    `insert into public.audit_logs (business_id, actor_user_id, actor_type, action, target_type, target_id, metadata, ip, user_agent)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      e.businessId ?? null,
      e.actorUserId ?? null,
      e.actorType ?? 'user',
      e.action,
      e.targetType ?? null,
      e.targetId ?? null,
      JSON.stringify(e.metadata ?? {}),
      e.ip ?? null,
      e.userAgent ?? null,
    ],
  );
}
