-- Change game_players primary key from (player_id) to (player_id, game_code)
-- so the same player can participate in multiple sequential games.
alter table public.game_players drop constraint game_players_pkey;
alter table public.game_players add primary key (player_id, game_code);
