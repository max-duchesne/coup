-- randomize_turn_order: when false the host can drag-and-drop players to a fixed
-- seat order before starting.
alter table public.games
  add column if not exists randomize_turn_order boolean not null default true;

-- desired_seat_order: 0-based position assigned by the host for each lobby seat.
-- null means the host hasn't set an explicit order (falls back to joined_at).
alter table public.players
  add column if not exists desired_seat_order integer;

-- ─── public.set_lobby_player_order ───────────────────────────────────────────
-- Host-only. Persists the drag-and-drop seat sequence so all clients see the
-- same order in real time via the existing players Realtime subscription.

create or replace function public.set_lobby_player_order(
  p_game_code   text,
  p_ordered_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_uid  uuid := auth.uid();
  v_host uuid;
  v_i    int;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select p.id into v_host
  from public.players p
  where p.game_code = p_game_code
  order by p.joined_at asc
  limit 1;

  if v_host is distinct from v_uid then
    raise exception 'Only the host can set player order';
  end if;

  for v_i in 1..coalesce(array_length(p_ordered_ids, 1), 0) loop
    update public.players
    set desired_seat_order = v_i - 1
    where id = p_ordered_ids[v_i]
      and game_code = p_game_code;
  end loop;
end;
$$;

revoke all on function public.set_lobby_player_order(text, uuid[]) from public, anon;
grant execute on function public.set_lobby_player_order(text, uuid[]) to authenticated;
