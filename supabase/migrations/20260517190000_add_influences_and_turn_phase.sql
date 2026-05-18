-- Per-player influence cards
create table public.player_influences (
  id bigint generated always as identity primary key,
  game_code text not null references public.games(game_code),
  player_id uuid not null references public.players(id),
  role text not null,
  position integer not null,
  is_revealed boolean not null default false,
  unique (player_id, game_code, position)
);

create index player_influences_game_code_idx on public.player_influences (game_code);

alter table public.player_influences enable row level security;
create policy "player_influences_select" on public.player_influences for select using (true);
create policy "player_influences_insert" on public.player_influences for insert with check (true);
create policy "player_influences_update" on public.player_influences for update using (true) with check (true);

alter table public.player_influences replica identity full;
alter publication supabase_realtime add table public.player_influences;

-- Turn phase tracking on games
alter table public.games
  add column turn_phase text not null default 'action',
  add column pending_target_id uuid references public.players(id);

-- Metadata on game_events for richer log entries
alter table public.game_events add column metadata jsonb;
