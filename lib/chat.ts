import { supabase } from "@/lib/supabase";

export type ChatMessage = {
  id: number;
  gameCode: string;
  playerId: string;
  playerName: string;
  message: string;
  createdAt: string;
};

export async function fetchMessages(gameCode: string): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from("chat_messages")
    .select("*")
    .eq("game_code", gameCode)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id,
    gameCode: row.game_code,
    playerId: row.player_id,
    playerName: row.player_name,
    message: row.message,
    createdAt: row.created_at,
  }));
}

export async function sendMessage(
  gameCode: string,
  playerId: string,
  playerName: string,
  message: string,
): Promise<void> {
  const trimmed = message.trim();
  if (!trimmed) return;
  const { error } = await supabase.from("chat_messages").insert({
    game_code: gameCode,
    player_id: playerId,
    player_name: playerName,
    message: trimmed,
  });
  if (error) throw error;
}
