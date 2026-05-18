alter table public.games
  add column winner_id uuid references public.players(id),
  add column next_game_code text;
