# Deployment — staging and production

Targets: web `https://socialpilot.digimithra.co.in`, API `https://api.socialpilot.digimithra.co.in`.
**Nothing here touches `app.digimithra.co.in`** — new repo, new Supabase project, new Render services, two new DNS records.

## 1. GitHub
1. Create a private repo, e.g. `digimithra/social-pilot`, and push this project.
2. Protect `main`; add CI running `npm ci && npm run typecheck && npm test && npm run build`.

## 2. Supabase (one project per environment: `socialpilot-staging`, `socialpilot-prod`)
1. Create the project in **Mumbai (ap-south-1)**. Save the DB password in a password manager.
2. Auth → Providers → Email: enable, **Confirm email = on**. Auth → MFA: enable **TOTP**.
3. Auth → URL configuration: Site URL `https://socialpilot.digimithra.co.in`; redirect URLs
   `https://socialpilot.digimithra.co.in/verify-email`, `https://socialpilot.digimithra.co.in/reset-password`.
4. Auth → SMTP: configure a custom SMTP sender (`no-reply@digimithra.co.in`).
5. Settings → API: copy the **Project URL** and **publishable key**. (The secret/service-role key is not needed in Phase 1;
   never put it in the web app.)
6. Settings → Data API: since the browser never uses Supabase directly, you may disable the Data API or remove `public`
   from exposed schemas. RLS protects it either way.
7. Apply migrations from your machine:
   ```bash
   npx supabase login
   npx supabase link --project-ref <project-ref>
   npx supabase db push          # applies supabase/migrations/*.sql (never supabase/local/*)
   ```
8. Connection string for the API: Settings → Database → **Session pooler** (port 5432) URI using the `postgres` user.
   (Transaction pooler also works because all RLS context is set with `SET LOCAL` inside transactions.)

## 3. Render
`render.yaml` defines both services. Render → New → Blueprint → select the repo.

**API (`socialpilot-api`, Web Service, Node 20+)** — env vars:
```
APP_ENV=production
TRUST_PROXY=1
WEB_ORIGINS=https://socialpilot.digimithra.co.in
PUBLIC_WEB_URL=https://socialpilot.digimithra.co.in
DATABASE_DRIVER=pg
DATABASE_URL=<supabase session pooler URI>
DB_AUTO_MIGRATE=false
AUTH_PROVIDER=supabase
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=<publishable key>
ADMIN_REQUIRE_MFA=true
INTEGRATION_ENCRYPTION_KEY=<32 random bytes, base64>
```
The API refuses to start in staging/production with local auth, PGlite, MFA disabled, or no encryption key.
Health check path: `/health`.

**Web (`socialpilot-web`, Static Site)** — env var `VITE_API_URL=https://api.socialpilot.digimithra.co.in`.
SPA rewrite `/* → /index.html` is in `render.yaml`.

**Worker (`socialpilot-worker`, Background Worker)** — `node apps/api/dist/worker.js`, same database/encryption env as the API.
It sends campaigns, processes webhooks and retries failures. The queue lives in Postgres (`scheduled_jobs`,
`FOR UPDATE SKIP LOCKED`), so no Redis is needed; you can run more than one worker safely. Set `WORKER_IN_PROCESS=false`
on the API. Add `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `META_GRAPH_API_VERSION` and `PUBLIC_API_URL` to the API.

## 4. GoDaddy DNS (digimithra.co.in zone)
| Type | Name | Value |
|---|---|---|
| CNAME | `socialpilot` | `<socialpilot-web>.onrender.com` |
| CNAME | `api.socialpilot` | `<socialpilot-api>.onrender.com` |

Add both custom domains in Render first; Render issues HTTPS certificates automatically once DNS resolves.
Do not modify the existing records for `app`, `@` or `www`.

## 5. First Super Admin (secure provisioning)
1. Sign up normally at `https://socialpilot.digimithra.co.in/signup` and verify the email.
2. From a trusted machine with the production `DATABASE_URL` (and `AUTH_PROVIDER=supabase` env so config validates):
   ```bash
   npm run admin:provision -- --email you@digimithra.co.in --operator "Your Name, laptop"
   npm run admin:provision -- --list
   ```
3. Visit `/admin`, enrol TOTP, verify a code. Access requires an `aal2` session every time.
Revoke with `--revoke`. All grants/revocations are audit-logged.

## 6. Webhook URLs
* Meta WhatsApp (live in Phase 2): `https://api.socialpilot.digimithra.co.in/v1/webhooks/meta`
  1. Meta app → WhatsApp → Configuration → Edit webhook: callback URL above, verify token = `META_WEBHOOK_VERIFY_TOKEN`.
  2. Subscribe to the `messages` and `message_template_status_update` fields.
  3. Connecting a number in the app calls `POST /{waba-id}/subscribed_apps`, so that WABA's events reach the app.
  4. Every POST is checked against `X-Hub-Signature-256` (HMAC with `META_APP_SECRET`), stored once in `webhook_events`
     and processed by the worker.
* Razorpay (Phase 6): `https://api.socialpilot.digimithra.co.in/v1/webhooks/razorpay` (`X-Razorpay-Signature` validated)

## 7. Monitoring & backups
* Render: health checks + log streams; alert on 5xx rate.
* Supabase: enable PITR on production (Pro plan); review Advisors (security/performance) after each migration.
* Audit log: `/admin/audit`.

## 8. Supabase smoke test (do this once staging exists — not yet done)
1. Sign up → confirm the email arrives and the link lands on `/verify-email`.
2. Log in; refresh the page (session restored via cookie); log out.
3. Forgot password → link lands on `/reset-password#access_token=…` → set password.
4. Create workspace, invite a second account, accept.
5. Provision admin, enrol TOTP in `/admin`, verify the console opens.
6. Run `select * from public.contacts` as a normal user via the Supabase SQL editor with "Role: authenticated" impersonation to see RLS in action.
