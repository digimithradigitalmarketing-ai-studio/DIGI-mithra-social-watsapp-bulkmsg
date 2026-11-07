-- ============================================================================
-- DigiMithra Social Pilot — 0006 Phase 3: team inbox & CRM
-- ============================================================================

alter table public.conversations
  add column last_outbound_at timestamptz,
  add column first_response_at timestamptz,
  add column closed_at timestamptz,
  add column closed_by uuid references public.profiles(id) on delete set null,
  add column last_message_preview text;

create index conversations_unread_idx on public.conversations (business_id) where unread_count > 0 and status <> 'closed';

-- Agents may add notes to contacts they can see and update leads/tasks; owners/managers manage everything.
-- (Policies for leads, follow_up_tasks and contact_notes were created in 0002 via app.apply_tenant_policies.)

-- Lead stage history for pipeline reporting
create table public.lead_stage_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  from_stage_id uuid references public.lead_stages(id) on delete set null,
  to_stage_id uuid references public.lead_stages(id) on delete set null,
  changed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index lead_stage_events_lead_idx on public.lead_stage_events (lead_id, created_at);
select app.apply_tenant_policies('lead_stage_events', array['owner', 'manager', 'agent']);

alter table public.leads add column notes text not null default '';
alter table public.follow_up_tasks add column conversation_id uuid references public.conversations(id) on delete set null;

revoke all on all tables in schema public from anon;

-- Agents may also leave a conversation unassigned (release it / mark the queue read), not only assign it to themselves.
drop policy conversations_update on public.conversations;
create policy conversations_update on public.conversations for update to authenticated using (
  app.has_business_role(business_id, array['owner', 'manager'])
  or (app.has_business_role(business_id, array['agent']) and (assigned_to = auth.uid() or assigned_to is null))
) with check (
  app.has_business_role(business_id, array['owner', 'manager'])
  or (app.has_business_role(business_id, array['agent']) and (assigned_to = auth.uid() or assigned_to is null))
);
