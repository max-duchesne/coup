-- Replace game_code FKs with ON DELETE CASCADE so deleting a games row
-- automatically cleans up game_players, player_influences, and game_events.

alter table public.game_players
  drop constraint game_players_game_code_fkey,
  add constraint game_players_game_code_fkey
    foreign key (game_code) references public.games(game_code) on delete cascade;

alter table public.player_influences
  drop constraint player_influences_game_code_fkey,
  add constraint player_influences_game_code_fkey
    foreign key (game_code) references public.games(game_code) on delete cascade;

alter table public.game_events
  drop constraint game_events_game_code_fkey,
  add constraint game_events_game_code_fkey
    foreign key (game_code) references public.games(game_code) on delete cascade;
