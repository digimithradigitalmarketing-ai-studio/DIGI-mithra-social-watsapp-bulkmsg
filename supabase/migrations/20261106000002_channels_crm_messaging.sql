-- ============================================================================
-- DigiMithra Social Pilot — 0002 Channels, CRM, messaging, campaigns
-- Tables are created now so the data model is stable; features ship in Phases 2-3.
-- ============================================================================

-- Standard tenant policy set:
--   select: any active member of the (active) business
--   insert/update/delete: members whose role is in p_write_roles
-- Also grants table privileges to authenticated and indexes business_id.
create or replace function app.apply_tenant_policies(p_table text, p_write_roles text[]) returns void
language plpgsql as $$
declare
  t text := format('public.%I', p_table);
begin
  execute format('alter table %s enable row level security', t);
  execute format('create policy %I on %s for select to authenticated using (app.is_business_member(business_id))',
                 p_table || '_select', t);
  execute format('create policy %I on %s for insert to authenticated with check (app.has_business_role(business_id, %L::text[]))',
                 p_table || '_insert', t, p_write_roles);
  execute format('create policy %I on %s for update to authenticated using (app.has_business_role(business_id, %L::text[])) with check (app.has_business_role(business_id, %L::text[]))',
                 p_table || '_update', t, p_write_roles, p_write_roles);
  execute format('create policy %I on %s for delete to authenticated using (app.has_business_role(business_id, %L::text[]))',
                 p_table || '_delete', t, p_write_roles);
  execute format('create index if not exists %I on %s (business_id)', p_table || '_business_idx', t);
  execute format('grant select, insert, update, delete on %s to authenticated, service_role', t);
end $$;

-- Read-only for members; all writes go through trusted backend/worker code.
create or replace function app.apply_tenant_readonly_policies(p_table text, p_read_roles text[]) returns void
language plpgsql as $$
declare
  t text := format('public.%I', p_table);
begin
  execute format('alter table %s enable row level security', t);
  execute format('create policy %I on %s for select to authenticated using (app.has_business_role(business_id, %L::text[]))',
                 p_table || '_select', t, p_read_roles);
  execute format('create index if not exists %I on %s (business_id)', p_table || '_business_idx', t);
  execute format('grant select on %s to authenticated', t);
  execute format('grant select, insert, update, delete on %s to service_role', t);
end $$;

-- ---------------------------------------------------------------------------
-- Channels
-- ---------------------------------------------------------------------------
create table public.connected_channels (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  channel text not null check (channel in ('whatsapp', 'instagram', 'web_form', 'google_forms', 'erp')),
  provider text not null default 'meta_cloud' check (provider in ('meta_cloud', 'mock', 'apps_script', 'custom')),
  name text not null,
  status text not null default 'pending' check (status in ('pending', 'connected', 'error', 'disconnected')),
  external_id text,
  config jsonb not null default '{}'::jsonb,
  last_error text,
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger connected_channels_touch before update on public.connected_channels for each row execute function app.touch_updated_at();

create table public.whatsapp_accounts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  channel_id uuid not null references public.connected_channels(id) on delete cascade,
  waba_id text not null,
  meta_business_id text,
  name text,
  currency text,
  timezone_id text,
  message_template_namespace text,
  status text not null default 'active' check (status in ('active', 'restricted', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, waba_id)
);
create trigger whatsapp_accounts_touch before update on public.whatsapp_accounts for each row execute function app.touch_updated_at();

create table public.whatsapp_phone_numbers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  whatsapp_account_id uuid not null references public.whatsapp_accounts(id) on delete cascade,
  phone_number_id text not null unique,          -- Meta's ID; webhooks are routed by it
  display_phone_number text not null,
  verified_name text,
  quality_rating text,
  messaging_limit_tier text,
  status text not null default 'connected' check (status in ('pending', 'connected', 'flagged', 'restricted', 'disconnected')),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger whatsapp_phone_numbers_touch before update on public.whatsapp_phone_numbers for each row execute function app.touch_updated_at();

-- Encrypted third-party credentials (AES-256-GCM, key from INTEGRATION_ENCRYPTION_KEY).
-- RLS enabled with NO policies and NO grant to authenticated: only backend service code reads it.
create table public.integration_credentials (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  provider text not null check (provider in ('meta_whatsapp', 'meta_instagram', 'gemini', 'google', 'erp', 'apps_script')),
  label text not null,
  ciphertext text not null,
  iv text not null,
  auth_tag text not null,
  key_version integer not null default 1,
  last_four text,
  expires_at timestamptz,
  rotated_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, provider, label)
);
create index integration_credentials_business_idx on public.integration_credentials (business_id);
create trigger integration_credentials_touch before update on public.integration_credentials for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- CRM
-- ---------------------------------------------------------------------------
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null default '',
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email text,
  source text not null default 'manual',
  language text not null default 'en' check (language in ('en', 'kn')),
  birthday date,
  assigned_to uuid references public.profiles(id) on delete set null,
  custom_fields jsonb not null default '{}'::jsonb,
  last_contacted_at timestamptz,
  opted_out_at timestamptz,
  archived_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, phone_e164)
);
create index contacts_business_name_idx on public.contacts (business_id, lower(name));
create trigger contacts_touch before update on public.contacts for each row execute function app.touch_updated_at();

create table public.contact_consents (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  channel text not null default 'whatsapp' check (channel in ('whatsapp', 'instagram', 'email', 'sms')),
  purpose text not null check (purpose in ('marketing', 'utility', 'service')),
  status text not null check (status in ('granted', 'revoked')),
  source text not null,                      -- e.g. 'gym_enquiry_form', 'csv_import', 'whatsapp_keyword'
  evidence jsonb not null default '{}'::jsonb, -- form id, IP, wording shown, import file, etc.
  captured_by uuid references public.profiles(id) on delete set null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index contact_consents_contact_idx on public.contact_consents (contact_id, purpose, occurred_at desc);

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  color text not null default '#2563eb',
  created_at timestamptz not null default now()
);
create unique index tags_business_name_key on public.tags (business_id, lower(name));

create table public.contact_tags (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (contact_id, tag_id)
);

create table public.segments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  description text not null default '',
  filter jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger segments_touch before update on public.segments for each row execute function app.touch_updated_at();

create table public.custom_field_definitions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,40}$'),
  label text not null,
  field_type text not null check (field_type in ('text', 'number', 'date', 'boolean', 'select')),
  options jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (business_id, key)
);

create table public.contact_notes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);

create table public.lead_pipelines (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.lead_stages (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  pipeline_id uuid not null references public.lead_pipelines(id) on delete cascade,
  name text not null,
  position integer not null,
  is_won boolean not null default false,
  is_lost boolean not null default false,
  created_at timestamptz not null default now(),
  unique (pipeline_id, position)
);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  pipeline_id uuid references public.lead_pipelines(id) on delete set null,
  stage_id uuid references public.lead_stages(id) on delete set null,
  title text not null,
  source text not null default 'manual',
  value_paise bigint check (value_paise >= 0),
  status text not null default 'open' check (status in ('open', 'won', 'lost')),
  assigned_to uuid references public.profiles(id) on delete set null,
  expected_close_date date,
  lost_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index leads_business_created_idx on public.leads (business_id, created_at desc);
create trigger leads_touch before update on public.leads for each row execute function app.touch_updated_at();

create table public.follow_up_tasks (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,
  title text not null,
  description text not null default '',
  due_at timestamptz,
  assigned_to uuid references public.profiles(id) on delete set null,
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  completed_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index follow_up_tasks_due_idx on public.follow_up_tasks (business_id, status, due_at);
create trigger follow_up_tasks_touch before update on public.follow_up_tasks for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Templates, conversations, messages
-- ---------------------------------------------------------------------------
create table public.message_templates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  whatsapp_account_id uuid references public.whatsapp_accounts(id) on delete cascade,
  name text not null check (name ~ '^[a-z0-9_]{1,512}$'),
  language text not null default 'en',
  category text not null check (category in ('MARKETING', 'UTILITY', 'AUTHENTICATION')),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED')),
  meta_template_id text,
  components jsonb not null default '[]'::jsonb,
  variable_mapping jsonb not null default '{}'::jsonb,   -- {"1": "customer_name", "2": "membership_expiry"}
  rejection_reason text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, name, language)
);
create trigger message_templates_touch before update on public.message_templates for each row execute function app.touch_updated_at();

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  channel text not null default 'whatsapp' check (channel in ('whatsapp', 'instagram')),
  phone_number_id uuid references public.whatsapp_phone_numbers(id) on delete set null,
  status text not null default 'open' check (status in ('open', 'pending', 'closed')),
  assigned_to uuid references public.profiles(id) on delete set null,
  last_message_at timestamptz,
  last_inbound_at timestamptz,          -- drives the 24-hour customer service window
  unread_count integer not null default 0,
  ai_active boolean not null default false,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index conversations_open_per_contact on public.conversations (business_id, contact_id, channel) where status <> 'closed';
create index conversations_list_idx on public.conversations (business_id, status, last_message_at desc);
create index conversations_assigned_idx on public.conversations (business_id, assigned_to);
create trigger conversations_touch before update on public.conversations for each row execute function app.touch_updated_at();

create table public.conversation_notes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);

create table public.canned_replies (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  shortcut text not null check (shortcut ~ '^[a-z0-9_-]{1,40}$'),
  title text not null,
  body text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (business_id, shortcut)
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  template_id uuid references public.message_templates(id) on delete restrict,
  phone_number_id uuid references public.whatsapp_phone_numbers(id) on delete restrict,
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'processing', 'paused', 'completed', 'partially_completed', 'failed', 'cancelled')),
  audience jsonb not null default '{}'::jsonb,           -- {"tag_ids": [...], "segment_id": ...}
  variable_mapping jsonb not null default '{}'::jsonb,
  media jsonb,
  scheduled_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  total_recipients integer not null default 0,
  sent_count integer not null default 0,
  delivered_count integer not null default 0,
  read_count integer not null default 0,
  failed_count integer not null default 0,
  replied_count integer not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index campaigns_status_idx on public.campaigns (business_id, status, scheduled_at);
create trigger campaigns_touch before update on public.campaigns for each row execute function app.touch_updated_at();

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  message_type text not null default 'text' check (message_type in ('text', 'template', 'image', 'document', 'audio', 'video', 'sticker', 'location', 'interactive', 'reaction', 'system', 'unsupported')),
  body text,
  media jsonb,
  template_id uuid references public.message_templates(id) on delete set null,
  campaign_id uuid references public.campaigns(id) on delete set null,
  provider_message_id text,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'received')),
  error_code text,
  error_message text,
  sent_by uuid references public.profiles(id) on delete set null,
  sent_by_ai boolean not null default false,
  idempotency_key text,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now()
);
create index messages_conversation_idx on public.messages (conversation_id, created_at);
create index messages_business_created_idx on public.messages (business_id, created_at desc);
create unique index messages_provider_id_key on public.messages (provider_message_id) where provider_message_id is not null;
create unique index messages_idempotency_key on public.messages (business_id, idempotency_key) where idempotency_key is not null;

create table public.message_status_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  message_id uuid references public.messages(id) on delete cascade,
  provider_message_id text not null,
  status text not null check (status in ('sent', 'delivered', 'read', 'failed')),
  error jsonb,
  pricing jsonb,                       -- Meta's pricing object, stored verbatim for cost reports
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (provider_message_id, status)
);

create table public.campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  phone_e164 text not null,
  variables jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'skipped', 'queued', 'sent', 'delivered', 'read', 'failed', 'replied')),
  skip_reason text,                    -- 'no_consent', 'opted_out', 'suppressed', 'invalid_phone', 'duplicate', 'quota'
  message_id uuid references public.messages(id) on delete set null,
  error_code text,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, contact_id)
);
create index campaign_recipients_status_idx on public.campaign_recipients (campaign_id, status);
create trigger campaign_recipients_touch before update on public.campaign_recipients for each row execute function app.touch_updated_at();

-- business_id null => global DigiMithra suppression (abuse, legal requests)
create table public.suppression_lists (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.businesses(id) on delete cascade,
  phone_e164 text not null,
  reason text not null check (reason in ('opt_out', 'stop_keyword', 'abuse', 'legal_request', 'manual')),
  source text not null default 'manual',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index suppression_lists_key on public.suppression_lists (coalesce(business_id, '00000000-0000-0000-0000-000000000000'::uuid), phone_e164);

-- Inbound webhook log; unique (provider, event_id) gives idempotency. Service-only.
create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('meta', 'razorpay', 'google_forms', 'erp')),
  event_id text not null,
  business_id uuid references public.businesses(id) on delete set null,
  signature_valid boolean not null,
  payload jsonb not null,
  status text not null default 'received' check (status in ('received', 'processed', 'failed', 'ignored')),
  error text,
  attempts integer not null default 0,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, event_id)
);
create index webhook_events_status_idx on public.webhook_events (status, received_at);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
select app.apply_tenant_policies('connected_channels',       array['owner']);
select app.apply_tenant_policies('whatsapp_accounts',        array['owner']);
select app.apply_tenant_policies('whatsapp_phone_numbers',   array['owner']);
select app.apply_tenant_policies('contacts',                 array['owner', 'manager']);
select app.apply_tenant_policies('contact_consents',         array['owner', 'manager']);
select app.apply_tenant_policies('tags',                     array['owner', 'manager']);
select app.apply_tenant_policies('contact_tags',             array['owner', 'manager']);
select app.apply_tenant_policies('segments',                 array['owner', 'manager']);
select app.apply_tenant_policies('custom_field_definitions', array['owner', 'manager']);
select app.apply_tenant_policies('contact_notes',            array['owner', 'manager', 'agent']);
select app.apply_tenant_policies('lead_pipelines',           array['owner', 'manager']);
select app.apply_tenant_policies('lead_stages',              array['owner', 'manager']);
select app.apply_tenant_policies('leads',                    array['owner', 'manager', 'agent']);
select app.apply_tenant_policies('follow_up_tasks',          array['owner', 'manager', 'agent']);
select app.apply_tenant_policies('message_templates',        array['owner', 'manager']);
select app.apply_tenant_policies('canned_replies',           array['owner', 'manager']);
select app.apply_tenant_policies('campaigns',                array['owner', 'manager']);
select app.apply_tenant_policies('suppression_lists',        array['owner', 'manager']);
select app.apply_tenant_readonly_policies('campaign_recipients',   array['owner', 'manager']);
select app.apply_tenant_readonly_policies('message_status_events', array['owner', 'manager']);

-- integration_credentials & webhook_events: RLS on, no policies, no authenticated grants.
alter table public.integration_credentials enable row level security;
alter table public.webhook_events enable row level security;
grant select, insert, update, delete on public.integration_credentials, public.webhook_events to service_role;

-- Conversations: owners/managers see all; agents see assigned + unassigned queue.
alter table public.conversations enable row level security;
create policy conversations_select on public.conversations for select to authenticated using (
  app.has_business_role(business_id, array['owner', 'manager'])
  or (app.has_business_role(business_id, array['agent']) and (assigned_to = auth.uid() or assigned_to is null))
);
create policy conversations_insert on public.conversations for insert to authenticated
  with check (app.has_business_role(business_id, array['owner', 'manager']));
create policy conversations_update on public.conversations for update to authenticated using (
  app.has_business_role(business_id, array['owner', 'manager'])
  or (app.has_business_role(business_id, array['agent']) and (assigned_to = auth.uid() or assigned_to is null))
) with check (
  app.has_business_role(business_id, array['owner', 'manager'])
  or (app.has_business_role(business_id, array['agent']) and assigned_to = auth.uid())
);
grant select, insert, update on public.conversations to authenticated;
grant select, insert, update, delete on public.conversations to service_role;

-- Messages & conversation notes follow conversation visibility (the subquery is itself RLS-filtered).
alter table public.messages enable row level security;
create policy messages_select on public.messages for select to authenticated using (
  exists (select 1 from public.conversations c where c.id = conversation_id and c.business_id = messages.business_id)
);
create policy messages_insert on public.messages for insert to authenticated with check (
  direction = 'outbound'
  and sent_by = auth.uid()
  and exists (select 1 from public.conversations c where c.id = conversation_id and c.business_id = messages.business_id)
);
grant select, insert on public.messages to authenticated;
grant select, insert, update, delete on public.messages to service_role;

alter table public.conversation_notes enable row level security;
create policy conversation_notes_select on public.conversation_notes for select to authenticated using (
  exists (select 1 from public.conversations c where c.id = conversation_id and c.business_id = conversation_notes.business_id)
);
create policy conversation_notes_insert on public.conversation_notes for insert to authenticated with check (
  author_id = auth.uid()
  and exists (select 1 from public.conversations c where c.id = conversation_id and c.business_id = conversation_notes.business_id)
);
grant select, insert on public.conversation_notes to authenticated;
grant select, insert, update, delete on public.conversation_notes to service_role;

create index messages_business_idx on public.messages (business_id);
create index conversation_notes_business_idx on public.conversation_notes (business_id);

revoke all on all tables in schema public from anon;
