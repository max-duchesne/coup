-- Add a server-visible "revealed influences" count on game_players so the
-- client can determine who's still alive WITHOUT being able to read
-- opponents' hidden cards.
--
-- Before this column, the client computed aliveness as
-- `influences.some(i => !i.isRevealed)`, which only works if the caller can
-- see the opponent's unrevealed cards. The RLS lockdown in
-- 20260518000000_rls_lockdown.sql correctly hides those cards, which broke
-- turn advancement, the "all passed" check, and the action tray's targeted
-- actions (Steal/Assassinate/Coup) — every opponent looked eliminated to
-- every other client.
--
-- All players currently start with exactly 2 influences, so "alive" is
-- equivalent to `revealed_count < 2`. Storing the count as a normal column
-- means it's visible under the existing game_players SELECT policy.
--
-- NOTE: this does NOT fix challenge resolution, deck draws, or card swaps
-- after a failed challenge — those still require the executing client to
-- read another player's hidden card, and need to move to SECURITY DEFINER
-- functions (see lib/game.ts comments).

alter table public.game_players
  add column revealed_count integer not null default 0;

-- Backfill from any existing in-progress games.
update public.game_players gp
set revealed_count = sub.cnt
from (
  select
    player_id,
    game_code,
    count(*)::int as cnt
  from public.player_influences
  where is_revealed = true
  group by player_id, game_code
) sub
where gp.player_id = sub.player_id
  and gp.game_code = sub.game_code;
