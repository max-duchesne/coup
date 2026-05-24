-- Ambassador always draws exactly 2 cards regardless of cards_per_player.
-- The player then keeps however many live cards they currently hold (which
-- equals cards_per_player minus any they've already revealed).

create or replace function public.draw_ambassador_cards(p_game_code text)
returns text[]
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_uid         uuid := auth.uid();
  g             public.games%rowtype;
  v_claim_owner uuid;
  v_missing     int;
  deck          text[];
  drawn         text[];
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not private.game_participant(p_game_code) then
    raise exception 'Player not in game';
  end if;

  select * into g
  from public.games
  where game_code = p_game_code
  for update;

  if not found then
    raise exception 'Game not found';
  end if;

  if g.status <> 'in_progress' then
    raise exception 'Game is not in progress';
  end if;

  if g.turn_phase <> 'awaiting_challenge' then
    raise exception 'Not in challenge phase';
  end if;

  if g.pending_action <> 'exchange' then
    raise exception 'No exchange action pending';
  end if;

  if g.pending_blocker_id is not null then
    raise exception 'Action is blocked';
  end if;

  v_claim_owner := g.current_turn_player_id;

  select count(*)::int into v_missing
  from public.game_players gp
  where gp.game_code = p_game_code
    and gp.player_id <> v_claim_owner
    and private.player_alive(gp.revealed_count, g.cards_per_player)
    and not (gp.player_id = any(g.challenge_passes));

  if v_missing > 0 then
    raise exception 'Not all opponents have passed yet';
  end if;

  deck := private.shuffle_deck(private.compute_deck(p_game_code));

  -- Always draw exactly 2 cards; the player keeps however many they hold alive.
  if coalesce(array_length(deck, 1), 0) < 2 then
    drawn := deck;
  else
    drawn := array[deck[1], deck[2]];
  end if;

  update public.games
  set
    turn_phase               = 'ambassador_exchange',
    pending_ambassador_draw  = drawn,
    pending_action           = null,
    pending_action_target_id = null,
    pending_blocker_id       = null,
    pending_block_role       = null,
    lose_influence_reason    = null,
    challenge_passes         = '{}'
  where game_code = p_game_code
    and turn_phase = 'awaiting_challenge'
    and pending_action = 'exchange'
    and pending_blocker_id is null;

  if not found then
    raise exception 'Exchange draw no longer available';
  end if;

  return drawn;
end;
$$;

create or replace function private.enter_ambassador_exchange(p_game_code text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  g     public.games%rowtype;
  deck  text[];
  drawn text[];
begin
  select * into g from public.games where game_code = p_game_code for update;

  if g.pending_action <> 'exchange' then
    raise exception 'No exchange action pending';
  end if;

  if g.pending_blocker_id is not null then
    raise exception 'Action is blocked';
  end if;

  deck := private.shuffle_deck(private.compute_deck(p_game_code));

  -- Always draw exactly 2 cards.
  if coalesce(array_length(deck, 1), 0) < 2 then
    drawn := deck;
  else
    drawn := array[deck[1], deck[2]];
  end if;

  update public.games
  set
    turn_phase               = 'ambassador_exchange',
    pending_ambassador_draw  = drawn,
    pending_action           = null,
    pending_action_target_id = null,
    pending_blocker_id       = null,
    pending_block_role       = null,
    lose_influence_reason    = null,
    challenge_passes         = '{}'
  where game_code = p_game_code;
end;
$$;
