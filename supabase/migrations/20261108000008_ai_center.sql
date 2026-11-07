-- ============================================================================
-- DigiMithra Social Pilot — 0008 Phase 5: AI Center
-- ============================================================================
alter table public.ai_settings
  add column handoff_keywords text[] not null default array['human', 'agent', 'person', 'manager', 'call me', 'complaint', 'refund'],
  add column handoff_notify_user_ids uuid[] not null default '{}',
  add column max_ai_replies_per_conversation integer not null default 6 check (max_ai_replies_per_conversation between 1 and 50),
  add column only_when_unassigned boolean not null default true;

alter table public.conversations
  add column ai_reply_count integer not null default 0,
  add column ai_handoff_reason text,
  add column ai_handoff_at timestamptz;

alter table public.ai_usage add column contact_id uuid references public.contacts(id) on delete set null;
create index ai_knowledge_sources_active_idx on public.ai_knowledge_sources (business_id) where status = 'active';

revoke all on all tables in schema public from anon;
