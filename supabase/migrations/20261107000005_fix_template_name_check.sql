-- Postgres regex repetition counts are limited to 255, so '^[a-z0-9_]{1,512}$' raised
-- "invalid repetition count(s)" on insert. Replace with an equivalent check.
alter table public.message_templates drop constraint if exists message_templates_name_check;
alter table public.message_templates add constraint message_templates_name_check
  check (name ~ '^[a-z0-9_]+$' and char_length(name) <= 512);
