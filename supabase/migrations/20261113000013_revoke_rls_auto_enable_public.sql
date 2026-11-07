-- ============================================================================
-- DigiMithra Social Pilot — 0013 Revoke PUBLIC execute on public.rls_auto_enable()
-- Migration 0012 revoked anon and authenticated directly, but the function
-- still inherits PUBLIC execute, which both roles use. Revoke PUBLIC too.
-- Guarded so it also applies to the local test database.
-- ============================================================================
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  ) then
    revoke execute on function public.rls_auto_enable() from public;
  end if;
end $$;
