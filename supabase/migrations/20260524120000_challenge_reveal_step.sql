-- Introduce an awaiting_reveal phase so the challenged player actively chooses
-- to reveal their card or back down, rather than having it resolved automatically.
--
-- New column: pending_challenger_id — tracks who submitted the challenge so the
-- reveal RPC knows who to assign the lose_influence phase to.

alter table public.games
  add column if not exists pending_challenger_id uuid references public.players(id);

-- ─── public.submit_challenge ─────────────────────────────────────────────────
-- Replaces the client call to resolve_challenge.
-- Moves the game from awaiting_challenge → awaiting_reveal and records the challenger.

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
     where gp.game_code = p_game_code and gp.player_id = v_uid)
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

-- ─── public.reveal_or_back_down ──────────────────────────────────────────────
-- Called by the challenged player (claimant).
-- p_reveal = true  → prove they hold the card; challenger loses influence.
-- p_reveal = false → back down; claimant loses influence, action is cancelled.

create or replace function public.reveal_or_back_down(
  p_game_code text,
  p_reveal    boolean
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_uid          uuid := auth.uid();
  g              public.games%rowtype;
  v_claimant_id  uuid;
  v_claimed_role text;
  v_is_block     boolean;
  v_has_role     boolean;
  v_lose_reason  text;
  v_target_id    uuid;
  v_rows         int;
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

  if g.turn_phase <> 'awaiting_reveal' then
    raise exception 'Not in challenge-reveal phase';
  end if;

  if g.pending_blocker_id is not null then
    v_is_block    := true;
    v_claimant_id := g.pending_blocker_id;
    v_claimed_role := g.pending_block_role;
  else
    v_is_block    := false;
    v_claimant_id := g.current_turn_player_id;
    v_claimed_role := private.action_claimed_role(g.pending_action);
  end if;

  if v_uid <> v_claimant_id then
    raise exception 'Only the challenged player can reveal or back down';
  end if;

  if p_reveal then
    select exists (
      select 1
      from public.player_influences pi
      where pi.game_code = p_game_code
        and pi.player_id = v_claimant_id
        and pi.role      = v_claimed_role
        and not pi.is_revealed
    ) into v_has_role;

    if not v_has_role then
      raise exception 'You do not have the claimed card';
    end if;

    -- Challenger loses influence; the revealed card will be swapped
    -- automatically inside lose_influence_and_resolve.
    v_lose_reason := case when v_is_block
      then 'failed_block_challenge_challenger'
      else 'failed_challenge_challenger'
    end;
    v_target_id := g.pending_challenger_id;
  else
    -- Back down: claimant loses influence.
    -- For action challenges → action is cancelled.
    -- For block challenges  → original action proceeds.
    v_lose_reason := case when v_is_block
      then 'failed_block_challenge_blocker'
      else 'failed_challenge_actor'
    end;
    v_target_id := v_claimant_id;
  end if;

  update public.games
  set
    turn_phase            = 'lose_influence',
    pending_target_id     = v_target_id,
    lose_influence_reason = v_lose_reason,
    pending_challenger_id = null
  where game_code = p_game_code
    and turn_phase = 'awaiting_reveal';

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'Reveal no longer available';
  end if;
end;
$$;

revoke all on function public.submit_challenge(text)              from public, anon;
revoke all on function public.reveal_or_back_down(text, boolean)  from public, anon;

grant execute on function public.submit_challenge(text)             to authenticated;
grant execute on function public.reveal_or_back_down(text, boolean) to authenticated;
