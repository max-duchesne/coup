-- Server-side resolution for operations that require reading hidden cards.
-- Each function is SECURITY DEFINER (runs as owner, bypasses RLS) and
-- re-implements authorization that RLS used to provide implicitly.
--
-- Client direct INSERT/UPDATE on player_influences is removed except for
-- narrowly scoped policies documented at the bottom of this file.

create schema if not exists private;

-- ─── Shared helpers (not granted to callers) ───────────────────────────────

create or replace function private.game_participant(p_game_code text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select exists (
    select 1
    from public.players p
    where p.game_code = p_game_code
      and p.id = auth.uid()
  );
$$;

create or replace function private.player_alive(p_revealed_count integer)
returns boolean
language sql
immutable
set search_path = pg_catalog, public, private
as $$
  select p_revealed_count < 2;
$$;

-- Build the remaining draw pile (3 copies per role minus all dealt cards).
create or replace function private.compute_deck(p_game_code text)
returns text[]
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  deck text[] := '{}';
  role_name text;
  remaining integer;
  i integer;
begin
  foreach role_name in array array[
    'duke', 'assassin', 'captain', 'ambassador', 'contessa'
  ]
  loop
    select 3 - count(*)::integer
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

-- Fisher–Yates shuffle in-place on a text array.
create or replace function private.shuffle_deck(deck text[])
returns text[]
language plpgsql
immutable
set search_path = pg_catalog, public, private
as $$
declare
  result text[] := deck;
  i integer;
  j integer;
  tmp text;
begin
  if result is null or array_length(result, 1) is null then
    return '{}';
  end if;

  for i in reverse array_length(result, 1)..2 loop
    j := 1 + floor(random() * i)::integer;
    tmp := result[i];
    result[i] := result[j];
    result[j] := tmp;
  end loop;

  return result;
end;
$$;

-- Map pending_action → claimed role. NULL means not challengeable.
create or replace function private.action_claimed_role(p_action text)
returns text
language sql
immutable
set search_path = pg_catalog, public, private
as $$
  select case p_action
    when 'tax' then 'duke'
    when 'steal' then 'captain'
    when 'assassinate' then 'assassin'
    when 'exchange' then 'ambassador'
    else null
  end;
$$;

-- ─── 1. resolve_challenge ────────────────────────────────────────────────────

create or replace function public.resolve_challenge(p_game_code text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_uid uuid := auth.uid();
  g public.games%rowtype;
  v_claimant_id uuid;
  v_claimed_role text;
  v_has_role boolean;
  v_target_id uuid;
  v_target_name text;
  v_lose_reason text;
  v_success boolean;
  v_is_block boolean;
  v_rows int;
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
     where gp.game_code = p_game_code and gp.player_id = v_uid)
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

-- ─── 2. swap_claimed_card ──────────────────────────────────────────────────

create or replace function public.swap_claimed_card(
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
  v_uid uuid := auth.uid();
  g public.games%rowtype;
  v_card_id bigint;
  deck text[];
  new_role text;
  v_expected_owner uuid;
  v_expected_role text;
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

  if g.turn_phase <> 'lose_influence' then
    raise exception 'Not in lose-influence phase';
  end if;

  if g.pending_target_id <> v_uid then
    raise exception 'You are not the one who must lose an influence';
  end if;

  if g.lose_influence_reason = 'failed_challenge_challenger' then
    v_expected_owner := g.current_turn_player_id;
    v_expected_role := private.action_claimed_role(g.pending_action);
  elsif g.lose_influence_reason = 'failed_block_challenge_challenger' then
    v_expected_owner := g.pending_blocker_id;
    v_expected_role := g.pending_block_role;
  else
    raise exception 'Card swap not allowed for this lose-influence reason';
  end if;

  if p_owner_id <> v_expected_owner then
    raise exception 'Invalid card owner for swap';
  end if;

  if p_role is distinct from v_expected_role then
    raise exception 'Invalid role for swap';
  end if;

  if v_expected_role is null then
    raise exception 'No claimed role on record';
  end if;

  select pi.id into v_card_id
  from public.player_influences pi
  where pi.game_code = p_game_code
    and pi.player_id = p_owner_id
    and pi.role = p_role
    and not pi.is_revealed
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

-- ─── 3. draw_ambassador_cards ──────────────────────────────────────────────

create or replace function public.draw_ambassador_cards(p_game_code text)
returns text[]
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_uid uuid := auth.uid();
  g public.games%rowtype;
  v_claim_owner uuid;
  v_missing int;
  deck text[];
  drawn text[];
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
    and private.player_alive(gp.revealed_count)
    and not (gp.player_id = any(g.challenge_passes));

  if v_missing > 0 then
    raise exception 'Not all opponents have passed yet';
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

revoke all on function public.resolve_challenge(text) from public;
revoke all on function public.swap_claimed_card(text, uuid, text) from public;
revoke all on function public.draw_ambassador_cards(text) from public;

grant execute on function public.resolve_challenge(text) to authenticated;
grant execute on function public.swap_claimed_card(text, uuid, text) to authenticated;
grant execute on function public.draw_ambassador_cards(text) to authenticated;

revoke all on function public.resolve_challenge(text) from anon;
revoke all on function public.swap_claimed_card(text, uuid, text) from anon;
revoke all on function public.draw_ambassador_cards(text) from anon;

-- ─── Lock down player_influences writes ────────────────────────────────────

drop policy if exists "player_influences_insert" on public.player_influences;
drop policy if exists "player_influences_update" on public.player_influences;

-- Initial deal: lobby participant may insert influences only before any
-- cards exist for this game (host bulk-insert at startGame).
create policy "player_influences_insert_deal" on public.player_influences
  for insert
  with check (
    exists (
      select 1 from public.players p
      where p.game_code = player_influences.game_code
        and p.id = auth.uid()
    )
    and not exists (
      select 1 from public.player_influences pi
      where pi.game_code = player_influences.game_code
    )
  );

-- Reveal own card during lose_influence (pending_target must be caller).
create policy "player_influences_reveal_own" on public.player_influences
  for update
  using (
    player_id = auth.uid()
    and not is_revealed
    and exists (
      select 1
      from public.games g
      join public.players p
        on p.game_code = g.game_code and p.id = auth.uid()
      where g.game_code = player_influences.game_code
        and g.turn_phase = 'lose_influence'
        and g.pending_target_id = auth.uid()
    )
  )
  with check (
    player_id = auth.uid()
    and is_revealed
  );

-- Exchange: actor may change role on own unrevealed cards only.
create policy "player_influences_exchange_own" on public.player_influences
  for update
  using (
    player_id = auth.uid()
    and not is_revealed
    and exists (
      select 1
      from public.games g
      join public.players p
        on p.game_code = g.game_code and p.id = auth.uid()
      where g.game_code = player_influences.game_code
        and g.turn_phase = 'ambassador_exchange'
        and g.current_turn_player_id = auth.uid()
    )
  )
  with check (
    player_id = auth.uid()
    and not is_revealed
  );

-- Role swaps after a successful challenge defense go only through
-- private.swap_claimed_card_after_challenge (SECURITY DEFINER), invoked from
-- public.lose_influence_and_resolve. No client UPDATE policy.
