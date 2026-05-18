alter table public.games
  add column pending_action text,
  add column pending_action_target_id uuid references public.players(id),
  add column lose_influence_reason text,
  add column challenge_passes uuid[] not null default '{}';
