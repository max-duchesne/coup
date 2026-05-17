import { supabase } from "@/lib/supabase";

export type LobbyPlayer = {
  id: string;
  game_code: string;
  name: string;
  is_ready: boolean;
  joined_at: string;
};

export async function fetchLobbyPlayers(
  gameCode: string,
): Promise<LobbyPlayer[]> {
  const { data, error } = await supabase
    .from("players")
    .select("id, game_code, name, is_ready, joined_at")
    .eq("game_code", gameCode)
    .order("joined_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/**
 * Join or rejoin a lobby.
 *
 * Same game code (page refresh / brief disconnect): preserves `is_ready` and
 * `joined_at` so the player's state and host order are unchanged.
 *
 * Different game code (new game after a previous one): resets `is_ready` to
 * false and refreshes `joined_at` to now(), so host order reflects who
 * actually joined first in the new lobby.
 */
export async function upsertLobbyPlayer(
  player: Pick<LobbyPlayer, "id" | "game_code" | "name">,
): Promise<void> {
  const { data: existing } = await supabase
    .from("players")
    .select("game_code")
    .eq("id", player.id)
    .maybeSingle();

  const isNewGame = !existing || existing.game_code !== player.game_code;

  const { error } = await supabase.from("players").upsert(
    {
      id: player.id,
      game_code: player.game_code,
      name: player.name,
      ...(isNewGame
        ? { is_ready: false, joined_at: new Date().toISOString() }
        : {}),
    },
    { onConflict: "id" },
  );

  if (error) throw error;
}

export async function setLobbyPlayerReady(
  playerId: string,
  isReady: boolean,
): Promise<void> {
  const { error } = await supabase
    .from("players")
    .update({ is_ready: isReady })
    .eq("id", playerId);

  if (error) throw error;
}

export async function removeLobbyPlayer(playerId: string): Promise<void> {
  const { error } = await supabase.from("players").delete().eq("id", playerId);
  if (error) throw error;
}

/**
 * Deletes any seat in the game that shares the same name but has a different
 * player ID. Called on join so that a returning player with a new UUID (e.g.
 * after their localStorage was cleared) doesn't leave a ghost "Offline" seat.
 */
export async function removeStaleSeats(
  gameCode: string,
  name: string,
  currentId: string,
): Promise<void> {
  const { error } = await supabase
    .from("players")
    .delete()
    .eq("game_code", gameCode)
    .eq("name", name)
    .neq("id", currentId);

  if (error) throw error;
}
