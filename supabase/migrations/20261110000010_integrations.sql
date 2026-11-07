-- ============================================================================
-- DigiMithra Social Pilot — 0010 Phase 7: integrations (signed lead intake)
-- Integration keys let an external form (Google Forms via Apps Script) post
-- enquiries. The secret is encrypted at rest with INTEGRATION_ENCRYPTION_KEY
-- and is never readable by the authenticated role.
-- ============================================================================
create table public.integration_keys (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  kind text not null default 'lead_intake' check (kind in ('lead_intake')),
  key_id text not null unique,
  secret_ciphertext text not null,
  secret_iv text not null,
  secret_auth_tag text not null,
  key_version integer not null default 1,
  last_four text not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index integration_keys_business_idx on public.integration_keys (business_id);

-- Service-only: no grants or policies for the authenticated role.
alter table public.integration_keys enable row level security;
revoke all on public.integration_keys from authenticated;
