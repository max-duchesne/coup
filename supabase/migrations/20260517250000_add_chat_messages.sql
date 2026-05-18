-- Chat messages keyed by game_code (text, no FK to games).
-- This lets messages persist across both the lobby phase and the game phase,
-- since the games row only exists once a game is started.

create table public.chat_messages (
  id        bigint generated always as identity primary key,
  game_code text        not null,
  player_id uuid        not null references public.players(id),
  player_name text      not null,
  message   text        not null check (char_length(message) between 1 and 500),
  created_at timestamptz not null default now()
);

create index on public.chat_messages (game_code, created_at);

alter table public.chat_messages enable row level security;
create policy "allow all" on public.chat_messages using (true) with check (true);

alter table public.chat_messages replica identity full;
alter publication supabase_realtime add table public.chat_messages;
