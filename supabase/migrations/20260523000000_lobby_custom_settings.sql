-- Add cards_per_player and cards_per_role to games table.
-- These are set in the lobby and read by server-side deal/draw functions.
-- A games row with status='lobby' is created when the host changes settings;
-- startGame reads those values and re-inserts with status='in_progress'.

-- ─── 1. Schema: new settings columns ─────────────────────────────────────────

alter table public.games
  add column if not exists cards_per_player integer not null default 2,
  add column if not exists cards_per_role    integer not null default 3;

-- ─── 2. RLS: allow lobby players to update settings on the games row ──────────

drop policy if exists "games_update" on public.games;

create policy "games_update" on public.games
  for update using (
    exists (
      select 1 from public.game_players gp
      where gp.game_code = games.game_code and gp.player_id = auth.uid()
    )
    or exists (
      select 1 from public.players p
      where p.game_code = games.game_code and p.id = auth.uid()
    )
  );

-- ─── 3. private.player_alive — add cards_per_player parameter ─────────────────
-- Create new overload first; all callers below switch to the new signature;
-- the old single-argument version is dropped at the bottom.

create or replace function private.player_alive(
  p_revealed_count    integer,
  p_cards_per_player  integer
)
returns boolean
language sql
immutable
set search_path = pg_catalog, public, private
as $$
  select p_revealed_count < p_cards_per_player;
$$;

-- ─── 4. private.compute_deck — read cards_per_role from games row ─────────────

create or replace function private.compute_deck(p_game_code text)
returns text[]
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  deck            text[] := '{}';
  role_name       text;
  v_cards_per_role integer;
  remaining       integer;
  i               integer;
begin
  select coalesce(g.cards_per_role, 3)
  into v_cards_per_role
  from public.games g
  where g.game_code = p_game_code;

  if not found then
    v_cards_per_role := 3;
  end if;

  foreach role_name in array array[
    'duke', 'assassin', 'captain', 'ambassador', 'contessa'
  ]
  loop
    select v_cards_per_role - count(*)::integer
    into remaining
    from public.player_influences pi
    where pi.game_code = p_game_code
      and pi.role = role_name;

    for i in 1..remaining loop
      deck := deck || role_name;
    end loop;
  end loop;

  return deck;
end;
$$;

-- ─── 5. private.next_alive_turn_player — use cards_per_player from games ─────

create or replace function private.next_alive_turn_player(
  p_game_code text,
  p_current   uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private
as $$
declare
  n         int;
  cur_seat  int;
  i         int;
  cand_id   uuid;
  cand_rc   int;
  v_cpp     int;
begin
  select coalesce(g.cards_per_player, 2)
  into v_cpp
  from public.games g
  where g.game_code = p_game_code;

  select count(*)::int into n
  from public.game_players
  where game_code = p_game_code;

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

    if found and private.player_alive(cand_rc, v_cpp) then
      return cand_id;
    end if;
  end loop;

  return p_current;
end;
$$;

-- ─── 6. public.resolve_challenge — use g.cards_per_player ────────────────────

create or replace function public.resolve_challenge(p_game_code text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_uid         uuid := auth.uid();
  g             public.games%rowtype;
  v_claimant_id uuid;
  v_claimed_role text;
  v_has_role    boolean;
  v_target_id   uuid;
  v_target_name text;
  v_lose_reason text;
  v_success     boolean;
  v_is_block    boolean;
  v_rows        int;
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
    select 1
    from public.game_players gp
    where gp.game_code = p_game_code and gp.player_id = v_uid
  ) then
    raise exception 'Player not in game';
  end if;

  if not private.player_alive(
    (select gp.revealed_count
     from public.game_players gp
     where gp.game_code = p_game_code and gp.player_id = v_uid),
    g.cards_per_player
  ) then
    raise exception 'Eliminated players cannot challenge';
  end if;

  -- ── Block-challenge ──────────────────────────────────────────────────────
  if g.pending_blocker_id is not null then
    v_is_block := true;

    if g.pending_blocker_id = v_uid then
      raise exception 'The blocker cannot challenge their own block';
    end if;

    v_claimant_id := g.pending_blocker_id;
    v_claimed_role := g.pending_block_role;

    if v_claimed_role is null then
      raise exception 'No block role on record';
    end if;

    select exists (
      select 1
      from public.player_influences pi
      where pi.game_code = p_game_code
        and pi.player_id = v_claimant_id
        and pi.role = v_claimed_role
        and not pi.is_revealed
    ) into v_has_role;

    if v_has_role then
      v_target_id := v_uid;
      v_lose_reason := 'failed_block_challenge_challenger';
      v_success := false;
    else
      v_target_id := v_claimant_id;
      v_lose_reason := 'failed_block_challenge_blocker';
      v_success := true;
    end if;

    update public.games
    set
      turn_phase = 'lose_influence',
      pending_target_id = v_target_id,
      lose_influence_reason = v_lose_reason
    where game_code = p_game_code
      and turn_phase = 'awaiting_challenge'
      and pending_blocker_id is not null;

    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      raise exception 'Challenge no longer available';
    end if;

    select p.name into v_target_name
    from public.players p
    where p.id = v_claimant_id;

    insert into public.game_events (game_code, player_id, action, metadata)
    values (
      p_game_code,
      v_uid,
      'challenge',
      jsonb_build_object(
        'targetPlayerId', v_claimant_id,
        'targetName', v_target_name,
        'role', v_claimed_role,
        'action', g.pending_action,
        'success', v_success,
        'isBlock', v_is_block
      )
    );

    return;
  end if;

  -- ── Action-challenge ─────────────────────────────────────────────────────
  v_is_block := false;

  if g.current_turn_player_id = v_uid then
    raise exception 'The acting player cannot challenge';
  end if;

  if g.pending_action is null then
    raise exception 'No pending action';
  end if;

  v_claimed_role := private.action_claimed_role(g.pending_action);

  if v_claimed_role is null then
    raise exception 'This action cannot be challenged';
  end if;

  v_claimant_id := g.current_turn_player_id;

  select exists (
    select 1
    from public.player_influences pi
    where pi.game_code = p_game_code
      and pi.player_id = v_claimant_id
      and pi.role = v_claimed_role
      and not pi.is_revealed
  ) into v_has_role;

  if v_has_role then
    v_target_id := v_uid;
    v_lose_reason := 'failed_challenge_challenger';
    v_success := false;
  else
    v_target_id := v_claimant_id;
    v_lose_reason := 'failed_challenge_actor';
    v_success := true;
  end if;

  update public.games
  set
    turn_phase = 'lose_influence',
    pending_target_id = v_target_id,
    lose_influence_reason = v_lose_reason
  where game_code = p_game_code
    and turn_phase = 'awaiting_challenge'
    and pending_blocker_id is null;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'Challenge no longer available';
  end if;

  select p.name into v_target_name
  from public.players p
  where p.id = v_claimant_id;

  insert into public.game_events (game_code, player_id, action, metadata)
  values (
    p_game_code,
    v_uid,
    'challenge',
    jsonb_build_object(
      'targetPlayerId', v_claimant_id,
      'targetName', v_target_name,
      'role', v_claimed_role,
      'action', g.pending_action,
      'success', v_success,
      'isBlock', v_is_block
    )
  );
end;
$$;

-- ─── 7. public.draw_ambassador_cards — draw cards_per_player cards ────────────

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
  i             int;
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

  if coalesce(array_length(deck, 1), 0) < g.cards_per_player then
    drawn := deck;
  else
    drawn := '{}';
    for i in 1..g.cards_per_player loop
      drawn := drawn || deck[i];
    end loop;
  end if;

  update public.games
  set
    turn_phase              = 'ambassador_exchange',
    pending_ambassador_draw = drawn,
    pending_action          = null,
    pending_action_target_id = null,
    pending_blocker_id      = null,
    pending_block_role      = null,
    lose_influence_reason   = null,
    challenge_passes        = '{}'
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

-- ─── 8. private.enter_ambassador_exchange — draw cards_per_player cards ───────

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
  i     int;
begin
  select * into g from public.games where game_code = p_game_code for update;

  if g.pending_action <> 'exchange' then
    raise exception 'No exchange action pending';
  end if;

  if g.pending_blocker_id is not null then
    raise exception 'Action is blocked';
  end if;

  deck := private.shuffle_deck(private.compute_deck(p_game_code));

  if coalesce(array_length(deck, 1), 0) < g.cards_per_player then
    drawn := deck;
  else
    drawn := '{}';
    for i in 1..g.cards_per_player loop
      drawn := drawn || deck[i];
    end loop;
  end if;

  update public.games
  set
    turn_phase              = 'ambassador_exchange',
    pending_ambassador_draw = drawn,
    pending_action          = null,
    pending_action_target_id = null,
    pending_blocker_id      = null,
    pending_block_role      = null,
    lose_influence_reason   = null,
    challenge_passes        = '{}'
  where game_code = p_game_code;
end;
$$;

-- ─── 9. private.resolve_defense_success_action — use g.cards_per_player ───────

create or replace function private.resolve_defense_success_action(
  p_game_code        text,
  p_swap_actor_claim boolean
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  g             public.games%rowtype;
  v_action      text;
  v_claimed     text;
  v_actor       uuid;
  v_actor_coins int;
  v_target      uuid;
  v_target_coins int;
  v_stolen      int;
  v_target_rc   int;
  v_tname       text;
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

      if private.player_alive(v_target_rc, g.cards_per_player) then
        update public.games
        set
          turn_phase               = 'lose_influence',
          pending_target_id        = v_target,
          lose_influence_reason    = 'assassinate',
          pending_action           = null,
          pending_action_target_id = null,
          pending_blocker_id       = null,
          pending_block_role       = null,
          challenge_passes         = '{}'
        where game_code = p_game_code;
      else
        perform private.complete_action_clear(p_game_code);
      end if;

    else
      raise exception 'Unknown pending action: %', v_action;
  end case;
end;
$$;

-- ─── 10. public.lose_influence_and_resolve — use g.cards_per_player ───────────

create or replace function public.lose_influence_and_resolve(
  p_game_code    text,
  p_influence_id bigint
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_uid        uuid := auth.uid();
  g            public.games%rowtype;
  inf          public.player_influences%rowtype;
  v_rc         int;
  v_role       text;
  v_new_rc     int;
  alive_count  int;
  v_winner     uuid;
  v_reason     text;
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

  v_role   := inf.role;
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

  if v_new_rc >= g.cards_per_player then
    insert into public.game_events (game_code, player_id, action)
    values (p_game_code, v_uid, 'eliminated');

    select count(*)::int into alive_count
    from public.game_players gp
    where gp.game_code = p_game_code
      and private.player_alive(gp.revealed_count, g.cards_per_player);

    if alive_count = 1 then
      select gp.player_id into v_winner
      from public.game_players gp
      where gp.game_code = p_game_code
        and private.player_alive(gp.revealed_count, g.cards_per_player)
      limit 1;

      insert into public.game_events (game_code, player_id, action)
      values (p_game_code, v_winner, 'win');

      update public.games
      set
        turn_phase               = 'action',
        pending_target_id        = null,
        pending_action           = null,
        pending_action_target_id = null,
        pending_blocker_id       = null,
        pending_block_role       = null,
        lose_influence_reason    = null,
        challenge_passes         = '{}',
        status                   = 'finished',
        winner_id                = v_winner
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

-- ─── 11. public.deal_initial_influences — dynamic deck + cards_per_player ─────

create or replace function public.deal_initial_influences(p_game_code text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_uid      uuid := auth.uid();
  v_host     uuid;
  v_cpp      int;
  v_cpr      int;
  deck       text[];
  gp         record;
  idx        int := 0;
  card_pos   int;
  r          text;
  role_name  text;
  i          int;
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

  select coalesce(g.cards_per_player, 2), coalesce(g.cards_per_role, 3)
  into v_cpp, v_cpr
  from public.games g
  where g.game_code = p_game_code;

  -- Build deck with v_cpr copies of each role
  deck := '{}';
  foreach role_name in array array[
    'duke', 'assassin', 'captain', 'ambassador', 'contessa'
  ]
  loop
    for i in 1..v_cpr loop
      deck := deck || role_name;
    end loop;
  end loop;
  deck := private.shuffle_deck(deck);

  -- Deal v_cpp cards per player
  for gp in
    select player_id, seat_order
    from public.game_players
    where game_code = p_game_code
    order by seat_order asc
  loop
    for card_pos in 0..v_cpp - 1 loop
      r := deck[idx * v_cpp + card_pos + 1];
      insert into public.player_influences (game_code, player_id, role, position)
      values (p_game_code, gp.player_id, r, card_pos);
    end loop;
    idx := idx + 1;
  end loop;
end;
$$;

-- ─── 12. Drop the old single-argument player_alive ────────────────────────────
-- All callers above have been updated to the two-argument version.

drop function if exists private.player_alive(integer);
