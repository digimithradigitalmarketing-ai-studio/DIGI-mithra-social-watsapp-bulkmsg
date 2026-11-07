-- ============================================================================
-- DigiMithra Social Pilot — 0007 Phase 4: automation engine
-- ============================================================================

alter table public.automation_workflows
  add column draft_definition jsonb,
  add column draft_updated_at timestamptz,
  add column published_at timestamptz;

alter table public.automation_executions
  add column cursor jsonb not null default '[0]'::jsonb,       -- path into the step tree, e.g. [2, "no", 0]
  add column context jsonb not null default '{}'::jsonb,       -- conversationId, leadId, eventText…
  add column steps_run integer not null default 0,
  add column next_run_at timestamptz;
create index automation_executions_status_idx on public.automation_executions (business_id, status, started_at desc);
create index automation_workflows_trigger_idx on public.automation_workflows (business_id, trigger_type) where status = 'published';

-- In-app notifications (notify_staff action) — title/link live in metadata.
create index notification_logs_unread_idx on public.notification_logs (user_id) where read_at is null;

revoke all on all tables in schema public from anon;
