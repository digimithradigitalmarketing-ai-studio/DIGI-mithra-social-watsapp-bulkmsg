-- ============================================================================
-- DigiMithra Social Pilot — 0012 Revoke public execute on public.rls_auto_enable()
-- A Supabase project function (SECURITY DEFINER) that the advisor flagged as
-- callable by anon and signed-in users through /rest/v1/rpc. Not used by the app.
-- Guarded so it also applies to the local test database, which lacks the function.
-- ============================================================================
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  ) then
    revoke execute on function public.rls_auto_enable() from anon, authenticated;
  end if;
end $$;
