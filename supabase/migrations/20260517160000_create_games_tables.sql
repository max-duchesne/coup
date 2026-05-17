create table public.games (
  game_code text primary key,
  current_turn_player_id uuid not null references public.players(id),
  status text not null default 'in_progress',
  created_at timestamptz not null default now()
);

create table public.game_players (
  player_id uuid primary key references public.players(id),
  game_code text not null references public.games(game_code),
  coins integer not null default 2,
  seat_order integer not null
);

create index game_players_game_code_idx on public.game_players (game_code);

alter table public.games enable row level security;
create policy "games_select" on public.games for select using (true);
create policy "games_insert" on public.games for insert with check (true);
create policy "games_update" on public.games for update using (true) with check (true);
create policy "games_delete" on public.games for delete using (true);

alter table public.game_players enable row level security;
create policy "game_players_select" on public.game_players for select using (true);
create policy "game_players_insert" on public.game_players for insert with check (true);
create policy "game_players_update" on public.game_players for update using (true) with check (true);
create policy "game_players_delete" on public.game_players for delete using (true);

alter table public.games replica identity full;
alter table public.game_players replica identity full;

alter publication supabase_realtime add table public.games;
alter publication supabase_realtime add table public.game_players;
