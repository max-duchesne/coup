-- (A) Atomic lose_influence: reveal + revealed_count + optional swap + phase advance
--     in one transaction (closes swap-before-reveal wedge).
-- (B) deal_initial_influences: server-side initial deal; remove client INSERT path.

-- ─── Private helpers (not granted) ───────────────────────────────────────────

create or replace function private.next_alive_turn_player(p_game_code text, p_current uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private
as $$
declare
  n int;
  cur_seat int;
  i int;
  cand_id uuid;
  cand_rc int;
begin
  select count(*)::int into n from public.game_players where game_code = p_game_code;
  if n < 1 then
    return p_current;
  end if;

  select seat_order into cur_seat
  from public.game_players
  where game_code = p_game_code and player_id = p_current;

  if cur_seat is null then
    return p_current;
  end if;

  for i in 1..n loop
    select gp.player_id, gp.revealed_count into cand_id, cand_rc
    from public.game_players gp
    where gp.game_code = p_game_code
      and gp.seat_order = ((cur_seat + i) % n);

    if found and private.player_alive(cand_rc) then
      return cand_id;
    end if;
  end loop;

  return p_current;
end;
$$;

-- Swap without auth checks — only from other SECURITY DEFINER routines.
create or replace function private.swap_claimed_card_after_challenge(
  p_game_code text,
  p_owner_id uuid,
  p_role text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_card_id bigint;
  deck text[];
  new_role text;
begin
  select inf.id into v_card_id
  from public.player_influences inf
  where inf.game_code = p_game_code
    and inf.player_id = p_owner_id
    and inf.role = p_role
    and not inf.is_revealed
  limit 1;

  if v_card_id is null then
    raise exception 'Owner has no live card matching the claim';
  end if;

  deck := private.shuffle_deck(private.compute_deck(p_game_code));
  deck := deck || p_role;

  if array_length(deck, 1) is null or array_length(deck, 1) < 1 then
    raise exception 'Deck is empty';
  end if;

  new_role := deck[1 + floor(random() * array_length(deck, 1))::integer];

  update public.player_influences
  set role = new_role
  where id = v_card_id;
end;
$$;

create or replace function private.complete_action_clear(p_game_code text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_next uuid;
  g public.games%rowtype;
begin
  select * into g from public.games where game_code = p_game_code for update;
  v_next := private.next_alive_turn_player(p_game_code, g.current_turn_player_id);
  update public.games
  set
    turn_phase = 'action',
    pending_target_id = null,
    pending_action = null,
    pending_action_target_id = null,
    pending_blocker_id = null,
    pending_block_role = null,
    lose_influence_reason = null,
    challenge_passes = '{}',
    current_turn_player_id = v_next
  where game_code = p_game_code;
end;
$$;

-- Ambassador exchange after successful defense (from lose_influence, not awaiting_challenge).
create or replace function private.enter_ambassador_exchange(p_game_code text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  g public.games%rowtype;
  deck text[];
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
  if coalesce(array_length(deck, 1), 0) < 2 then
    drawn := deck;
  else
    drawn := array[deck[1], deck[2]];
  end if;

  update public.games
  set
    turn_phase = 'ambassador_exchange',
    pending_ambassador_draw = drawn,
    pending_action = null,
    pending_action_target_id = null,
    pending_blocker_id = null,
    pending_block_role = null,
    lose_influence_reason = null,
    challenge_passes = '{}'
  where game_code = p_game_code;
end;
$$;

create or replace function private.resolve_defense_success_action(
  p_game_code text,
  p_swap_actor_claim boolean
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  g public.games%rowtype;
  v_action text;
  v_claimed text;
  v_actor uuid;
  v_actor_coins int;
  v_target uuid;
  v_target_coins int;
  v_stolen int;
  v_target_rc int;
  v_tname text;
begin
  select * into g from public.games where game_code = p_game_code for update;

  v_action := g.pending_action;
  if v_action is null then
    raise exception 'No pending action to resolve';
  end if;

  v_actor := g.current_turn_player_id;

  select coins into v_actor_coins
  from public.game_players
  where game_code = p_game_code and player_id = v_actor
  for update;

  if p_swap_actor_claim then
    v_claimed := private.action_claimed_role(v_action);
    if v_claimed is not null then
      perform private.swap_claimed_card_after_challenge(p_game_code, v_actor, v_claimed);
    end if;
  end if;

  select coins into v_actor_coins
  from public.game_players
  where game_code = p_game_code and player_id = v_actor
  for update;

  case v_action
    when 'foreign_aid' then
      update public.game_players
      set coins = v_actor_coins + 2
      where game_code = p_game_code and player_id = v_actor;

      insert into public.game_events (game_code, player_id, action)
      values (p_game_code, v_actor, 'foreign_aid');

      perform private.complete_action_clear(p_game_code);

    when 'tax' then
      update public.game_players
      set coins = v_actor_coins + 3
      where game_code = p_game_code and player_id = v_actor;

      insert into public.game_events (game_code, player_id, action)
      values (p_game_code, v_actor, 'tax');

      perform private.complete_action_clear(p_game_code);

    when 'steal' then
      v_target := g.pending_action_target_id;
      if v_target is null then
        raise exception 'Steal has no target';
      end if;

      select coins into v_target_coins
      from public.game_players
      where game_code = p_game_code and player_id = v_target
      for update;

      v_stolen := least(2, v_target_coins);

      if v_stolen > 0 then
        update public.game_players
        set coins = v_actor_coins + v_stolen
        where game_code = p_game_code and player_id = v_actor;

        update public.game_players
        set coins = v_target_coins - v_stolen
        where game_code = p_game_code and player_id = v_target;
      end if;

      select p.name into v_tname from public.players p where p.id = v_target;

      insert into public.game_events (game_code, player_id, action, metadata)
      values (
        p_game_code,
        v_actor,
        'steal',
        jsonb_build_object(
          'targetPlayerId', v_target,
          'targetName', v_tname,
          'amount', v_stolen
        )
      );

      perform private.complete_action_clear(p_game_code);

    when 'exchange' then
      perform private.enter_ambassador_exchange(p_game_code);

    when 'assassinate' then
      v_target := g.pending_action_target_id;
      if v_target is null then
        raise exception 'Assassinate has no target';
      end if;

      select revealed_count into v_target_rc
      from public.game_players
      where game_code = p_game_code and player_id = v_target;

      select p.name into v_tname from public.players p where p.id = v_target;

      insert into public.game_events (game_code, player_id, action, metadata)
      values (
        p_game_code,
        v_actor,
        'assassinate',
        jsonb_build_object(
          'targetPlayerId', v_target,
          'targetName', v_tname
        )
      );

      if private.player_alive(v_target_rc) then
        update public.games
        set
          turn_phase = 'lose_influence',
          pending_target_id = v_target,
          lose_influence_reason = 'assassinate',
          pending_action = null,
          pending_action_target_id = null,
          pending_blocker_id = null,
          pending_block_role = null,
          challenge_passes = '{}'
        where game_code = p_game_code;
      else
        perform private.complete_action_clear(p_game_code);
      end if;

    else
      raise exception 'Unknown pending action: %', v_action;
  end case;
end;
$$;

-- ─── Public: atomic lose influence + resolution ─────────────────────────────

create or replace function public.lose_influence_and_resolve(
  p_game_code text,
  p_influence_id bigint
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_uid uuid := auth.uid();
  g public.games%rowtype;
  inf public.player_influences%rowtype;
  v_rc int;
  v_role text;
  v_new_rc int;
  alive_count int;
  v_winner uuid;
  v_reason text;
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

  if g.turn_phase <> 'lose_influence' then
    raise exception 'Not in lose-influence phase';
  end if;

  if g.pending_target_id is distinct from v_uid then
    raise exception 'You are not the one who must lose an influence';
  end if;

  select * into inf
  from public.player_influences
  where id = p_influence_id
    and game_code = p_game_code
    and player_id = v_uid
    and not is_revealed;

  if not found then
    raise exception 'Invalid influence selection';
  end if;

  select revealed_count into v_rc
  from public.game_players
  where game_code = p_game_code and player_id = v_uid
  for update;

  v_role := inf.role;
  v_new_rc := v_rc + 1;
  v_reason := g.lose_influence_reason;

  update public.player_influences
  set is_revealed = true
  where id = p_influence_id;

  update public.game_players
  set revealed_count = v_new_rc
  where game_code = p_game_code and player_id = v_uid;

  insert into public.game_events (game_code, player_id, action, metadata)
  values (
    p_game_code,
    v_uid,
    'lose_influence',
    jsonb_build_object('role', v_role)
  );

  if v_new_rc >= 2 then
    insert into public.game_events (game_code, player_id, action)
    values (p_game_code, v_uid, 'eliminated');

    select count(*)::int into alive_count
    from public.game_players gp
    where gp.game_code = p_game_code
      and private.player_alive(gp.revealed_count);

    if alive_count = 1 then
      select gp.player_id into v_winner
      from public.game_players gp
      where gp.game_code = p_game_code
        and private.player_alive(gp.revealed_count)
      limit 1;

      insert into public.game_events (game_code, player_id, action)
      values (p_game_code, v_winner, 'win');

      update public.games
      set
        turn_phase = 'action',
        pending_target_id = null,
        pending_action = null,
        pending_action_target_id = null,
        pending_blocker_id = null,
        pending_block_role = null,
        lose_influence_reason = null,
        challenge_passes = '{}',
        status = 'finished',
        winner_id = v_winner
      where game_code = p_game_code;

      return;
    end if;
  end if;

  if v_reason = 'failed_challenge_challenger' then
    perform private.resolve_defense_success_action(p_game_code, true);
  elsif v_reason = 'failed_block_challenge_blocker' then
    perform private.resolve_defense_success_action(p_game_code, false);
  elsif v_reason = 'failed_block_challenge_challenger' then
    if g.pending_blocker_id is not null and g.pending_block_role is not null then
      perform private.swap_claimed_card_after_challenge(
        p_game_code,
        g.pending_blocker_id,
        g.pending_block_role
      );
    end if;
    perform private.complete_action_clear(p_game_code);
  else
    perform private.complete_action_clear(p_game_code);
  end if;
end;
$$;

-- ─── Public: server-side initial deal ────────────────────────────────────────

create or replace function public.deal_initial_influences(p_game_code text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_uid uuid := auth.uid();
  v_host uuid;
  deck text[];
  gp record;
  idx int := 0;
  r text;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select p.id into v_host
  from public.players p
  where p.game_code = p_game_code
  order by p.joined_at asc
  limit 1;

  if v_host is null then
    raise exception 'No lobby players for this game';
  end if;

  if v_host <> v_uid then
    raise exception 'Only the host can deal';
  end if;

  if not exists (select 1 from public.games g where g.game_code = p_game_code) then
    raise exception 'Game not found';
  end if;

  if exists (select 1 from public.player_influences pi where pi.game_code = p_game_code) then
    raise exception 'Influences already dealt';
  end if;

  deck := private.shuffle_deck(array[
    'duke', 'duke', 'duke',
    'assassin', 'assassin', 'assassin',
    'captain', 'captain', 'captain',
    'ambassador', 'ambassador', 'ambassador',
    'contessa', 'contessa', 'contessa'
  ]);

  for gp in
    select player_id, seat_order
    from public.game_players
    where game_code = p_game_code
    order by seat_order asc
  loop
    r := deck[idx * 2 + 1];
    insert into public.player_influences (game_code, player_id, role, position)
    values (p_game_code, gp.player_id, r, 0);

    r := deck[idx * 2 + 2];
    insert into public.player_influences (game_code, player_id, role, position)
    values (p_game_code, gp.player_id, r, 1);

    idx := idx + 1;
  end loop;
end;
$$;

-- Remove standalone swap RPC (attack surface); logic lives in private.* only.
drop function if exists public.swap_claimed_card(text, uuid, text);

-- No client INSERT into player_influences (only definer + service role).
drop policy if exists "player_influences_insert_deal" on public.player_influences;

revoke all on function public.lose_influence_and_resolve(text, bigint) from public;
grant execute on function public.lose_influence_and_resolve(text, bigint) to authenticated;
revoke all on function public.lose_influence_and_resolve(text, bigint) from anon;

revoke all on function public.deal_initial_influences(text) from public;
grant execute on function public.deal_initial_influences(text) to authenticated;
revoke all on function public.deal_initial_influences(text) from anon;
