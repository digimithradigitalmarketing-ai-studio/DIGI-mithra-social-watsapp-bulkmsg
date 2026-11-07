-- ============================================================================
-- DigiMithra Social Pilot — 0001 Foundation
-- identity, tenancy, roles, plans, subscriptions, settings, audit
-- ============================================================================

create schema if not exists app;

-- ---------------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------------
create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null default '',
  phone text,
  preferred_language text not null default 'en' check (preferred_language in ('en', 'kn')),
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index profiles_email_key on public.profiles (lower(email));
create trigger profiles_touch before update on public.profiles for each row execute function app.touch_updated_at();

create or replace function app.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- platform_admins (DigiMithra Super Admins).  No API route writes this table.
-- ---------------------------------------------------------------------------
create table public.platform_admins (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  granted_by text not null,             -- operator identity from provisioning script
  note text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- businesses (tenants / workspaces)
-- ---------------------------------------------------------------------------
create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  industry text,
  phone text,
  email text,
  website text,
  address text,
  city text,
  state text,
  country text not null default 'IN',
  timezone text not null default 'Asia/Kolkata',
  currency text not null default 'INR',
  default_language text not null default 'en' check (default_language in ('en', 'kn')),
  status text not null default 'active' check (status in ('active', 'suspended', 'closed')),
  suspended_reason text,
  suspended_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index businesses_status_idx on public.businesses (status);
create trigger businesses_touch before update on public.businesses for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- business_roles: catalogue of roles and their permissions.
-- business_id null => system role available to every workspace.
-- ---------------------------------------------------------------------------
create table public.business_roles (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.businesses(id) on delete cascade,
  key text not null,
  name text not null,
  description text not null default '',
  permissions text[] not null default '{}',
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index business_roles_key on public.business_roles (coalesce(business_id, '00000000-0000-0000-0000-000000000000'::uuid), key);
create trigger business_roles_touch before update on public.business_roles for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- business_members
-- ---------------------------------------------------------------------------
create table public.business_members (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('owner', 'manager', 'agent')),
  status text not null default 'active' check (status in ('active', 'disabled')),
  invited_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, user_id)
);
create index business_members_user_idx on public.business_members (user_id);
create trigger business_members_touch before update on public.business_members for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- business_invitations
-- ---------------------------------------------------------------------------
create table public.business_invitations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  email text not null,
  role text not null check (role in ('manager', 'agent')),
  token_hash text not null unique,
  invited_by uuid references public.profiles(id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references public.profiles(id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index business_invitations_business_idx on public.business_invitations (business_id);
create unique index business_invitations_pending_email
  on public.business_invitations (business_id, lower(email))
  where accepted_at is null and revoked_at is null;

-- ---------------------------------------------------------------------------
-- Authorization helper functions (SECURITY DEFINER so they can be used inside
-- RLS policies without recursive policy evaluation).
-- ---------------------------------------------------------------------------
create or replace function app.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid())
$$;

create or replace function app.is_business_member(p_business_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.business_members m
    join public.businesses b on b.id = m.business_id
    where m.business_id = p_business_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and b.status = 'active'
  )
$$;

create or replace function app.has_business_role(p_business_id uuid, p_roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.business_members m
    join public.businesses b on b.id = m.business_id
    where m.business_id = p_business_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and b.status = 'active'
      and m.role = any (p_roles)
  )
$$;

create or replace function app.shares_business_with(p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.business_members a
    join public.business_members b on a.business_id = b.business_id
    where a.user_id = auth.uid() and a.status = 'active' and b.user_id = p_user_id
  )
$$;

-- ---------------------------------------------------------------------------
-- subscription_plans (managed by Super Admin; prices in paise)
-- ---------------------------------------------------------------------------
create table public.subscription_plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text not null default '',
  currency text not null default 'INR',
  monthly_price_paise integer not null check (monthly_price_paise >= 0),
  annual_price_paise integer not null check (annual_price_paise >= 0),
  trial_days integer not null default 14 check (trial_days between 0 and 90),
  limits jsonb not null default '{}'::jsonb,
  features text[] not null default '{}',
  is_active boolean not null default true,
  sort_order integer not null default 0,
  razorpay_plan_id_monthly text,
  razorpay_plan_id_annual text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger subscription_plans_touch before update on public.subscription_plans for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- subscriptions (one current subscription per business)
-- ---------------------------------------------------------------------------
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null unique references public.businesses(id) on delete cascade,
  plan_id uuid not null references public.subscription_plans(id),
  status text not null check (status in ('trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired')),
  billing_cycle text not null default 'monthly' check (billing_cycle in ('monthly', 'annual')),
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  razorpay_subscription_id text unique,
  razorpay_customer_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index subscriptions_status_idx on public.subscriptions (status);
create trigger subscriptions_touch before update on public.subscriptions for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- system_settings (platform-wide config, service-only)
-- ---------------------------------------------------------------------------
create table public.system_settings (
  key text primary key,
  value jsonb not null,
  description text not null default '',
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger system_settings_touch before update on public.system_settings for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- audit_logs (append-only)
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.businesses(id) on delete set null,
  actor_user_id uuid references public.profiles(id) on delete set null,
  actor_type text not null default 'user' check (actor_type in ('user', 'platform_admin', 'system', 'integration')),
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index audit_logs_business_idx on public.audit_logs (business_id, created_at desc);
create index audit_logs_created_idx on public.audit_logs (created_at desc);

create or replace function app.prevent_audit_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_logs is append-only';
end $$;
create trigger audit_logs_no_update before update or delete on public.audit_logs
  for each row execute function app.prevent_audit_mutation();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.platform_admins enable row level security;
alter table public.businesses enable row level security;
alter table public.business_roles enable row level security;
alter table public.business_members enable row level security;
alter table public.business_invitations enable row level security;
alter table public.subscription_plans enable row level security;
alter table public.subscriptions enable row level security;
alter table public.system_settings enable row level security;
alter table public.audit_logs enable row level security;

-- profiles: see yourself and teammates; edit only yourself
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or app.shares_business_with(id) or app.is_platform_admin());
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- platform_admins: a user may only learn whether they themselves are an admin
create policy platform_admins_self on public.platform_admins for select to authenticated
  using (user_id = auth.uid());

-- businesses: members read; owner updates profile fields; inserts via service ops only
create policy businesses_select on public.businesses for select to authenticated
  using (app.is_business_member(id) or app.is_platform_admin());
create policy businesses_update on public.businesses for update to authenticated
  using (app.has_business_role(id, array['owner'])) with check (app.has_business_role(id, array['owner']));

-- business_roles: system roles visible to all signed-in users, custom roles to members
create policy business_roles_select on public.business_roles for select to authenticated
  using (business_id is null or app.is_business_member(business_id));
create policy business_roles_write on public.business_roles for all to authenticated
  using (business_id is not null and app.has_business_role(business_id, array['owner']))
  with check (business_id is not null and app.has_business_role(business_id, array['owner']));

-- business_members: teammates read; owners manage everyone; managers manage agents only
create policy business_members_select on public.business_members for select to authenticated
  using (app.is_business_member(business_id) or app.is_platform_admin());
create policy business_members_update on public.business_members for update to authenticated
  using (app.has_business_role(business_id, array['owner'])
         or (app.has_business_role(business_id, array['manager']) and role = 'agent'))
  with check (app.has_business_role(business_id, array['owner'])
         or (app.has_business_role(business_id, array['manager']) and role = 'agent'));
create policy business_members_delete on public.business_members for delete to authenticated
  using (app.has_business_role(business_id, array['owner'])
         or (app.has_business_role(business_id, array['manager']) and role = 'agent'));

-- business_invitations: owners any role, managers agent invitations only
create policy business_invitations_select on public.business_invitations for select to authenticated
  using (app.has_business_role(business_id, array['owner', 'manager']));
create policy business_invitations_insert on public.business_invitations for insert to authenticated
  with check (app.has_business_role(business_id, array['owner'])
              or (app.has_business_role(business_id, array['manager']) and role = 'agent'));
create policy business_invitations_update on public.business_invitations for update to authenticated
  using (app.has_business_role(business_id, array['owner'])
         or (app.has_business_role(business_id, array['manager']) and role = 'agent'));

-- plans: readable by any signed-in user (pricing page); writes service-only (admin routes)
create policy subscription_plans_select on public.subscription_plans for select to authenticated
  using (is_active or app.is_platform_admin());

-- subscriptions: members read their own workspace's subscription
create policy subscriptions_select on public.subscriptions for select to authenticated
  using (app.is_business_member(business_id) or app.is_platform_admin());

-- system_settings: no policies => no access for authenticated (service only)

-- audit_logs: owners/managers read their workspace log; platform admins read all
create policy audit_logs_select on public.audit_logs for select to authenticated
  using ((business_id is not null and app.has_business_role(business_id, array['owner', 'manager']))
         or app.is_platform_admin());

-- ---------------------------------------------------------------------------
-- Grants.  anon gets nothing.  authenticated gets table privileges but RLS
-- decides rows.  service_role is used only by trusted backend code.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
grant usage on schema app to authenticated, service_role;
grant execute on all functions in schema app to authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
revoke insert, update, delete on public.platform_admins, public.subscription_plans, public.subscriptions,
  public.system_settings, public.audit_logs from authenticated;
revoke all on public.system_settings from authenticated;

-- ---------------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------------
insert into public.business_roles (business_id, key, name, description, permissions, is_system) values
  (null, 'owner', 'Business Owner', 'Full control of the workspace including billing and channels.',
   array['business.read','business.update','members.read','members.manage','members.invite_agent','billing.read','billing.manage',
         'channels.manage','contacts.read','contacts.write','contacts.export','campaigns.read','campaigns.manage','templates.manage',
         'conversations.read_all','conversations.read_assigned','conversations.reply','conversations.assign','leads.update',
         'automation.manage','ai.manage','analytics.read','audit.read','api_keys.manage','privacy.manage'], true),
  (null, 'manager', 'Business Manager', 'Runs campaigns, contacts, conversations and agents.',
   array['business.read','members.read','members.invite_agent','billing.read','contacts.read','contacts.write','contacts.export',
         'campaigns.read','campaigns.manage','templates.manage','conversations.read_all','conversations.read_assigned',
         'conversations.reply','conversations.assign','leads.update','automation.manage','ai.manage','analytics.read','audit.read'], true),
  (null, 'agent', 'Business Agent', 'Handles assigned conversations and updates permitted lead information.',
   array['business.read','members.read','contacts.read','conversations.read_assigned','conversations.reply','leads.update'], true);

insert into public.subscription_plans (code, name, description, monthly_price_paise, annual_price_paise, trial_days, limits, features, sort_order) values
  ('starter', 'Starter', 'Basic CRM, WhatsApp campaigns and basic analytics.', 99900, 999000, 14,
   '{"contacts": 1000, "staff_seats": 2, "workflows": 0, "ai_tokens_monthly": 0, "storage_mb": 500, "broadcasts_monthly": 10}',
   array['crm_basic', 'whatsapp_campaigns', 'analytics_basic'], 1),
  ('growth', 'Growth', 'Everything in Starter plus team inbox, automation and advanced reporting.', 199900, 1999000, 14,
   '{"contacts": 5000, "staff_seats": 5, "workflows": 10, "ai_tokens_monthly": 0, "storage_mb": 2048, "broadcasts_monthly": 50}',
   array['crm_basic', 'whatsapp_campaigns', 'analytics_basic', 'team_inbox', 'automation', 'analytics_advanced'], 2),
  ('business', 'Business', 'Everything in Growth plus business AI support and higher limits.', 399900, 3999000, 14,
   '{"contacts": 25000, "staff_seats": 15, "workflows": 50, "ai_tokens_monthly": 2000000, "storage_mb": 10240, "broadcasts_monthly": 250}',
   array['crm_basic', 'whatsapp_campaigns', 'analytics_basic', 'team_inbox', 'automation', 'analytics_advanced', 'ai_support', 'automation_advanced'], 3);

insert into public.system_settings (key, value, description) values
  ('default_plan_code', '"starter"', 'Plan assigned (as a trial) to newly created workspaces.'),
  ('signups_enabled', 'true', 'Allow new public account registration.'),
  ('max_workspaces_per_user', '3', 'Abuse control: workspaces a single account may create.');
