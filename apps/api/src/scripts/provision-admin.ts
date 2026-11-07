/**
 * Secure Super Admin provisioning.  Run by an operator with database access:
 *
 *   npm run admin:provision -- --email owner@digimithra.co.in --operator "Prashgeeth (laptop)"
 *   npm run admin:provision -- --email someone@x.com --revoke --operator "..."
 *
 * The account must already exist (sign up normally first).  There is no API
 * route that can grant this role, and the first public signup is NOT an admin.
 * The admin must then enrol TOTP MFA before the Super Admin console unlocks.
 */
import { parseArgs } from 'node:util';
import os from 'node:os';
import { loadConfig } from '../config';
import { createDatabase, migrate } from '../db';
import { writeAudit } from '../lib/audit';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    operator: { type: 'string' },
    note: { type: 'string' },
    revoke: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
  },
});

const config = loadConfig();
const db = await createDatabase(config);
await migrate(db);

if (values.list) {
  const r = await db.query<{ email: string; granted_by: string; created_at: Date }>(
    `select p.email, a.granted_by, a.created_at from public.platform_admins a join public.profiles p on p.id = a.user_id order by a.created_at`,
  );
  console.table(r.rows);
  process.exit(0);
}

if (!values.email) {
  console.error('Usage: npm run admin:provision -- --email <email> [--operator "<who is running this>"] [--revoke] [--list]');
  process.exit(1);
}
const operator = values.operator || `${os.userInfo().username}@${os.hostname()}`;
const user = await db.query<{ id: string }>('select id from public.profiles where lower(email) = lower($1)', [values.email]);
if (!user.rows[0]) {
  console.error(`No account found for ${values.email}. Ask them to sign up first, then re-run.`);
  process.exit(1);
}
const userId = user.rows[0].id;

await db.transaction(async (tx) => {
  if (values.revoke) {
    await tx.query('delete from public.platform_admins where user_id = $1', [userId]);
    await writeAudit(tx, { actorType: 'system', action: 'admin.revoked', targetType: 'user', targetId: userId, metadata: { email: values.email, operator } });
  } else {
    await tx.query(
      `insert into public.platform_admins (user_id, granted_by, note) values ($1, $2, $3)
       on conflict (user_id) do update set granted_by = excluded.granted_by, note = excluded.note`,
      [userId, operator, values.note ?? null],
    );
    await writeAudit(tx, { actorType: 'system', action: 'admin.granted', targetType: 'user', targetId: userId, metadata: { email: values.email, operator } });
  }
});
console.log(values.revoke ? `Revoked Super Admin from ${values.email}.` : `Granted Super Admin to ${values.email}. They must enrol MFA at /admin before access is allowed.`);
await db.close();
process.exit(0);
