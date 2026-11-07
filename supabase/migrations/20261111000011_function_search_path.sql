-- ============================================================================
-- DigiMithra Social Pilot — 0011 Fix mutable search_path on app functions
-- Supabase advisor (function_search_path_mutable). Each function body already
-- uses schema-qualified names (app.*, public.*) and pg_catalog built-ins, so an
-- empty search_path is safe and prevents object shadowing.
-- ============================================================================
alter function app.touch_updated_at() set search_path = '';
alter function app.prevent_audit_mutation() set search_path = '';
alter function app.prevent_consent_mutation() set search_path = '';
alter function app.apply_tenant_policies(text, text[]) set search_path = '';
alter function app.apply_tenant_readonly_policies(text, text[]) set search_path = '';
