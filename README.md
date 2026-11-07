# DigiMithra Social Pilot

Multi-tenant SaaS for WhatsApp marketing, team inbox, CRM, automation and business AI — built for Indian businesses
(first workspace: Gold Fitness Kengeri). Independent of `app.digimithra.co.in`.

**Status: Phases 1–5 implemented (Foundation, WhatsApp MVP, Inbox & CRM, Automation, AI Center).** See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the phase plan.

## Run locally (no Docker, no cloud accounts needed)

Requires Node 20.19+.

```bash
npm install
cp .env.example apps/api/.env      # then set LOCAL_JWT_SECRET to any 32+ char random string
npm run dev:api                    # http://localhost:8080  (embedded Postgres via PGlite, migrations auto-applied)
npm run dev:web                    # http://localhost:5173  (proxies /v1 to the API)
```

Local data lives in `apps/api/.data/pglite` (delete the folder to reset).
Local mode auto-verifies emails (`LOCAL_AUTO_VERIFY_EMAIL=true`); set it to `false` to test the verification flow —
links are printed in the API log by the dev mailer.

### Local test account
Created during development in the local database only:
`owner@goldfitness.test` / `LocalDev-Passw0rd` (owner of "Gold Fitness Kengeri", provisioned as Super Admin with a TOTP factor).
If you reset `.data`, just sign up again.

### Make yourself Super Admin locally
PGlite is single-process, so **stop the API first**, then:
```bash
npm run admin:provision -- --email you@example.com --operator "me"
```
Start the API again, open `/admin`, enrol an authenticator app.

## Try Phase 2 locally (no Meta account needed)
1. **WhatsApp Connection** → *Mock (testing)* → Create mock connection. Nothing is sent to WhatsApp.
2. **Import Contacts** → upload a CSV, match columns, confirm consent.
3. **Message Templates** → New template → *Save & submit*; the mock review approves it within a few seconds.
4. **Broadcast Campaigns** → New campaign → Review → Send. Watch the live report.
5. On a contact page, use *Simulate customer reply* (try `STOP` and `START`).
6. **Team Inbox** → open the conversation. On mock connections the right panel has a *Simulate customer message* box:
   send one to open the 24-hour window, then reply, add a lead and a follow-up. Type `/` in the reply box for canned replies.

Mock test numbers (last 4 digits): `0000` permanent failure · `9999` rate-limited until retries run out (dead-letter) ·
`5050` fails after sending · `1050` customer blocked marketing (auto opt-out).

## AI notes
* Business AI is a plan feature (Business plan: 2M tokens/month). For a local trial on another plan, raise the
  `ai_tokens_monthly` entitlement in `subscription_entitlements`.
* Locally `AI_PROVIDER=mock` answers by quoting your knowledge base, so you can test auto-reply, handoff and guards offline.
  Set `AI_PROVIDER=gemini` with `GEMINI_API_KEY` for real model answers.

## Automation notes
* Automation is a plan feature: Starter has 0 workflows (Growth: 10, Business: 50). For a local trial on Starter, raise the
  `workflows` entitlement for your workspace in `subscription_entitlements` (stop the API first when using PGlite).
* The scheduler job (`automation.scan`) runs every 5 minutes and evaluates date triggers in each business's timezone.

## Checks
```bash
npm run typecheck
npm test          # API: auth, tenant isolation (API + raw-SQL RLS), RBAC, Super Admin/MFA, OpenAPI, units
npm run build
```

## Docs
* [Architecture & phase plan](docs/ARCHITECTURE.md)
* [Tenant isolation](docs/TENANT_ISOLATION.md)
* [Deployment (Supabase, Render, GoDaddy)](docs/DEPLOYMENT.md)
* [External dependencies & approvals](docs/EXTERNAL_DEPENDENCIES.md)
* API spec: [apps/api/openapi.yaml](apps/api/openapi.yaml) (served at `/openapi.yaml`)
