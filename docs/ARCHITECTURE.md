# DigiMithra Social Pilot — Architecture

Independent, multi-tenant SaaS. It shares **nothing** with `app.digimithra.co.in`: separate repo,
separate Supabase project, separate Render services, separate DNS records.

## 1. System overview

```
             socialpilot.digimithra.co.in                 api.socialpilot.digimithra.co.in
┌──────────────────────────────────┐  HTTPS/JSON  ┌──────────────────────────────────────────┐
│ apps/web  (React + Vite, static) │ ───────────▶ │ apps/api  (Express 5, TypeScript)         │
│  - access token in memory only   │  Bearer JWT  │  - auth facade (Supabase Auth / local)    │
│  - refresh token: httpOnly cookie│ ◀─────────── │  - RBAC + workspace checks                │
└──────────────────────────────────┘              │  - per-request RLS context (SET ROLE)     │
                                                  │  - webhooks: Meta (live), Razorpay (P6)   │
                                                  └───────┬──────────────────────┬────────────┘
                                                          │ SQL (pg)             │ job table
                                              ┌───────────▼─────────┐   ┌────────▼─────────┐
                                              │ Supabase Postgres   │   │ worker process   │
                                              │  RLS on every table │   │  send / retry /  │
                                              │  Supabase Auth      │   │  DLQ / scheduler │
                                              │  Supabase Storage   │   └────────┬─────────┘
                                              └─────────────────────┘            │
                                                         Meta WhatsApp Cloud API, Gemini, Razorpay
```

### Key decisions

| Concern | Decision | Why |
|---|---|---|
| Browser ↔ data | Browser **never** talks to Supabase directly; only to our API. | Keeps every key server-side, one place for RBAC, rate limits and audit. |
| Auth | `AUTH_PROVIDER=supabase` in staging/prod (Supabase Auth: email verify, reset, MFA). `AUTH_PROVIDER=local` for dev/tests (same JWT claim shape, bcrypt, TOTP). | Runs fully offline for development; production uses managed auth. |
| Tenant isolation | 3 layers: (1) route middleware loads membership and checks permission; (2) every tenant query runs inside a transaction with `SET LOCAL ROLE authenticated` + `request.jwt.claims`, so **Postgres RLS** applies to the API itself; (3) automated cross-tenant tests. | A bug in one layer does not leak data. |
| Privileged ops | A small set of explicit "service" operations (create workspace, accept invite, admin) run as the DB owner, always after an explicit server-side check, always audit-logged. | Bootstrap actions that RLS cannot express cleanly. |
| Local DB | PGlite (real Postgres 18 in WASM) applies the same migrations + a Supabase auth shim. | No Docker needed; RLS is genuinely enforced in tests. |
| Money | Integers in paise. Plan prices editable by Super Admin. Meta message charges tracked separately (`usage_events`, configurable rates). | No floating point; no hard-coded Meta rates. |
| Queues | Postgres job table (`scheduled_jobs`, `FOR UPDATE SKIP LOCKED`), separate worker process. Chosen over BullMQ/Redis to keep enqueueing in the same transaction as the business change and avoid another service; the queue interface is small enough to swap later. | Rate-limited, retryable outbound sending with a dead-letter state. |

## 2. Folder structure

```
.
├── apps/
│   ├── api/                      Express API + (later) worker
│   │   ├── openapi.yaml          OpenAPI 3.1 spec (served at /openapi.yaml)
│   │   ├── src/
│   │   │   ├── app.ts            createApp(deps) — used by server and tests
│   │   │   ├── server.ts         process entry
│   │   │   ├── config.ts         zod-validated env
│   │   │   ├── auth/             provider interface, local + supabase providers, tokens, mailer
│   │   │   ├── db/               PGlite/pg adapters, migration runner, RLS context helpers
│   │   │   ├── lib/              errors, http helpers, audit, crypto
│   │   │   ├── middleware/       requireAuth, workspace membership, permissions, admin guard
│   │   │   ├── routes/           auth, me, businesses, members, invitations, dashboard, admin
│   │   │   └── scripts/          migrate.ts, provision-admin.ts
│   │   └── test/                 vitest + supertest (tenant isolation, RBAC, auth, RLS coverage)
│   └── web/                      React + Vite + Tailwind
│       └── src/
│           ├── components/ui/    shadcn-style primitives (Radix based)
│           ├── components/layout AppShell, Sidebar, Topbar, AdminShell, CommandPalette
│           ├── lib/              api client, auth context, i18n (en/kn), theme
│           └── pages/            auth, onboarding, app (dashboard, settings), admin, legal
├── packages/shared/              zod schemas, roles & permissions, DTO types (used by api and web)
├── supabase/
│   ├── migrations/               SQL migrations (apply with `supabase db push`)
│   └── local/                    auth shim used ONLY by local PGlite (never pushed to Supabase)
├── docs/                         ARCHITECTURE, TENANT_ISOLATION, DEPLOYMENT, EXTERNAL_DEPENDENCIES
├── render.yaml                   Render blueprint (web static site + API)
└── .env.example
```

## 3. Database design (summary)

Full DDL: `supabase/migrations/*.sql`. All PKs are UUID, all tables have `created_at`
(and `updated_at` where mutable). Every tenant-owned table has `business_id uuid not null
references businesses(id) on delete cascade` and an index on it.

| Area | Tables |
|---|---|
| Identity & tenancy | `profiles`, `platform_admins`, `businesses`, `business_roles`, `business_members`, `business_invitations` |
| Channels | `connected_channels`, `whatsapp_accounts`, `whatsapp_phone_numbers`, `integration_credentials` (encrypted, no `authenticated` grant) |
| CRM | `contacts`, `contact_consents`, `tags`, `contact_tags`, `segments`, `custom_field_definitions`, `lead_pipelines`, `lead_stages`, `leads`, `follow_up_tasks`, `contact_notes` |
| Messaging | `conversations`, `messages`, `message_status_events`, `message_templates`, `canned_replies`, `campaigns`, `campaign_recipients`, `suppression_lists` |
| Automation | `automation_workflows`, `automation_versions`, `automation_executions`, `automation_steps`, `scheduled_jobs` |
| AI | `ai_settings`, `ai_knowledge_sources`, `ai_usage` |
| Billing | `subscription_plans`, `subscriptions`, `subscription_entitlements`, `usage_events`, `invoices`, `payments`, `message_pricing` |
| Platform | `webhook_events` (unique provider+event id → idempotency), `notification_logs`, `audit_logs` (append-only), `system_settings`, `support_tickets` |

## 4. Roles

| Capability | Super Admin | Owner | Manager | Agent |
|---|:-:|:-:|:-:|:-:|
| Platform dashboard, suspend tenants, plans | ✅ (MFA) | | | |
| Business profile, billing, channels, API keys | | ✅ | | |
| Invite/manage staff | | ✅ all roles | ✅ agents only | |
| Contacts, campaigns, templates, automation | | ✅ | ✅ | |
| All conversations | | ✅ | ✅ | |
| Assigned/unassigned conversations, reply, update leads | | ✅ | ✅ | ✅ |

Super Admin is **not** a business role. It lives in `platform_admins`, which no API route can write.
It is granted only by `npm run admin:provision` run by an operator with database access.

## 5. Phase plan

| Phase | Scope | Status |
|---|---|---|
| 1 Foundation | Schema for all modules, auth, onboarding, workspaces, team & roles, dashboard, Super Admin foundation | **Implemented (this delivery)** |
| 2 WhatsApp MVP | Channel connect (manual WABA/phone ID + token, or mock), templates + Meta review/sync, contacts + consent, CSV import/export, tags, campaigns (preview, schedule, pause/cancel), Postgres job queue with pacing, retries and dead-letter, signed idempotent webhooks, delivery tracking, STOP/START | **Implemented** (Meta path not yet tested against a live WABA) |
| 3 Inbox & CRM | 3-panel team inbox (polling every 3–5 s), 24h window enforced in API and worker, idempotent replies, assignment rules, notes, labels, canned replies, lead pipeline with stage history, follow-up tasks, customer timeline, reports with team performance + CSV | **Implemented** |
| 4 Automation | Visual builder (trigger → if/else → actions → waits), drafts + immutable published versions, publish-time validation, 10 triggers incl. timezone-aware date triggers (expiry, payment due, birthday, scheduled), 9 actions, idempotent runs, re-entry rules, loop guard (depth ≤ 3, 200 steps), retries, failed-run retry, execution log, in-app notifications, 7 gym templates | **Implemented** (enquiry/website-form triggers fire via test runs until the Phase 7 Integrations API) |
| 5 AI | Knowledge base (FAQ + business info, EN/KN), lexical retrieval, Gemini or offline mock provider, grounding guards (prices/phones/links must exist in knowledge), medical + handoff-keyword + prompt-injection guards, confidence threshold, WhatsApp auto-reply within 24h (debounced, stops on human reply/handoff, per-conversation cap), handoff notes + notifications, staff reply suggestions, template content drafts, automation AI step, token/spend caps, redacted audit trail | **Implemented** (Gemini path not yet verified with a live key) |
| 6 Commercial | Razorpay subscriptions + webhooks, invoices, entitlements, upgrade/downgrade, admin billing | |
| 7 Integrations | Google Forms/Apps Script signed endpoint, Sheets, DGF ERP API, Instagram (after review) | |

See `EXTERNAL_DEPENDENCIES.md` for what needs Meta approval / credentials.
