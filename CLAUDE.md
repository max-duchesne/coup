# CLAUDE.md

## Project Overview
**Coup** — a real-time multiplayer card game built with Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4, and Supabase.

## Tech Stack
- **Framework**: Next.js 16 (App Router, `app/` directory)
- **Language**: TypeScript (strict)
- **Styling**: Tailwind CSS v4 (PostCSS plugin)
- **Database / Auth / Realtime**: Supabase (`@supabase/ssr`, `@supabase/supabase-js`)
- **Deployment**: Vercel (production only, `main` branch)

## MCP Tools Available
- **GitHub** — repo, branches, PRs, issues
- **Chrome DevTools** — browser console, network, storage inspection
- **Tavily Search** — web search for docs and references
- **Supabase** — database queries, migrations, auth, logs
- **Next.js DevTools** — Next.js diagnostics
- **Vercel** — deployment logs, env vars

---

## Environments

| | Dev | Prod |
|---|---|---|
| **Supabase project** | `coup-dev` | `coup` |
| **Supabase ref** | `dogdmbbpahzpfnfyfkza` | (existing) |
| **GitHub branch** | `dev` | `main` |
| **Vercel** | — | Auto-deploys on merge to `main` |
| **Env file** | `.env.local` | Vercel environment variables |

`.env.local` always points at `coup-dev`. Never change it to prod keys locally.

```bash
NEXT_PUBLIC_SUPABASE_URL=https://dogdmbbpahzpfnfyfkza.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<coup-dev-anon-key>
```

---

## Git Workflow

**Never commit directly to `main` or `dev`.** All work happens on a feature branch.

### Starting Any Task
```bash
git checkout dev && git pull        # always branch from dev, not main
git checkout -b <type>/<description>
# e.g. feat/ambassador-exchange
#      fix/steal-coin-desync
#      chore/tighten-rls-policies
```

Branch naming: `feat/`, `fix/`, `chore/`, `refactor/` + short kebab-case description.

### Migration flow
```
feature/xyz  →  PR to dev   →  merge  →  manually push migration to coup-dev
    dev      →  PR to main  →  merge  →  GitHub integration auto-applies to coup (prod)
```

When a feature includes a migration:
1. Write the migration file in `supabase/migrations/`
2. Push it to `coup-dev`:
   ```bash
   supabase link --project-ref dogdmbbpahzpfnfyfkza
   supabase db push
   ```
3. Regen types: `supabase gen types typescript --project-id dogdmbbpahzpfnfyfkza > lib/database.types.ts`
4. Verify schema is correct before testing

### Before Opening a PR
1. `npm run build` — must pass with zero errors
2. `npm run lint` — must pass clean
3. Complete the QA checklist below
4. Use **GitHub MCP** to open PR targeting `dev` (not `main`) with a short description of what changed and what was tested
5. If a migration is included, note it explicitly in the PR description

### Shipping to Production
When `dev` is stable, open a PR from `dev` → `main`. Merging auto-triggers Vercel deploy and auto-applies pending migrations to the `coup` Supabase project.

---

## Commands
```bash
npm run dev      # Start dev server (http://localhost:3000)
npm run build    # Production build
npm run start    # Start production server
npm run lint     # ESLint
```

---

## Project Structure
```
app/
  [game_code]/
    _lobby.tsx       # Lobby view (ready-up, presence tracking)
    _game.tsx        # Game view (turns, actions, events)
    page.tsx         # Route — switches between lobby/game views
  profile/[id]/
    page.tsx         # Profile page — stats, game log, friends (self-edit only)
  login/             # Auth pages (Guest / Google / Email)
  auth/              # Auth callback
lib/
  supabase/
    client.ts        # Browser Supabase client
    server.ts        # Server Components / Actions Supabase client
    proxy.ts         # Session refresh middleware; redirects to /login if unauthenticated
  database.types.ts  # Auto-generated Supabase types
  game.ts            # Game logic helpers + action RPCs
  lobby-players.ts   # Lobby player CRUD
  player.ts          # usePlayer hook (auth.users-backed identity)
  profile.ts         # Profile CRUD + stats/game-log RPCs + useMyProfile
  friends.ts         # Friend list / request / accept helpers
  design.ts          # Design tokens
components/
  ui.tsx             # Shared UI primitives (Avatar, Card, Pill, Frame, etc.)
  AuthHeader.tsx     # Header widget — initials avatar, profile link, sign-out
  Chat.tsx           # In-game/lobby chat
supabase/
  migrations/        # SQL migrations (ordered by timestamp)
```

---

## Database Schema

### Game tables
| Table | Purpose |
|-------|---------|
| `players` | Lobby seats — id (= auth.uid()), game_code, name, is_ready |
| `games` | Active games — game_code (PK), current_turn_player_id, status, turn_phase, pending_*, cards_per_player, role_counts |
| `game_players` | Per-player game state — coins, seat_order, revealed_count |
| `player_influences` | Cards — role, is_revealed, position |
| `game_events` | Append-only event log — action, metadata (JSON), player_id. Source of truth for finished_at (`win` event) and elimination order. |
| `chat_messages` | In-game/lobby chat |

### Identity tables (authenticated users only)
| Table | Purpose |
|-------|---------|
| `profiles` | id (= auth.uid()), username (unique on `lower(username)`, 3–20 `[A-Za-z0-9_]`), created_at. Auto-created by trigger on `auth.users` INSERT/promotion **only for non-anonymous users**. Guests never get a profile. |
| `friendships` | requester_id, addressee_id, status (`pending`/`accepted`). Directional unique (requester, addressee) + pair-wise unique on `least/greatest` so A↔B can only exist once. No self-friending. |

### Supabase RPC Functions (SECURITY DEFINER)
Action flow:
- `deal_initial_influences(p_game_code)` — deals starting cards
- `draw_ambassador_cards(p_game_code)` — draws 2 cards for exchange
- `submit_challenge(p_game_code)` — moves `awaiting_challenge` → `awaiting_reveal`, records challenger
- `reveal_or_back_down(p_game_code, p_reveal)` — challenged player reveals (challenger loses influence + card swap) or backs down (claimant loses influence, action cancelled)
- `lose_influence_and_resolve(p_game_code, p_influence_id)` — reveals a card and resolves action / cascades win
- `set_lobby_player_order(p_game_code, p_ordered_ids)` — host sets seat order in lobby

Profile / stats:
- `get_player_stats(p_player_id)` — total/win counts (all-time + 30d) with win %
- `get_player_game_log(pid, p_limit)` — last N finished games with finish position (winner=1, then reverse-chronological elimination order)

**Deprecated** (still exists in DB but no app code calls it): `resolve_challenge` — replaced by `submit_challenge` + `reveal_or_back_down` in migration `20260524120000`.

---

## Auth & Security

Three auth flows, all via Supabase Auth:
- **Guest** — anonymous sign-in. No profile row, no friends, no profile link in header. Inline editable display name via `setPlayerName` (writes to `user_metadata.full_name`).
- **Email/password** — full account. Profile auto-created by trigger on `auth.users` INSERT (skips anonymous). Email confirmation is enabled on `coup-dev`; for QA you can confirm manually:
  ```sql
  update auth.users set email_confirmed_at = now() where email = 'tester@example.com';
  ```
- **Google OAuth** — full account. Same profile-creation trigger fires.

Anonymous → email/google upgrades fire a second trigger (`on_auth_user_promoted` on `auth.users` UPDATE of `is_anonymous`) that backfills the profile.

Security baseline:
- `auth.uid()` === player `id` everywhere (anon session UUID is the identity)
- Session refreshed on every request in `lib/supabase/proxy.ts`
- Public paths: `/login`, `/auth`
- **RLS is strict**:
  - `player_influences.SELECT` only your own cards (any state) or already-face-up cards
  - `profiles.SELECT` open to any authed user; `UPDATE` self-only
  - `friendships.SELECT` only rows where you are requester or addressee; INSERT requester=you, status=`pending`; UPDATE addressee-only, status→`accepted`
- All multi-row game mutations go through SECURITY DEFINER RPCs in the `public` schema
- **Never weaken RLS policies or use `service_role` key on the client**

---

## Realtime
- Channels subscribe to DB changes on: `players`, `games`, `game_players`, `player_influences`, `game_events`, `friendships`
- Presence tracking (online/offline) used in the lobby
- Pattern: subscribe in `useEffect`, clean up with `supabase.removeChannel(channel)`

**Gotcha — `REPLICA IDENTITY FULL`**: when realtime needs to evaluate RLS against an UPDATE/DELETE row, Postgres must include the full pre/post row state in the WAL. Tables without `REPLICA IDENTITY FULL` only get the PK in change events, so RLS filtering fails silently — subscribers see no event. Any new table that participates in realtime under RLS must have:
```sql
alter table public.<name> replica identity full;
```
The existing realtime tables (`players`, `games`, `game_players`, `player_influences`, `game_events`, `friendships`, `profiles`) all have it set. INSERT events are unaffected.

---

## Frontend conventions
- `auth.uid()` === player `id`
- `game_code` is always uppercase — enforce with `.toUpperCase()`
- Type DB rows via generated types in `lib/database.types.ts` (`Tables<'players'>`, etc.)
- Keep Supabase client imports from `@/lib/supabase` (not directly from `@supabase/supabase-js`)
- No `<form>` elements — use `onClick`/`onChange` handlers
- The ESLint rule `react-hooks/set-state-in-effect` (React 19) flags direct `setState(...)` and `void asyncFnThatSetsState()` inside `useEffect` bodies. Use the `.then(data => setState(data))` callback pattern instead — see `components/Chat.tsx` and `app/profile/[id]/page.tsx` for examples.

---

## Adding Migrations

Place new `.sql` files in `supabase/migrations/` with a timestamp prefix:
```
supabase/migrations/YYYYMMDDHHMMSS_description.sql
```

Then push to dev immediately so testing can proceed:
```bash
supabase link --project-ref dogdmbbpahzpfnfyfkza
supabase db push
supabase gen types typescript --project-id dogdmbbpahzpfnfyfkza > lib/database.types.ts
```

Use the **Supabase MCP** to verify the schema looks correct after pushing. Prod migrations are applied automatically when the PR merges to `main`.

**When changing a function signature**: grep for every caller and update them in the same migration. A previous migration changed `private.player_alive(integer)` → `(integer, integer)` and dropped the old overload; a later migration's new function still called it with one arg, which only surfaced when a player tried to challenge (generic "Action failed" toast — silent until an explicit code path hit it). Add the dropped-overload signature change and all callsite updates in the same migration whenever possible.

---

## Testing & QA Protocol

**No feature is done until it has been tested end-to-end.** Most bugs in a realtime multiplayer game only surface with 2+ concurrent sessions.

### Multi-Window Testing Setup
1. Open `http://localhost:3000` in **two browser contexts** (normal + incognito, or two `isolatedContext` Chrome DevTools pages) so each gets a distinct Supabase auth session
2. Each window = a separate player
3. Run through the full relevant flow: create lobby → join → ready up → start game → take turns through the changed action(s)
4. Verify both windows reflect correct state in real time **without refreshing**

### What to Check with MCP Tools

**Chrome DevTools MCP** (run on each window):
- Console: no errors or unhandled promise rejections
- Network: Supabase Realtime WebSocket is connected and receiving messages
- Application → Local Storage: player ID is stable

**Supabase MCP** (verify DB state directly after each action):
- Coins updated correctly
- `is_revealed` flipped correctly after losing influence
- `current_turn_player_id` advanced to the right player
- `game_events` has the correct entries (action, player_id, metadata)
- No orphaned rows in `player_influences` or `game_players`
- **Tail Postgres logs** via `mcp__supabase__get_logs` when a UI action silently fails — generic toasts like "Action failed" usually mean an RPC raised an exception (missing function, RLS denial, FK violation)

**Vercel MCP**: tail function logs for any server-side errors

### Scenarios to Always Cover

| Scenario | Why it's risky |
|---|---|
| Page refresh mid-game | Session restore, realtime resubscribe |
| Player joins late / reconnects | `upsertLobbyPlayer` idempotency |
| Challenge on a bluff | `submit_challenge` + `reveal_or_back_down` (back-down path) — claimant loses influence, action cancelled |
| Challenge on truth | `submit_challenge` + `reveal_or_back_down` (reveal path) — card swap, challenger loses influence |
| Block then challenge the block | Nested action/block/challenge state machine |
| Last player standing | Win condition, `status` → `finished`, `win` event written |
| Coup when target has 1 card left | Elimination flow |
| Ambassador exchange | Card draw, selection, return to deck |
| Friend request live arrival | INSERT realtime event triggers list refresh on addressee's open profile page |
| Friend accept live arrival | UPDATE realtime event triggers list refresh on requester's open profile page (requires `REPLICA IDENTITY FULL`) |

### Checklist Before Marking Done
- [ ] Tested with 2+ windows and distinct auth sessions
- [ ] No console errors in any window
- [ ] DB rows match expected state (verified via Supabase MCP)
- [ ] Realtime updates appear in all windows without a refresh
- [ ] Behavior is correct from every affected player's perspective
- [ ] No RLS violations in Supabase logs
- [ ] `npm run build` passes
- [ ] `npm run lint` passes
