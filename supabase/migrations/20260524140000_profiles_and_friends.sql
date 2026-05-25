-- ============================================================
-- Profiles + Friendships
--
-- Introduces an account-level identity for authenticated users
-- (Google / Email). Anonymous "guest" users do NOT get a profile.
--
-- Stats are derived on demand from existing games / game_events,
-- so no historical backfill is required for stats themselves.
-- Profiles for existing non-anonymous auth users ARE backfilled
-- below so those users aren't left in a broken half-state.
-- ============================================================

-- ------------------------------------------------------------
-- 1. profiles
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  created_at timestamptz not null default now(),
  constraint profiles_username_format check (username ~ '^[A-Za-z0-9_]{3,20}$')
);

-- Case-insensitive uniqueness on username.
create unique index if not exists profiles_username_ci_unique
  on public.profiles (lower(username));

alter table public.profiles enable row level security;

drop policy if exists "profiles_select" on public.profiles;
drop policy if exists "profiles_update" on public.profiles;

-- Any signed-in user can read profiles (needed to view others).
create policy "profiles_select" on public.profiles
  for select using (auth.uid() is not null);

-- Self only.
create policy "profiles_update" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- INSERT is performed by the SECURITY DEFINER trigger below;
-- clients cannot insert profiles directly.


-- ------------------------------------------------------------
-- 2. friendships
-- ------------------------------------------------------------
create table if not exists public.friendships (
  id bigint generated always as identity primary key,
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  constraint friendships_no_self check (requester_id <> addressee_id),
  constraint friendships_directional_unique unique (requester_id, addressee_id)
);

-- Also prevent bi-directional duplicates (A→B and B→A cannot both exist).
create unique index if not exists friendships_pair_unique
  on public.friendships (
    least(requester_id, addressee_id),
    greatest(requester_id, addressee_id)
  );

create index if not exists friendships_addressee_idx
  on public.friendships (addressee_id);
create index if not exists friendships_requester_idx
  on public.friendships (requester_id);

alter table public.friendships enable row level security;

drop policy if exists "friendships_select" on public.friendships;
drop policy if exists "friendships_insert" on public.friendships;
drop policy if exists "friendships_update" on public.friendships;

create policy "friendships_select" on public.friendships
  for select using (
    requester_id = auth.uid() or addressee_id = auth.uid()
  );

-- Requester creates the row. Status is forced to 'pending'.
create policy "friendships_insert" on public.friendships
  for insert with check (
    requester_id = auth.uid()
    and status = 'pending'
    and requester_id <> addressee_id
  );

-- Only the addressee may flip status to 'accepted' (no other status changes).
create policy "friendships_update" on public.friendships
  for update using (
    addressee_id = auth.uid() and status = 'pending'
  ) with check (
    addressee_id = auth.uid() and status = 'accepted'
  );


-- ------------------------------------------------------------
-- 3. Auto-create profile on sign-up / promotion
-- ------------------------------------------------------------
create or replace function public._ensure_profile(
  p_user_id uuid,
  p_meta jsonb,
  p_email text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
  v_base text;
  v_username text;
  v_suffix int := 0;
begin
  if exists (select 1 from public.profiles where id = p_user_id) then
    return;
  end if;

  v_name := coalesce(
    p_meta ->> 'full_name',
    p_meta ->> 'name',
    nullif(split_part(coalesce(p_email, ''), '@', 1), ''),
    'player'
  );

  -- Slugify into [a-zA-Z0-9_], collapse runs, trim underscores.
  v_base := regexp_replace(v_name, '[^A-Za-z0-9_]+', '_', 'g');
  v_base := trim(both '_' from v_base);
  if v_base is null or length(v_base) < 3 then
    v_base := 'player';
  end if;
  if length(v_base) > 18 then
    v_base := substring(v_base from 1 for 18);
  end if;

  v_username := v_base;
  while exists (
    select 1 from public.profiles where lower(username) = lower(v_username)
  ) loop
    v_suffix := v_suffix + 1;
    -- Keep the total length under the 20-char ceiling.
    v_username := substring(v_base from 1 for greatest(3, 20 - length(v_suffix::text)))
                  || v_suffix::text;
  end loop;

  insert into public.profiles (id, username) values (p_user_id, v_username);
end;
$$;

revoke all on function public._ensure_profile(uuid, jsonb, text) from public, anon, authenticated;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Anonymous (guest) users do not get a profile.
  if coalesce(new.is_anonymous, false) then
    return new;
  end if;
  perform public._ensure_profile(new.id, new.raw_user_meta_data, new.email);
  return new;
end;
$$;

create or replace function public.handle_auth_user_promoted()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Fires when an anonymous user upgrades to email/google.
  if coalesce(old.is_anonymous, false) = true
     and coalesce(new.is_anonymous, false) = false then
    perform public._ensure_profile(new.id, new.raw_user_meta_data, new.email);
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

drop trigger if exists on_auth_user_promoted on auth.users;
create trigger on_auth_user_promoted
  after update of is_anonymous on auth.users
  for each row execute function public.handle_auth_user_promoted();

-- Backfill: create profiles for any existing non-anonymous user that
-- doesn't have one yet. (Stats are NOT backfilled — derived on demand.)
do $$
declare
  u record;
begin
  for u in
    select id, raw_user_meta_data, email
    from auth.users
    where coalesce(is_anonymous, false) = false
      and id not in (select id from public.profiles)
  loop
    perform public._ensure_profile(u.id, u.raw_user_meta_data, u.email);
  end loop;
end $$;


-- ------------------------------------------------------------
-- 4. Stats
-- ------------------------------------------------------------
-- Finished timestamp is read from the 'win' event in game_events
-- (games has no finished_at column).
create or replace function public.get_player_stats(p_player_id uuid)
returns table (
  total_games int,
  total_wins int,
  total_games_30d int,
  total_wins_30d int,
  win_pct numeric,
  win_pct_30d numeric
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  with finished as (
    select
      g.game_code,
      g.winner_id,
      (
        select e.created_at
        from public.game_events e
        where e.game_code = g.game_code and e.action = 'win'
        order by e.created_at desc
        limit 1
      ) as finished_at
    from public.games g
    join public.game_players gp on gp.game_code = g.game_code
    where g.status = 'finished' and gp.player_id = p_player_id
  ),
  agg as (
    select
      count(*)::int as total_games,
      count(*) filter (where winner_id = p_player_id)::int as total_wins,
      count(*) filter (where finished_at >= now() - interval '30 days')::int as total_games_30d,
      count(*) filter (
        where winner_id = p_player_id
          and finished_at >= now() - interval '30 days'
      )::int as total_wins_30d
    from finished
  )
  select
    agg.total_games,
    agg.total_wins,
    agg.total_games_30d,
    agg.total_wins_30d,
    case when agg.total_games > 0
         then round(100.0 * agg.total_wins::numeric / agg.total_games, 1)
         else 0 end as win_pct,
    case when agg.total_games_30d > 0
         then round(100.0 * agg.total_wins_30d::numeric / agg.total_games_30d, 1)
         else 0 end as win_pct_30d
  from agg;
$$;

revoke all on function public.get_player_stats(uuid) from public, anon;
grant execute on function public.get_player_stats(uuid) to authenticated;


-- ------------------------------------------------------------
-- 5. Game log (last N finished games + finish position)
-- ------------------------------------------------------------
-- Finish position:
--   - Winner is position 1.
--   - Other positions come from the reverse order of 'eliminated'
--     events (first eliminated = last place).
create or replace function public.get_player_game_log(
  pid uuid,
  p_limit int default 20
)
returns table (
  game_code text,
  finished_at timestamptz,
  finish_position int,
  total_players int
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  with player_games as (
    select g.game_code, g.winner_id
    from public.games g
    join public.game_players gp on gp.game_code = g.game_code
    where g.status = 'finished' and gp.player_id = pid
  ),
  totals as (
    select pg.game_code,
           pg.winner_id,
           (select count(*)::int
              from public.game_players gpx
              where gpx.game_code = pg.game_code) as total_players,
           (select e.created_at
              from public.game_events e
              where e.game_code = pg.game_code and e.action = 'win'
              order by e.created_at desc limit 1) as finished_at
    from player_games pg
  ),
  elim_ranks as (
    select e.game_code,
           e.player_id,
           row_number() over (
             partition by e.game_code order by e.created_at asc, e.id asc
           ) as elim_rank
    from public.game_events e
    where e.action = 'eliminated'
      and e.game_code in (select game_code from player_games)
  )
  select
    t.game_code,
    t.finished_at,
    case
      when t.winner_id = pid then 1
      else t.total_players
           - coalesce(
               (select er.elim_rank from elim_ranks er
                 where er.game_code = t.game_code and er.player_id = pid),
               0
             )
           + 1
    end::int as finish_position,
    t.total_players
  from totals t
  order by t.finished_at desc nulls last
  limit p_limit;
$$;

revoke all on function public.get_player_game_log(uuid, int) from public, anon;
grant execute on function public.get_player_game_log(uuid, int) to authenticated;


-- ------------------------------------------------------------
-- 6. Realtime publication
-- ------------------------------------------------------------
-- Friendships need realtime so incoming requests / accepts appear
-- live in the friends section. REPLICA IDENTITY FULL is required
-- so realtime can evaluate RLS against the full row state when
-- broadcasting UPDATE events.
alter table public.friendships replica identity full;
alter table public.profiles replica identity full;

do $$
begin
  begin
    alter publication supabase_realtime add table public.friendships;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.profiles;
  exception when duplicate_object then null;
  end;
end $$;
