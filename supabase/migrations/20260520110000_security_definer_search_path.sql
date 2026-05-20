-- Pin search_path on all SECURITY DEFINER game helpers and RPCs so a
-- malicious object in a user-writable schema cannot hijack resolution
-- (function_search_path_mutable / CVE-class search_path attacks).

alter function private.game_participant(text)
  set search_path to pg_catalog, public, private;

alter function private.player_alive(integer)
  set search_path to pg_catalog, public, private;

alter function private.compute_deck(text)
  set search_path to pg_catalog, public, private;

alter function private.shuffle_deck(text[])
  set search_path to pg_catalog, public, private;

alter function private.action_claimed_role(text)
  set search_path to pg_catalog, public, private;

alter function public.resolve_challenge(text)
  set search_path to pg_catalog, public, private;

alter function public.draw_ambassador_cards(text)
  set search_path to pg_catalog, public, private;
