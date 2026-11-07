# How tenant isolation is enforced

Goal: workspace A can never read or change workspace B's messages, contacts, templates, credentials or billing data.
Isolation is enforced in **three independent layers**. Any single layer failing does not leak data.

## Layer 1 — API authorisation (`apps/api/src/middleware/auth.ts`)

1. `requireAuth` verifies the JWT signature (local HS256, or Supabase JWKS/secret), issuer, audience and expiry,
   and rejects unverified emails.
2. `requireMembership` loads the caller's row from `business_members` for the `:businessId` in the URL.
   * No active membership → **404** (we never confirm that another tenant's workspace exists).
   * Workspace suspended → **423** with the reason.
3. `requirePermission(...)` checks the role against the matrix in `packages/shared/src/roles.ts`.
4. Route handlers apply finer business rules (managers can only manage agents, nobody changes their own role,
   a workspace always keeps one active owner, seat limits from `subscription_entitlements`).

## Layer 2 — PostgreSQL Row Level Security (`supabase/migrations/*`)

* RLS is enabled on **every** table in `public` (verified by an automated test).
* Every tenant-owned table has `business_id uuid not null references businesses(id)` and an index.
* The API does **not** run tenant queries as a superuser. `withUser()` (`apps/api/src/db/context.ts`) opens a
  transaction, sets `request.jwt.claims` to the verified token's claims, and runs `SET LOCAL ROLE authenticated`.
  `auth.uid()` then resolves to the caller, and the policies below decide which rows exist for them —
  exactly like Supabase's own Data API.
* Policy helpers are `SECURITY DEFINER` functions with an empty `search_path`:
  `app.is_business_member(bid)`, `app.has_business_role(bid, roles[])`, `app.is_platform_admin()`.
  Both membership helpers also require the business to be `active`, so suspending a workspace hides its data at the
  database layer too.
* Standard policy set (`app.apply_tenant_policies`): members can read; only listed roles can write.
* Special cases:
  * `conversations` / `messages` / `conversation_notes`: owners and managers see all; agents see only conversations
    assigned to them plus the unassigned queue.
  * `integration_credentials`, `webhook_events`, `system_settings`: RLS on, **no policies and no grant** to
    `authenticated` — unreadable from any user context.
  * `audit_logs`: append-only (trigger blocks UPDATE/DELETE); users cannot insert (no grant).
  * `platform_admins`: users can only see their own row; no insert grant.
* `anon` has no table privileges at all (verified by test).

## Layer 3 — Service operations (explicit and audited)

A few operations cannot be expressed as "a member acting on their own workspace": creating a workspace (you are not
a member yet), accepting an invitation, Super Admin actions, and (from Phase 2) webhook ingestion and background
workers. These use `withService()` (database owner), and **always**:

* run only after an explicit server-side check (verified identity, invitation token + email match, platform admin + MFA, Meta signature…);
* filter by an explicit `business_id` derived from trusted data, never from the request body alone;
* write an `audit_logs` entry.

## Automated tests (`apps/api/test/tenant-isolation.test.ts`, `rbac.test.ts`)

* Tenant B gets 404 on every tenant-A route (GET/PATCH business, members, invitations, dashboard, audit log).
* Under RLS as tenant B: `select * from contacts` returns 0 rows; inserting a contact into tenant A fails with
  `42501`; updating tenant A's business affects 0 rows.
* Signed-in users cannot read `integration_credentials`, `system_settings`, `webhook_events`.
* Users cannot insert into `platform_admins`, `audit_logs`, or add themselves to another workspace.
* Every `public` table has RLS; `anon` has no grants; every tenant table has a non-null `business_id`.
* Agents see only assigned/unassigned conversations (raw SQL and dashboard counts).
* Suspended workspaces return 423 and are invisible under RLS.

## Credentials

Third-party secrets (Meta system-user tokens, Gemini keys…) are encrypted with AES-256-GCM
(`apps/api/src/lib/crypto.ts`, key `INTEGRATION_ENCRYPTION_KEY`, versioned via `key_version` for rotation) and stored
only in `integration_credentials`. API responses expose at most `last_four`. The browser never receives Supabase,
Meta, Gemini or Razorpay secrets: it only talks to our API.
