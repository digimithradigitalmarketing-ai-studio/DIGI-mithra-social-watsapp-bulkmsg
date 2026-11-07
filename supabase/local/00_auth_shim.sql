-- ============================================================================
-- LOCAL DEVELOPMENT / TEST ONLY.  NEVER apply this file to a Supabase project.
-- Recreates the small subset of Supabase that our migrations depend on:
--   * roles anon / authenticated / service_role
--   * schema auth with auth.users, auth.uid(), auth.jwt()
-- plus local-only tables used by AUTH_PROVIDER=local (tokens, TOTP factors).
-- ============================================================================

do $$ begin create role anon nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin noinherit bypassrls; exception when duplicate_object then null; end $$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists users_email_key on auth.users (lower(email));

-- Mirrors Supabase's implementation: reads the verified JWT claims the API sets per request.
create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(
    coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), auth.jwt() ->> 'sub'),
    ''
  )::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;

-- Local provider: one-time tokens (refresh, email verification, password reset, invitations use their own table)
create table if not exists auth.local_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('refresh', 'verify_email', 'reset_password')),
  token_hash text not null unique,
  meta jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- Local provider: TOTP MFA factors
create table if not exists auth.local_mfa_factors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  secret text not null,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

revoke all on auth.users, auth.local_tokens, auth.local_mfa_factors from anon, authenticated;
