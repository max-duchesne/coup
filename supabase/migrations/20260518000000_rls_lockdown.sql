-- ============================================================
-- Step 3: RLS lockdown
-- Replace all permissive `using (true)` policies with
-- auth.uid()-scoped checks.
--
-- SECURITY-CRITICAL NOTE: player_influences.SELECT was completely
-- open, meaning any client could read all opponents' hidden cards.
-- This migration fixes that exploit first.
-- ============================================================

-- ------------------------------------------------------------
-- 0. Drop all existing data (clean slate for auth refactor)
-- Order matters: games cascades to game_players/player_influences/
-- game_events; players must be last.
-- ------------------------------------------------------------
delete from public.games;         -- cascades to game_players, player_influences, game_events
delete from public.chat_messages; -- no FK to games, drop separately
delete from public.players;

-- ------------------------------------------------------------
-- 1. players
-- ------------------------------------------------------------
drop policy "players_select" on public.players;
drop policy "players_insert" on public.players;
drop policy "players_update" on public.players;
drop policy "players_delete" on public.players;

-- Any authenticated user can see all lobby players (needed to
-- view who is in a lobby before deciding to join).
create policy "players_select" on public.players
  for select using (auth.uid() is not null);

-- You can only create or modify your own seat.
create policy "players_insert" on public.players
  for insert with check (id = auth.uid());

create policy "players_update" on public.players
  for update using (id = auth.uid()) with check (id = auth.uid());

create policy "players_delete" on public.players
  for delete using (id = auth.uid());

-- ------------------------------------------------------------
-- 2. games
-- ------------------------------------------------------------
drop policy "games_select" on public.games;
drop policy "games_insert" on public.games;
drop policy "games_update" on public.games;
drop policy "games_delete" on public.games;

-- Caller has a lobby seat OR an in-game seat.
create policy "games_select" on public.games
  for select using (
    exists (
      select 1 from public.players p
      where p.game_code = games.game_code and p.id = auth.uid()
    )
    or exists (
      select 1 from public.game_players gp
      where gp.game_code = games.game_code and gp.player_id = auth.uid()
    )
  );

-- Host (lobby player) creates the games row at startGame.
create policy "games_insert" on public.games
  for insert with check (
    exists (
      select 1 from public.players p
      where p.game_code = games.game_code and p.id = auth.uid()
    )
  );

-- Any game participant can update turn state.
create policy "games_update" on public.games
  for update using (
    exists (
      select 1 from public.game_players gp
      where gp.game_code = games.game_code and gp.player_id = auth.uid()
    )
  );

-- Host (lobby player) deletes the stale games row before re-creating it.
create policy "games_delete" on public.games
  for delete using (
    exists (
      select 1 from public.players p
      where p.game_code = games.game_code and p.id = auth.uid()
    )
  );

-- ------------------------------------------------------------
-- 3. game_players
-- ------------------------------------------------------------
drop policy "game_players_select" on public.game_players;
drop policy "game_players_insert" on public.game_players;
drop policy "game_players_update" on public.game_players;
drop policy "game_players_delete" on public.game_players;

create policy "game_players_select" on public.game_players
  for select using (
    exists (
      select 1 from public.game_players gp
      where gp.game_code = game_players.game_code and gp.player_id = auth.uid()
    )
  );

-- Host (lobby player) bulk-inserts all game_players rows at startGame.
create policy "game_players_insert" on public.game_players
  for insert with check (
    exists (
      select 1 from public.players p
      where p.game_code = game_players.game_code and p.id = auth.uid()
    )
  );

-- Any game participant can update coins/seat (steal changes both players' coins).
create policy "game_players_update" on public.game_players
  for update using (
    exists (
      select 1 from public.game_players gp
      where gp.game_code = game_players.game_code and gp.player_id = auth.uid()
    )
  );

-- Rows are removed via cascade when the games row is deleted.

-- ------------------------------------------------------------
-- 4. player_influences
-- ------------------------------------------------------------
--
-- SECURITY-CRITICAL FIX: Previously `using (true)` meant every client
-- could read every opponent's hidden card. This is a real cheat exploit.
-- The SELECT policy below restricts to:
--   * your own cards (any state), OR
--   * cards that are already face-up (is_revealed = true)
--
drop policy "player_influences_select" on public.player_influences;
drop policy "player_influences_insert" on public.player_influences;
drop policy "player_influences_update" on public.player_influences;

-- SECURITY-CRITICAL: hide unrevealed opponent cards.
create policy "player_influences_select" on public.player_influences
  for select using (
    is_revealed = true
    or player_id = auth.uid()
  );

-- Host (lobby player) bulk-inserts influences for all players at startGame.
create policy "player_influences_insert" on public.player_influences
  for insert with check (
    exists (
      select 1 from public.players p
      where p.game_code = player_influences.game_code and p.id = auth.uid()
    )
  );

-- Any game participant can update influences.
-- Needed because card-swap (after a failed challenge) runs in the challenger's
-- browser context but updates the proven-truthful player's card row.
-- TODO: move game mutations to SECURITY DEFINER functions so this can be
-- tightened to `player_id = auth.uid()`.
create policy "player_influences_update" on public.player_influences
  for update using (
    exists (
      select 1 from public.game_players gp
      where gp.game_code = player_influences.game_code and gp.player_id = auth.uid()
    )
  );

-- ------------------------------------------------------------
-- 5. game_events
-- ------------------------------------------------------------
drop policy "game_events_select" on public.game_events;
drop policy "game_events_insert" on public.game_events;

create policy "game_events_select" on public.game_events
  for select using (
    exists (
      select 1 from public.game_players gp
      where gp.game_code = game_events.game_code and gp.player_id = auth.uid()
    )
  );

-- Any game participant can insert events.
-- Some events (e.g. "win", "eliminated") are inserted with a different
-- player_id than auth.uid(), so we cannot restrict by player_id = auth.uid()
-- without moving logic server-side.
create policy "game_events_insert" on public.game_events
  for insert with check (
    exists (
      select 1 from public.game_players gp
      where gp.game_code = game_events.game_code and gp.player_id = auth.uid()
    )
  );

-- ------------------------------------------------------------
-- 6. chat_messages
-- ------------------------------------------------------------
drop policy "allow all" on public.chat_messages;

-- Anyone with a lobby seat or an in-game seat can read chat.
create policy "chat_messages_select" on public.chat_messages
  for select using (
    exists (
      select 1 from public.players p
      where p.game_code = chat_messages.game_code and p.id = auth.uid()
    )
    or exists (
      select 1 from public.game_players gp
      where gp.game_code = chat_messages.game_code and gp.player_id = auth.uid()
    )
  );

-- You can only send messages as yourself.
create policy "chat_messages_insert" on public.chat_messages
  for insert with check (player_id = auth.uid());
