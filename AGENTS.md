# AGENTS.md

General project docs, commands, schema, and QA protocol live in `CLAUDE.md` (and
`.cursorrules`). Read those first. This file only adds Cursor Cloud specifics.

## Cursor Cloud specific instructions

### TL;DR — local Supabase, not the hosted project

Unlike a laptop, the Cloud Agent VM **cannot reach the hosted `coup-dev` Supabase
project** (its domain does not even resolve — DNS fails). So local development
here runs against a **self-contained local Supabase stack** (Docker), and
`.env.local` points at that local stack rather than at `coup-dev`. Do **not**
repoint `.env.local` at the hosted project on this VM.

The VM snapshot already has Docker, the Supabase CLI, the pulled Supabase Docker
images, and a working `.env.local` on disk. The startup script only runs
`npm install`; you start the services yourself (see below).

### Bringing the environment up (services are NOT auto-started)

Run these from `/workspace` (each is safe to re-run):

1. Docker daemon (needed by the Supabase stack). If `docker info` fails, start it:
   `sudo dockerd` (leave running, e.g. in a tmux session) then
   `sudo chmod 666 /var/run/docker.sock` so non-root can use it.
2. Local Supabase: `supabase start` (first run ~1 min; afterwards it just
   restarts the existing containers). This applies every migration in
   `supabase/migrations/` plus `supabase/seed.sql`.
3. `.env.local` must contain the **local** stack values (deterministic demo
   key — safe to hardcode, it is not a real secret):
   ```
   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
   NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0
   ```
   (`.env.local` is gitignored. `supabase status` reprints these values.)
4. `npm run dev` → app on http://localhost:3000. `npm run build`, `npm run lint`,
   `npm test` all work once the stack + `.env.local` are in place.

Supabase Studio is at http://127.0.0.1:54323 and email testing (Mailpit) at
http://127.0.0.1:54324.

### Non-obvious gotchas

- **`supabase/seed.sql` is a local-only grant fix, not seed data.** When the CLI
  applies migrations locally, every `public` table is owned by the `postgres`
  role, and this Postgres image's default privileges for postgres-owned tables
  grant `anon`/`authenticated` only TRUNCATE/REFERENCES/TRIGGER — **not**
  SELECT/INSERT/UPDATE/DELETE. Hosted Supabase grants those (RLS is the real
  gatekeeper), and the migrations rely on that ambient grant (they only ever
  GRANT/REVOKE on functions). `seed.sql` reproduces the table grants locally.
  Symptom if it is ever missing/not applied: every query fails with
  `permission denied for table <name>` (HTTP 403) even though auth succeeds.
  `seed.sql` re-runs on `supabase db reset` and on a fresh `supabase start`.
- **Anonymous sign-ins are enabled** in `supabase/config.toml`
  (`enable_anonymous_sign_ins = true`) so the Guest login flow works locally.
  Email/password works too; email confirmations are disabled locally, and
  confirmation mails (if any) land in Mailpit.
- **ESLint ignores `supabase/.temp/**`** (see `eslint.config.mjs`). `supabase start`
  drops a generated edge-runtime `.ts` file there; without the ignore
  `npm run lint` reports ~150 bogus errors from that minified artifact.
- **Realtime multiplayer testing needs two independent auth sessions** — use a
  normal window + an incognito/private window (or two isolated browser
  contexts). A single browser profile shares one Supabase session. All game
  tables already have `REPLICA IDENTITY FULL` (required for RLS-filtered
  realtime; see `CLAUDE.md`).
- A `supabase db reset` wipes local data and re-applies migrations + seed; it
  does not touch the hosted project.
