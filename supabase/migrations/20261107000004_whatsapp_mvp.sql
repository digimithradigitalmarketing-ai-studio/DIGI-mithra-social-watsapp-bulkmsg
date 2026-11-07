-- ============================================================================
-- DigiMithra Social Pilot — 0004 Phase 2: WhatsApp MVP support
-- consent cache on contacts, job queue fields, campaign counters
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Contacts: cached current consent (source of truth stays contact_consents)
-- ---------------------------------------------------------------------------
alter table public.contacts
  add column marketing_opt_in boolean not null default false,
  add column marketing_consent_at timestamptz,
  add column marketing_consent_source text,
  add column utility_opt_in boolean not null default false,
  add column utility_consent_at timestamptz;

create index contacts_marketing_idx on public.contacts (business_id) where marketing_opt_in and opted_out_at is null and archived_at is null;

create or replace function app.sync_contact_consent() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.purpose = 'marketing' then
    update public.contacts set
      marketing_opt_in = (new.status = 'granted'),
      marketing_consent_at = new.occurred_at,
      marketing_consent_source = new.source,
      -- re-granting marketing consent clears a previous opt-out
      opted_out_at = case when new.status = 'granted' then null else coalesce(opted_out_at, new.occurred_at) end
    where id = new.contact_id;
  elsif new.purpose = 'utility' then
    update public.contacts set utility_opt_in = (new.status = 'granted'), utility_consent_at = new.occurred_at
    where id = new.contact_id;
  end if;
  return new;
end $$;

create trigger contact_consents_sync after insert on public.contact_consents
  for each row execute function app.sync_contact_consent();

-- Consent history is append-only evidence.
create or replace function app.prevent_consent_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'contact_consents is append-only; insert a new record instead';
end $$;
create trigger contact_consents_no_update before update on public.contact_consents
  for each row execute function app.prevent_consent_mutation();
revoke update, delete on public.contact_consents from authenticated;

-- ---------------------------------------------------------------------------
-- Job queue (Postgres-backed, FOR UPDATE SKIP LOCKED)
-- ---------------------------------------------------------------------------
alter table public.scheduled_jobs
  add column max_attempts integer not null default 5,
  add column finished_at timestamptz;
create index scheduled_jobs_kind_idx on public.scheduled_jobs (kind, status);

-- ---------------------------------------------------------------------------
-- Campaigns
-- ---------------------------------------------------------------------------
alter table public.campaigns
  add column skipped_count integer not null default 0,
  add column queued_count integer not null default 0,
  add column cancelled_reason text;

alter table public.campaign_recipients
  add column sent_at timestamptz,
  add column delivered_at timestamptz,
  add column read_at timestamptz,
  add column replied_at timestamptz,
  add column failed_at timestamptz,
  add column error_message text;

-- Template review/sync bookkeeping
alter table public.message_templates
  add column submitted_at timestamptz,
  add column provider text not null default 'meta_cloud' check (provider in ('meta_cloud', 'mock'));

-- Connected channels: who connected and how
alter table public.connected_channels add column connected_by uuid references public.profiles(id) on delete set null;

revoke all on all tables in schema public from anon;
