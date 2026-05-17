-- Lobby seat persistence (no auth yet; policies are permissive for local dev)
create table public.players (
  id uuid primary key,
  game_code text not null,
  name text not null,
  is_ready boolean not null default false,
  joined_at timestamptz not null default now()
);

create index players_game_code_idx on public.players (game_code);

alter table public.players enable row level security;

create policy "players_select" on public.players
  for select using (true);

create policy "players_insert" on public.players
  for insert with check (true);

create policy "players_update" on public.players
  for update using (true) with check (true);

create policy "players_delete" on public.players
  for delete using (true);

alter table public.players replica identity full;

alter publication supabase_realtime add table public.players;
