-- ============================================================
-- Local development seed (auto-run by `supabase start` / `supabase db reset`).
--
-- This file exists ONLY to make the local Supabase stack match the grant
-- behaviour of the hosted Supabase project. It is not used by production.
--
-- Why this is needed:
--   When the Supabase CLI applies the migrations locally, every table in the
--   `public` schema is created by the `postgres` role. In the local Postgres
--   image the DEFAULT PRIVILEGES for postgres-owned tables grant only
--   TRUNCATE/REFERENCES/TRIGGER/MAINTAIN to anon/authenticated -- they omit
--   SELECT/INSERT/UPDATE/DELETE. On hosted Supabase those DML privileges are
--   granted (tables effectively receive ALL for anon/authenticated, with Row
--   Level Security doing the actual access control). Without them every client
--   query fails with `permission denied for table ...`.
--
--   The migrations in this repo deliberately rely on that ambient hosted grant
--   (they only ever GRANT/REVOKE on functions, never on tables), so we
--   reproduce it here for local dev. RLS policies remain the real gatekeeper.
--
-- NOTE: We intentionally do NOT touch function privileges here -- the
-- migrations already grant/revoke EXECUTE on the SECURITY DEFINER RPCs
-- (e.g. anon is revoked from the sensitive game RPCs), and a blanket grant
-- would undo that.
-- ============================================================

grant usage on schema public to anon, authenticated, service_role;

-- Existing tables/sequences created by the migrations.
grant select, insert, update, delete on all tables in schema public
  to anon, authenticated, service_role;
grant usage, select on all sequences in schema public
  to anon, authenticated, service_role;

-- Any tables/sequences created later by `postgres` (future migrations).
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables
  to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant usage, select on sequences
  to anon, authenticated, service_role;
