-- Fix infinite recursion: every policy that referenced game_players inside
-- a game_players policy (or transitively through games_select/update, etc.)
-- caused an infinite loop. Replace all with equivalent checks against the
-- players (lobby) table, which has no circular dependencies.
--
-- The players table is the source of truth for "who is participating in a
-- game session" (both lobby and in-game), so it is safe to use here.

-- game_players: fix circular SELECT and UPDATE
drop policy "game_players_select" on public.game_players;
drop policy "game_players_update" on public.game_players;

create policy "game_players_select" on public.game_players
  for select using (
    exists (
      select 1 from public.players p
      where p.game_code = game_players.game_code and p.id = auth.uid()
    )
  );

create policy "game_players_update" on public.game_players
  for update using (
    exists (
      select 1 from public.players p
      where p.game_code = game_players.game_code and p.id = auth.uid()
    )
  );

-- games: remove game_players dependency from SELECT and UPDATE
drop policy "games_select" on public.games;
drop policy "games_update" on public.games;

create policy "games_select" on public.games
  for select using (
    exists (
      select 1 from public.players p
      where p.game_code = games.game_code and p.id = auth.uid()
    )
  );

create policy "games_update" on public.games
  for update using (
    exists (
      select 1 from public.players p
      where p.game_code = games.game_code and p.id = auth.uid()
    )
  );

-- game_events: fix SELECT and INSERT that referenced game_players
drop policy "game_events_select" on public.game_events;
drop policy "game_events_insert" on public.game_events;

create policy "game_events_select" on public.game_events
  for select using (
    exists (
      select 1 from public.players p
      where p.game_code = game_events.game_code and p.id = auth.uid()
    )
  );

create policy "game_events_insert" on public.game_events
  for insert with check (
    exists (
      select 1 from public.players p
      where p.game_code = game_events.game_code and p.id = auth.uid()
    )
  );

-- player_influences: fix UPDATE that referenced game_players
drop policy "player_influences_update" on public.player_influences;

create policy "player_influences_update" on public.player_influences
  for update using (
    exists (
      select 1 from public.players p
      where p.game_code = player_influences.game_code and p.id = auth.uid()
    )
  );

-- chat_messages: remove game_players dependency from SELECT
drop policy "chat_messages_select" on public.chat_messages;

create policy "chat_messages_select" on public.chat_messages
  for select using (
    exists (
      select 1 from public.players p
      where p.game_code = chat_messages.game_code and p.id = auth.uid()
    )
  );
