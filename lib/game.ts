import { supabase } from "@/lib/supabase";

// ─── Types ───────────────────────────────────────────────────────────────────

export type GameStatus = "in_progress" | "finished";
export type TurnPhase = "action" | "lose_influence";
export type Role =
  | "duke"
  | "assassin"
  | "captain"
  | "ambassador"
  | "contessa";

export const ROLE_LABELS: Record<Role, string> = {
  duke: "Duke",
  assassin: "Assassin",
  captain: "Captain",
  ambassador: "Ambassador",
  contessa: "Contessa",
};

export type Influence = {
  id: number;
  role: Role;
  position: number;
  isRevealed: boolean;
};

export type GamePlayer = {
  playerId: string;
  name: string;
  coins: number;
  seatOrder: number;
  influences: Influence[];
};

export type GameState = {
  gameCode: string;
  status: GameStatus;
  currentTurnPlayerId: string;
  turnPhase: TurnPhase;
  pendingTargetId: string | null;
  players: GamePlayer[];
};

export type GameAction = "income" | "foreign_aid" | "coup" | "lose_influence";

export type GameEventMetadata = {
  targetPlayerId?: string;
  targetName?: string;
  role?: string;
};

export type GameEvent = {
  id: number;
  playerId: string;
  playerName: string;
  action: GameAction;
  metadata: GameEventMetadata | null;
  createdAt: string;
};

// ─── Constants ───────────────────────────────────────────────────────────────

const ROLES: Role[] = [
  "duke",
  "assassin",
  "captain",
  "ambassador",
  "contessa",
];

const DECK: Role[] = ROLES.flatMap((r) => [r, r, r]);

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

// ─── Mutations ───────────────────────────────────────────────────────────────

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

  const deck = shuffle(DECK);
  const { error: influencesError } = await supabase
    .from("player_influences")
    .insert(
      playerIds.flatMap((playerId, playerIndex) => [
        {
          game_code: gameCode,
          player_id: playerId,
          role: deck[playerIndex * 2],
          position: 0,
        },
        {
          game_code: gameCode,
          player_id: playerId,
          role: deck[playerIndex * 2 + 1],
          position: 1,
        },
      ]),
    );
  if (influencesError) throw influencesError;
}

/** Income or Foreign Aid — simple coin gain, turn advances immediately. */
export async function takeAction(
  gameCode: string,
  playerId: string,
  action: "income" | "foreign_aid",
): Promise<void> {
  const state = await fetchGameState(gameCode);
  if (!state) throw new Error("Game not found");
  if (state.currentTurnPlayerId !== playerId) throw new Error("Not your turn");
  if (state.turnPhase !== "action") throw new Error("Not in action phase");

  const self = state.players.find((p) => p.playerId === playerId);
  if (!self) throw new Error("Player not in game");
  if (self.coins >= 10) throw new Error("You have 10+ coins — you must Coup");

  const delta = action === "income" ? 1 : 2;

  // TODO: replace sequential writes with an RPC for atomicity
  const { error: coinsError } = await supabase
    .from("game_players")
    .update({ coins: self.coins + delta })
    .eq("player_id", playerId)
    .eq("game_code", gameCode);
  if (coinsError) throw coinsError;

  const nextPlayerId = nextInTurnOrder(state, playerId);
  const { error: turnError } = await supabase
    .from("games")
    .update({ current_turn_player_id: nextPlayerId })
    .eq("game_code", gameCode);
  if (turnError) throw turnError;

  const { error: eventError } = await supabase.from("game_events").insert({
    game_code: gameCode,
    player_id: playerId,
    action,
  });
  if (eventError) throw eventError;
}

/**
 * Coup — costs 7 coins, forces the target to lose an influence.
 * Transitions the game to the `lose_influence` phase; turn does not advance
 * until the target picks which card to reveal.
 */
export async function performCoup(
  gameCode: string,
  actingPlayerId: string,
  targetPlayerId: string,
): Promise<void> {
  const state = await fetchGameState(gameCode);
  if (!state) throw new Error("Game not found");
  if (state.currentTurnPlayerId !== actingPlayerId)
    throw new Error("Not your turn");
  if (state.turnPhase !== "action") throw new Error("Not in action phase");

  const self = state.players.find((p) => p.playerId === actingPlayerId);
  if (!self) throw new Error("Player not in game");
  if (self.coins < 7) throw new Error("Need at least 7 coins to Coup");

  const target = state.players.find((p) => p.playerId === targetPlayerId);
  if (!target) throw new Error("Target player not in game");

  const { error: coinsError } = await supabase
    .from("game_players")
    .update({ coins: self.coins - 7 })
    .eq("player_id", actingPlayerId)
    .eq("game_code", gameCode);
  if (coinsError) throw coinsError;

  const { error: phaseError } = await supabase
    .from("games")
    .update({ turn_phase: "lose_influence", pending_target_id: targetPlayerId })
    .eq("game_code", gameCode);
  if (phaseError) throw phaseError;

  const { error: eventError } = await supabase.from("game_events").insert({
    game_code: gameCode,
    player_id: actingPlayerId,
    action: "coup",
    metadata: { targetPlayerId, targetName: target.name },
  });
  if (eventError) throw eventError;
}

/**
 * Lose influence — target player reveals one of their face-down cards.
 * Clears the pending coup, advances to the next player's turn.
 */
export async function loseInfluence(
  gameCode: string,
  playerId: string,
  influenceId: number,
): Promise<void> {
  const state = await fetchGameState(gameCode);
  if (!state) throw new Error("Game not found");
  if (state.turnPhase !== "lose_influence")
    throw new Error("Not in lose-influence phase");
  if (state.pendingTargetId !== playerId)
    throw new Error("You are not the one who must lose an influence");

  const self = state.players.find((p) => p.playerId === playerId);
  const influence = self?.influences.find(
    (i) => i.id === influenceId && !i.isRevealed,
  );
  if (!influence) throw new Error("Invalid influence selection");

  const { error: revealError } = await supabase
    .from("player_influences")
    .update({ is_revealed: true })
    .eq("id", influenceId);
  if (revealError) throw revealError;

  const nextPlayerId = nextInTurnOrder(state, state.currentTurnPlayerId);
  const { error: turnError } = await supabase
    .from("games")
    .update({
      turn_phase: "action",
      pending_target_id: null,
      current_turn_player_id: nextPlayerId,
    })
    .eq("game_code", gameCode);
  if (turnError) throw turnError;

  const { error: eventError } = await supabase.from("game_events").insert({
    game_code: gameCode,
    player_id: playerId,
    action: "lose_influence",
    metadata: { role: influence.role },
  });
  if (eventError) throw eventError;
}

// ─── Queries ─────────────────────────────────────────────────────────────────

type GamePlayersJoinRow = {
  player_id: string;
  coins: number;
  seat_order: number;
  players: { name: string } | null;
};

type InfluenceRow = {
  id: number;
  player_id: string;
  role: string;
  position: number;
  is_revealed: boolean;
};

export async function fetchGameState(
  gameCode: string,
): Promise<GameState | null> {
  const { data: game, error: gameError } = await supabase
    .from("games")
    .select(
      "game_code, status, current_turn_player_id, turn_phase, pending_target_id",
    )
    .eq("game_code", gameCode)
    .single();

  if (gameError) {
    if (gameError.code === "PGRST116") return null;
    throw gameError;
  }
  if (!game) return null;

  const [{ data: gamePlayers, error: playersError }, { data: influencesData, error: influencesError }] =
    await Promise.all([
      supabase
        .from("game_players")
        .select("player_id, coins, seat_order, players(name)")
        .eq("game_code", gameCode)
        .order("seat_order", { ascending: true }),
      supabase
        .from("player_influences")
        .select("id, player_id, role, position, is_revealed")
        .eq("game_code", gameCode)
        .order("position", { ascending: true }),
    ]);

  if (playersError) throw playersError;
  if (influencesError) throw influencesError;

  const influencesByPlayer = new Map<string, Influence[]>();
  for (const row of (influencesData ?? []) as InfluenceRow[]) {
    if (!influencesByPlayer.has(row.player_id)) {
      influencesByPlayer.set(row.player_id, []);
    }
    influencesByPlayer.get(row.player_id)!.push({
      id: row.id,
      role: row.role as Role,
      position: row.position,
      isRevealed: row.is_revealed,
    });
  }

  const players: GamePlayer[] = (
    (gamePlayers ?? []) as GamePlayersJoinRow[]
  ).map((row) => ({
    playerId: row.player_id,
    name: row.players?.name ?? "(unknown)",
    coins: row.coins,
    seatOrder: row.seat_order,
    influences: influencesByPlayer.get(row.player_id) ?? [],
  }));

  return {
    gameCode: game.game_code,
    status: game.status as GameStatus,
    currentTurnPlayerId: game.current_turn_player_id,
    turnPhase: game.turn_phase as TurnPhase,
    pendingTargetId: game.pending_target_id,
    players,
  };
}

type GameEventsJoinRow = {
  id: number;
  player_id: string;
  action: string;
  metadata: GameEventMetadata | null;
  created_at: string;
  players: { name: string } | null;
};

export async function fetchGameLog(gameCode: string): Promise<GameEvent[]> {
  const { data, error } = await supabase
    .from("game_events")
    .select("id, player_id, action, metadata, created_at, players(name)")
    .eq("game_code", gameCode)
    .order("created_at", { ascending: true });

  if (error) throw error;

  return ((data ?? []) as GameEventsJoinRow[]).map((row) => ({
    id: row.id,
    playerId: row.player_id,
    playerName: row.players?.name ?? "(unknown)",
    action: row.action as GameAction,
    metadata: row.metadata,
    createdAt: row.created_at,
  }));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nextInTurnOrder(state: GameState, currentPlayerId: string): string {
  const current = state.players.find((p) => p.playerId === currentPlayerId);
  const nextSeat = ((current?.seatOrder ?? 0) + 1) % state.players.length;
  return (
    state.players.find((p) => p.seatOrder === nextSeat)?.playerId ??
    state.players[0].playerId
  );
}
