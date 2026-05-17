create table public.game_events (
  id bigint generated always as identity primary key,
  game_code text not null references public.games(game_code),
  player_id uuid not null references public.players(id),
  action text not null,
  created_at timestamptz not null default now()
);

create index game_events_game_code_idx on public.game_events (game_code);

alter table public.game_events enable row level security;
create policy "game_events_select" on public.game_events for select using (true);
create policy "game_events_insert" on public.game_events for insert with check (true);

alter table public.game_events replica identity full;
alter publication supabase_realtime add table public.game_events;
