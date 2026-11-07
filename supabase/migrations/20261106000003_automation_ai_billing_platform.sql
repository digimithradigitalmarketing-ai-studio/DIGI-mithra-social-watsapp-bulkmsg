-- ============================================================================
-- DigiMithra Social Pilot — 0003 Automation, AI, billing, platform operations
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Automation
-- ---------------------------------------------------------------------------
create table public.automation_workflows (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  description text not null default '',
  status text not null default 'draft' check (status in ('draft', 'published', 'paused', 'archived')),
  trigger_type text not null check (trigger_type in (
    'enquiry_submitted', 'contact_created', 'tag_added', 'customer_replied', 'membership_expiring',
    'payment_due', 'birthday', 'scheduled', 'lead_stage_changed', 'website_form_submitted')),
  current_version_id uuid,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger automation_workflows_touch before update on public.automation_workflows for each row execute function app.touch_updated_at();

create table public.automation_versions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  workflow_id uuid not null references public.automation_workflows(id) on delete cascade,
  version integer not null,
  definition jsonb not null,           -- {trigger, nodes:[...], edges:[...]}
  validation_errors jsonb not null default '[]'::jsonb,
  published_at timestamptz,
  published_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workflow_id, version)
);
alter table public.automation_workflows
  add constraint automation_workflows_current_version_fk
  foreign key (current_version_id) references public.automation_versions(id) on delete set null;

create table public.automation_executions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  workflow_id uuid not null references public.automation_workflows(id) on delete cascade,
  version_id uuid not null references public.automation_versions(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  trigger_event jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  depth integer not null default 0 check (depth <= 5),   -- loop prevention for chained triggers
  status text not null default 'running' check (status in ('running', 'waiting', 'completed', 'failed', 'cancelled')),
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (business_id, idempotency_key)
);
create index automation_executions_workflow_idx on public.automation_executions (workflow_id, started_at desc);

create table public.automation_steps (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  execution_id uuid not null references public.automation_executions(id) on delete cascade,
  node_id text not null,
  node_type text not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'waiting', 'completed', 'failed', 'skipped')),
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  error text,
  attempts integer not null default 0,
  scheduled_for timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create index automation_steps_execution_idx on public.automation_steps (execution_id);

create table public.scheduled_jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.businesses(id) on delete cascade,
  kind text not null,                  -- 'campaign_start', 'automation_resume', 'template_sync', ...
  payload jsonb not null default '{}'::jsonb,
  run_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed', 'cancelled')),
  dedupe_key text unique,
  attempts integer not null default 0,
  last_error text,
  locked_at timestamptz,
  locked_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index scheduled_jobs_due_idx on public.scheduled_jobs (status, run_at);
create trigger scheduled_jobs_touch before update on public.scheduled_jobs for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- AI
-- ---------------------------------------------------------------------------
create table public.ai_settings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null unique references public.businesses(id) on delete cascade,
  enabled boolean not null default false,
  auto_reply_enabled boolean not null default false,
  model text not null default 'gemini-flash-latest',
  languages text[] not null default array['en'],
  tone text not null default 'friendly',
  system_instructions text not null default '',
  handoff_confidence_threshold numeric(3,2) not null default 0.70 check (handoff_confidence_threshold between 0 and 1),
  monthly_token_limit bigint not null default 0,
  monthly_spend_limit_paise bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger ai_settings_touch before update on public.ai_settings for each row execute function app.touch_updated_at();

create table public.ai_knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  source_type text not null check (source_type in ('faq', 'text', 'document', 'url')),
  title text not null,
  question text,
  answer text,
  content text,
  storage_path text,
  language text not null default 'en',
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger ai_knowledge_sources_touch before update on public.ai_knowledge_sources for each row execute function app.touch_updated_at();

create table public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  feature text not null check (feature in ('auto_reply', 'reply_suggestion', 'content_assistant')),
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_micros bigint not null default 0,
  confidence numeric(3,2),
  outcome text not null check (outcome in ('answered', 'handoff', 'blocked', 'limit_reached', 'error')),
  prompt_audit jsonb not null default '{}'::jsonb,     -- redacted prompt/response for the audit trail
  created_at timestamptz not null default now()
);
create index ai_usage_business_created_idx on public.ai_usage (business_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Billing & usage
-- ---------------------------------------------------------------------------
create table public.subscription_entitlements (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  key text not null,
  limit_value bigint not null,
  source text not null default 'plan' check (source in ('plan', 'override')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, key)
);
create trigger subscription_entitlements_touch before update on public.subscription_entitlements for each row execute function app.touch_updated_at();

create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  metric text not null check (metric in ('message_marketing', 'message_utility', 'message_authentication', 'message_service',
                                         'ai_tokens', 'broadcasts', 'storage_bytes')),
  quantity bigint not null,
  unit_cost_micros bigint,             -- Meta cost estimate from message_pricing, kept separate from subscription fees
  currency text not null default 'INR',
  period_month date not null,
  reference_type text,
  reference_id text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index usage_events_period_idx on public.usage_events (business_id, metric, period_month);

-- Configurable Meta conversation/message pricing (never hard-coded). Global table.
create table public.message_pricing (
  id uuid primary key default gen_random_uuid(),
  country_code text not null,
  category text not null check (category in ('MARKETING', 'UTILITY', 'AUTHENTICATION', 'SERVICE')),
  currency text not null,
  price_micros bigint not null,
  effective_from date not null,
  effective_to date,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  unique (country_code, category, effective_from)
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  number text not null unique,
  status text not null default 'draft' check (status in ('draft', 'issued', 'paid', 'void', 'failed')),
  currency text not null default 'INR',
  amount_paise bigint not null,
  tax_paise bigint not null default 0,
  total_paise bigint not null,
  period_start date,
  period_end date,
  razorpay_invoice_id text unique,
  pdf_path text,
  issued_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  invoice_id uuid references public.invoices(id) on delete set null,
  provider text not null default 'razorpay',
  provider_payment_id text not null unique,
  amount_paise bigint not null,
  currency text not null default 'INR',
  status text not null check (status in ('created', 'authorized', 'captured', 'failed', 'refunded')),
  method text,
  failure_reason text,
  captured_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Platform operations
-- ---------------------------------------------------------------------------
create table public.notification_logs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.businesses(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  channel text not null check (channel in ('email', 'in_app', 'whatsapp')),
  template text not null,
  subject text,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  error text,
  metadata jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index notification_logs_user_idx on public.notification_logs (user_id, created_at desc);

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  key_prefix text not null,            -- shown in UI, e.g. 'sp_live_ab12'
  key_hash text not null unique,       -- sha256 of the full key; full key shown once at creation
  scopes text[] not null default '{}',
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  opened_by uuid references public.profiles(id) on delete set null,
  subject text not null,
  body text not null,
  status text not null default 'open' check (status in ('open', 'pending', 'resolved', 'closed')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  assigned_admin uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger support_tickets_touch before update on public.support_tickets for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
select app.apply_tenant_policies('automation_workflows', array['owner', 'manager']);
select app.apply_tenant_policies('automation_versions',  array['owner', 'manager']);
select app.apply_tenant_policies('ai_settings',          array['owner', 'manager']);
select app.apply_tenant_policies('ai_knowledge_sources', array['owner', 'manager']);
select app.apply_tenant_readonly_policies('automation_executions',     array['owner', 'manager']);
select app.apply_tenant_readonly_policies('automation_steps',          array['owner', 'manager']);
select app.apply_tenant_readonly_policies('ai_usage',                  array['owner', 'manager']);
select app.apply_tenant_readonly_policies('subscription_entitlements', array['owner', 'manager', 'agent']);
select app.apply_tenant_readonly_policies('usage_events',              array['owner', 'manager']);
select app.apply_tenant_readonly_policies('invoices',                  array['owner']);
select app.apply_tenant_readonly_policies('payments',                  array['owner']);

alter table public.scheduled_jobs enable row level security;
create policy scheduled_jobs_select on public.scheduled_jobs for select to authenticated
  using (business_id is not null and app.has_business_role(business_id, array['owner', 'manager']));
grant select on public.scheduled_jobs to authenticated;
grant select, insert, update, delete on public.scheduled_jobs to service_role;

alter table public.message_pricing enable row level security;
create policy message_pricing_select on public.message_pricing for select to authenticated using (true);
grant select on public.message_pricing to authenticated;
grant select, insert, update, delete on public.message_pricing to service_role;

alter table public.notification_logs enable row level security;
create policy notification_logs_select on public.notification_logs for select to authenticated
  using (user_id = auth.uid() or (business_id is not null and app.has_business_role(business_id, array['owner'])));
create policy notification_logs_mark_read on public.notification_logs for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, update on public.notification_logs to authenticated;
grant select, insert, update, delete on public.notification_logs to service_role;

-- API keys: owners can list (API selects safe columns only) and revoke; creation is a service op (hashing).
alter table public.api_keys enable row level security;
create policy api_keys_select on public.api_keys for select to authenticated using (app.has_business_role(business_id, array['owner']));
create policy api_keys_update on public.api_keys for update to authenticated
  using (app.has_business_role(business_id, array['owner'])) with check (app.has_business_role(business_id, array['owner']));
grant select, update on public.api_keys to authenticated;
grant select, insert, update, delete on public.api_keys to service_role;
create index api_keys_business_idx on public.api_keys (business_id);

alter table public.support_tickets enable row level security;
create policy support_tickets_select on public.support_tickets for select to authenticated
  using (app.has_business_role(business_id, array['owner', 'manager']) or app.is_platform_admin());
create policy support_tickets_insert on public.support_tickets for insert to authenticated
  with check (app.has_business_role(business_id, array['owner', 'manager']) and opened_by = auth.uid());
grant select, insert on public.support_tickets to authenticated;
grant select, insert, update, delete on public.support_tickets to service_role;
create index support_tickets_business_idx on public.support_tickets (business_id);

revoke all on all tables in schema public from anon;
