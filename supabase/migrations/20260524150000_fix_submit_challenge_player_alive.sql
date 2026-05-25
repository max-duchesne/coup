-- Fix: submit_challenge calls private.player_alive() with one arg, but
-- migration 20260523000000 changed the signature to (revealed_count, cards_per_player)
-- and dropped the old overload. Result: every challenge throws
-- "function private.player_alive(integer) does not exist", surfacing in the UI
-- as a generic "Action failed".
--
-- Only the player_alive call inside submit_challenge needs patching;
-- the row variable `g` already has cards_per_player available.

create or replace function public.submit_challenge(p_game_code text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_uid           uuid := auth.uid();
  g               public.games%rowtype;
  v_claimant_id   uuid;
  v_claimed_role  text;
  v_is_block      boolean;
  v_rows          int;
  v_claimant_name text;
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
    raise exception 'Nothing to challenge right now';
  end if;

  if not exists (
    select 1 from public.game_players gp
    where gp.game_code = p_game_code and gp.player_id = v_uid
  ) then
    raise exception 'Player not in game';
  end if;

  if not private.player_alive(
    (select gp.revealed_count from public.game_players gp
     where gp.game_code = p_game_code and gp.player_id = v_uid),
    g.cards_per_player
  ) then
    raise exception 'Eliminated players cannot challenge';
  end if;

  if g.pending_blocker_id is not null then
    -- Block-challenge
    v_is_block    := true;
    v_claimant_id := g.pending_blocker_id;
    v_claimed_role := g.pending_block_role;

    if v_claimant_id = v_uid then
      raise exception 'The blocker cannot challenge their own block';
    end if;
    if v_claimed_role is null then
      raise exception 'No block role on record';
    end if;
  else
    -- Action-challenge
    v_is_block    := false;
    v_claimant_id := g.current_turn_player_id;
    v_claimed_role := private.action_claimed_role(g.pending_action);

    if v_claimant_id = v_uid then
      raise exception 'The acting player cannot challenge their own action';
    end if;
    if v_claimed_role is null then
      raise exception 'This action cannot be challenged';
    end if;
  end if;

  update public.games
  set
    turn_phase            = 'awaiting_reveal',
    pending_challenger_id = v_uid
  where game_code = p_game_code
    and turn_phase = 'awaiting_challenge';

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'Challenge no longer available';
  end if;

  select p.name into v_claimant_name
  from public.players p
  where p.id = v_claimant_id;

  insert into public.game_events (game_code, player_id, action, metadata)
  values (
    p_game_code,
    v_uid,
    'challenge',
    jsonb_build_object(
      'targetPlayerId', v_claimant_id,
      'targetName',     v_claimant_name,
      'role',           v_claimed_role,
      'action',         g.pending_action,
      'isBlock',        v_is_block
    )
  );
end;
$$;

revoke all on function public.submit_challenge(text) from public, anon;
grant execute on function public.submit_challenge(text) to authenticated;
