-- Replace cards_per_role (single integer) with role_counts (per-role jsonb map).
-- Default preserves the previous behaviour: 3 copies of every role.

alter table public.games
  drop column if exists cards_per_role,
  add column role_counts jsonb not null
    default '{"duke":3,"assassin":3,"captain":3,"ambassador":3,"contessa":3}';

-- ─── private.compute_deck — use per-role counts from role_counts ──────────────

create or replace function private.compute_deck(p_game_code text)
returns text[]
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_role_counts  jsonb;
  deck           text[] := '{}';
  role_name      text;
  role_max       integer;
  remaining      integer;
  i              integer;
begin
  select g.role_counts
  into v_role_counts
  from public.games g
  where g.game_code = p_game_code;

  if not found or v_role_counts is null then
    v_role_counts := '{"duke":3,"assassin":3,"captain":3,"ambassador":3,"contessa":3}'::jsonb;
  end if;

  foreach role_name in array array[
    'duke', 'assassin', 'captain', 'ambassador', 'contessa'
  ]
  loop
    role_max := coalesce((v_role_counts ->> role_name)::integer, 3);

    select role_max - count(*)::integer
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

-- ─── public.deal_initial_influences — build deck from role_counts ─────────────

create or replace function public.deal_initial_influences(p_game_code text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_uid         uuid := auth.uid();
  v_host        uuid;
  v_cpp         int;
  v_role_counts jsonb;
  deck          text[];
  gp            record;
  idx           int := 0;
  card_pos      int;
  r             text;
  role_name     text;
  i             int;
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

  select coalesce(g.cards_per_player, 2),
         coalesce(g.role_counts, '{"duke":3,"assassin":3,"captain":3,"ambassador":3,"contessa":3}'::jsonb)
  into v_cpp, v_role_counts
  from public.games g
  where g.game_code = p_game_code;

  -- Build deck with per-role counts from role_counts
  deck := '{}';
  foreach role_name in array array[
    'duke', 'assassin', 'captain', 'ambassador', 'contessa'
  ]
  loop
    for i in 1..coalesce((v_role_counts ->> role_name)::integer, 3) loop
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
