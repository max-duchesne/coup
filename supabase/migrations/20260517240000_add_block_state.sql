alter table public.games
  add column pending_blocker_id uuid references public.players(id),
  add column pending_block_role text;
