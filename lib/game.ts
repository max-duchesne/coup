import { supabase } from "@/lib/supabase";

export type GameStatus = "in_progress" | "finished";

export type GamePlayer = {
  playerId: string;
  name: string;
  coins: number;
  seatOrder: number;
};

export type GameState = {
  gameCode: string;
  status: GameStatus;
  currentTurnPlayerId: string;
  players: GamePlayer[];
};

export type GameAction = "income" | "foreign_aid";

export type GameEvent = {
  id: number;
  playerId: string;
  playerName: string;
  action: GameAction;
  createdAt: string;
};

// ─── Mutations ──────────────────────────────────────────────────────────────

export async function startGame(
  gameCode: string,
  playerIds: string[],
): Promise<void> {
  const { error: gameError } = await supabase.from("games").insert({
    game_code: gameCode,
    current_turn_player_id: playerIds[0],
    status: "in_progress",
  });
  if (gameError) throw gameError;

  const { error: playersError } = await supabase.from("game_players").insert(
    playerIds.map((playerId, index) => ({
      player_id: playerId,
      game_code: gameCode,
      seat_order: index,
      coins: 2,
    })),
  );
  if (playersError) throw playersError;
}

export async function takeAction(
  gameCode: string,
  playerId: string,
  action: GameAction,
): Promise<void> {
  const state = await fetchGameState(gameCode);
  if (!state) throw new Error("Game not found");
  if (state.currentTurnPlayerId !== playerId) throw new Error("Not your turn");

  const self = state.players.find((p) => p.playerId === playerId);
  if (!self) throw new Error("Player not in game");

  const delta = action === "income" ? 1 : 2;

  // Update coins — note: these two writes are sequential, not atomic.
  // TODO: replace with a Postgres function/RPC once game logic grows complex.
  const { error: coinsError } = await supabase
    .from("game_players")
    .update({ coins: self.coins + delta })
    .eq("player_id", playerId);
  if (coinsError) throw coinsError;

  const nextPlayer = state.players.find((p) => p.playerId !== playerId);
  if (!nextPlayer) throw new Error("Could not determine next player");

  const { error: turnError } = await supabase
    .from("games")
    .update({ current_turn_player_id: nextPlayer.playerId })
    .eq("game_code", gameCode);
  if (turnError) throw turnError;

  const { error: eventError } = await supabase.from("game_events").insert({
    game_code: gameCode,
    player_id: playerId,
    action,
  });
  if (eventError) throw eventError;
}

// ─── Queries ────────────────────────────────────────────────────────────────

type GamePlayersJoinRow = {
  player_id: string;
  coins: number;
  seat_order: number;
  players: { name: string } | null;
};

export async function fetchGameState(
  gameCode: string,
): Promise<GameState | null> {
  const { data: game, error: gameError } = await supabase
    .from("games")
    .select("game_code, status, current_turn_player_id")
    .eq("game_code", gameCode)
    .single();

  if (gameError) {
    // PGRST116 = no rows found
    if (gameError.code === "PGRST116") return null;
    throw gameError;
  }
  if (!game) return null;

  const { data: gamePlayers, error: playersError } = await supabase
    .from("game_players")
    .select("player_id, coins, seat_order, players(name)")
    .eq("game_code", gameCode)
    .order("seat_order", { ascending: true });

  if (playersError) throw playersError;

  const players: GamePlayer[] = (
    (gamePlayers ?? []) as GamePlayersJoinRow[]
  ).map((row) => ({
    playerId: row.player_id,
    name: row.players?.name ?? "(unknown)",
    coins: row.coins,
    seatOrder: row.seat_order,
  }));

  return {
    gameCode: game.game_code,
    status: game.status as GameStatus,
    currentTurnPlayerId: game.current_turn_player_id,
    players,
  };
}

type GameEventsJoinRow = {
  id: number;
  player_id: string;
  action: string;
  created_at: string;
  players: { name: string } | null;
};

export async function fetchGameLog(gameCode: string): Promise<GameEvent[]> {
  const { data, error } = await supabase
    .from("game_events")
    .select("id, player_id, action, created_at, players(name)")
    .eq("game_code", gameCode)
    .order("created_at", { ascending: true });

  if (error) throw error;

  return ((data ?? []) as GameEventsJoinRow[]).map((row) => ({
    id: row.id,
    playerId: row.player_id,
    playerName: row.players?.name ?? "(unknown)",
    action: row.action as GameAction,
    createdAt: row.created_at,
  }));
}
