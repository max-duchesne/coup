import { supabase } from "@/lib/supabase";

// ─── Types ───────────────────────────────────────────────────────────────────

export type GameStatus = "in_progress" | "finished";
export type TurnPhase = "action" | "lose_influence" | "ambassador_exchange";
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
  pendingAmbassadorDraw: Role[] | null;
  winnerId: string | null;
  nextGameCode: string | null;
  players: GamePlayer[];
};

// Player-initiated actions + system events written to game_events
export type GameAction =
  | "income"
  | "foreign_aid"
  | "tax"
  | "steal"
  | "assassinate"
  | "exchange"
  | "coup"
  | "lose_influence"
  | "eliminated"
  | "win";

export type GameEventMetadata = {
  targetPlayerId?: string;
  targetName?: string;
  role?: string;
  amount?: number; // coins stolen
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

function randomRole(): Role {
  return ROLES[Math.floor(Math.random() * ROLES.length)] as Role;
}

// ─── Game setup ──────────────────────────────────────────────────────────────

export async function startGame(
  gameCode: string,
  playerIds: string[],
): Promise<void> {
  // Remove any previous game with this code. Cascades to game_players,
  // player_influences, and game_events via ON DELETE CASCADE FK constraints.
  const { error: cleanupError } = await supabase
    .from("games")
    .delete()
    .eq("game_code", gameCode);
  if (cleanupError) throw cleanupError;

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

// ─── Basic actions (no role needed) ─────────────────────────────────────────

/** Take 1 coin. */
export async function takeIncome(
  gameCode: string,
  playerId: string,
): Promise<void> {
  await _takeCoinAction(gameCode, playerId, "income", 1);
}

/** Take 2 coins (Foreign Aid). */
export async function takeForeignAid(
  gameCode: string,
  playerId: string,
): Promise<void> {
  await _takeCoinAction(gameCode, playerId, "foreign_aid", 2);
}

// ─── Role actions ────────────────────────────────────────────────────────────

/** Duke: collect 3 coins from the treasury. */
export async function takeTax(
  gameCode: string,
  playerId: string,
): Promise<void> {
  await _takeCoinAction(gameCode, playerId, "tax", 3);
}

/** Captain: steal up to 2 coins from a target player. */
export async function takeSteal(
  gameCode: string,
  playerId: string,
  targetPlayerId: string,
): Promise<void> {
  const state = await fetchGameState(gameCode);
  if (!state) throw new Error("Game not found");
  if (state.currentTurnPlayerId !== playerId) throw new Error("Not your turn");
  if (state.turnPhase !== "action") throw new Error("Not in action phase");

  const self = state.players.find((p) => p.playerId === playerId);
  if (!self) throw new Error("Player not in game");
  if (self.coins >= 10) throw new Error("You have 10+ coins — you must Coup");

  const target = state.players.find((p) => p.playerId === targetPlayerId);
  if (!target) throw new Error("Target player not in game");

  const stolen = Math.min(2, target.coins);
  if (stolen === 0) throw new Error("Target has no coins to steal");

  const { error: actorCoinsError } = await supabase
    .from("game_players")
    .update({ coins: self.coins + stolen })
    .eq("player_id", playerId)
    .eq("game_code", gameCode);
  if (actorCoinsError) throw actorCoinsError;

  const { error: targetCoinsError } = await supabase
    .from("game_players")
    .update({ coins: target.coins - stolen })
    .eq("player_id", targetPlayerId)
    .eq("game_code", gameCode);
  if (targetCoinsError) throw targetCoinsError;

  const nextPlayerId = nextAliveTurnOrder(state, playerId);
  const { error: turnError } = await supabase
    .from("games")
    .update({ current_turn_player_id: nextPlayerId })
    .eq("game_code", gameCode);
  if (turnError) throw turnError;

  const { error: eventError } = await supabase.from("game_events").insert({
    game_code: gameCode,
    player_id: playerId,
    action: "steal",
    metadata: { targetPlayerId, targetName: target.name, amount: stolen },
  });
  if (eventError) throw eventError;
}

/**
 * Assassin: pay 3 coins to force target to lose an influence.
 * Reuses the same lose_influence phase as Coup.
 */
export async function takeAssassinate(
  gameCode: string,
  playerId: string,
  targetPlayerId: string,
): Promise<void> {
  const state = await fetchGameState(gameCode);
  if (!state) throw new Error("Game not found");
  if (state.currentTurnPlayerId !== playerId) throw new Error("Not your turn");
  if (state.turnPhase !== "action") throw new Error("Not in action phase");

  const self = state.players.find((p) => p.playerId === playerId);
  if (!self) throw new Error("Player not in game");
  if (self.coins >= 10) throw new Error("You have 10+ coins — you must Coup");
  if (self.coins < 3) throw new Error("Need at least 3 coins to Assassinate");

  const target = state.players.find((p) => p.playerId === targetPlayerId);
  if (!target) throw new Error("Target player not in game");

  const { error: coinsError } = await supabase
    .from("game_players")
    .update({ coins: self.coins - 3 })
    .eq("player_id", playerId)
    .eq("game_code", gameCode);
  if (coinsError) throw coinsError;

  const { error: phaseError } = await supabase
    .from("games")
    .update({
      turn_phase: "lose_influence",
      pending_target_id: targetPlayerId,
    })
    .eq("game_code", gameCode);
  if (phaseError) throw phaseError;

  const { error: eventError } = await supabase.from("game_events").insert({
    game_code: gameCode,
    player_id: playerId,
    action: "assassinate",
    metadata: { targetPlayerId, targetName: target.name },
  });
  if (eventError) throw eventError;
}

/**
 * Ambassador: draw 2 random cards and transition to the exchange phase.
 * The acting player then picks which cards to keep via resolveExchange().
 */
export async function takeExchange(
  gameCode: string,
  playerId: string,
): Promise<void> {
  const state = await fetchGameState(gameCode);
  if (!state) throw new Error("Game not found");
  if (state.currentTurnPlayerId !== playerId) throw new Error("Not your turn");
  if (state.turnPhase !== "action") throw new Error("Not in action phase");

  const self = state.players.find((p) => p.playerId === playerId);
  if (!self) throw new Error("Player not in game");
  if (self.coins >= 10) throw new Error("You have 10+ coins — you must Coup");

  const drawn: Role[] = [randomRole(), randomRole()];

  const { error } = await supabase
    .from("games")
    .update({
      turn_phase: "ambassador_exchange",
      pending_ambassador_draw: drawn,
    })
    .eq("game_code", gameCode);
  if (error) throw error;
}

/**
 * Complete an Ambassador exchange.
 * keptRoles must have exactly as many entries as the player's live influences.
 * Each role must be available in the combined pool of current live cards + drawn cards.
 */
export async function resolveExchange(
  gameCode: string,
  playerId: string,
  keptRoles: Role[],
): Promise<void> {
  const state = await fetchGameState(gameCode);
  if (!state) throw new Error("Game not found");
  if (state.turnPhase !== "ambassador_exchange")
    throw new Error("Not in exchange phase");
  if (state.currentTurnPlayerId !== playerId) throw new Error("Not your turn");

  const self = state.players.find((p) => p.playerId === playerId);
  if (!self) throw new Error("Player not in game");

  const live = self.influences.filter((i) => !i.isRevealed);
  if (keptRoles.length !== live.length) {
    throw new Error(`Must keep exactly ${live.length} card(s)`);
  }

  // Validate selection against pool = live roles + drawn cards
  const draw = state.pendingAmbassadorDraw ?? [];
  const pool: Role[] = [
    ...live.map((i) => i.role),
    ...draw,
  ];
  const remaining = [...pool];
  for (const role of keptRoles) {
    const idx = remaining.indexOf(role);
    if (idx === -1)
      throw new Error(`Card "${role}" is not available in the pool`);
    remaining.splice(idx, 1);
  }

  // Rewrite each live influence slot with the chosen roles (in position order)
  for (let i = 0; i < live.length; i++) {
    const { error } = await supabase
      .from("player_influences")
      .update({ role: keptRoles[i] })
      .eq("id", live[i].id);
    if (error) throw error;
  }

  const nextPlayerId = nextAliveTurnOrder(state, playerId);
  const { error: turnError } = await supabase
    .from("games")
    .update({
      turn_phase: "action",
      pending_ambassador_draw: null,
      current_turn_player_id: nextPlayerId,
    })
    .eq("game_code", gameCode);
  if (turnError) throw turnError;

  const { error: eventError } = await supabase.from("game_events").insert({
    game_code: gameCode,
    player_id: playerId,
    action: "exchange",
  });
  if (eventError) throw eventError;
}

// ─── Coup ────────────────────────────────────────────────────────────────────

/**
 * Coup — costs 7 coins, transitions to lose_influence phase.
 * Turn advances after the target picks a card to reveal.
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
    .update({
      turn_phase: "lose_influence",
      pending_target_id: targetPlayerId,
    })
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
 * Lose influence — target reveals one card.
 * Handles elimination and win detection.
 * Skips eliminated players when advancing the turn.
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

  // Reveal the card
  const { error: revealError } = await supabase
    .from("player_influences")
    .update({ is_revealed: true })
    .eq("id", influenceId);
  if (revealError) throw revealError;

  const { error: loseEventError } = await supabase
    .from("game_events")
    .insert({
      game_code: gameCode,
      player_id: playerId,
      action: "lose_influence",
      metadata: { role: influence.role },
    });
  if (loseEventError) throw loseEventError;

  // Compute updated influences to check for elimination
  const updatedInfluences = (self?.influences ?? []).map((i) =>
    i.id === influenceId ? { ...i, isRevealed: true } : i,
  );
  const isEliminated = updatedInfluences.every((i) => i.isRevealed);

  if (isEliminated) {
    const { error: elimEventError } = await supabase
      .from("game_events")
      .insert({ game_code: gameCode, player_id: playerId, action: "eliminated" });
    if (elimEventError) throw elimEventError;
  }

  // Check for a winner
  const updatedPlayers = state.players.map((p) =>
    p.playerId === playerId ? { ...p, influences: updatedInfluences } : p,
  );
  const alivePlayers = updatedPlayers.filter((p) =>
    p.influences.some((i) => !i.isRevealed),
  );
  const gameOver = alivePlayers.length === 1;
  const winner = gameOver ? alivePlayers[0] : null;

  if (winner) {
    const { error: winEventError } = await supabase
      .from("game_events")
      .insert({
        game_code: gameCode,
        player_id: winner.playerId,
        action: "win",
      });
    if (winEventError) throw winEventError;

    const { error: finishError } = await supabase
      .from("games")
      .update({
        turn_phase: "action",
        pending_target_id: null,
        status: "finished",
        winner_id: winner.playerId,
      })
      .eq("game_code", gameCode);
    if (finishError) throw finishError;
  } else {
    const updatedState: GameState = { ...state, players: updatedPlayers };
    const nextPlayerId = nextAliveTurnOrder(
      updatedState,
      state.currentTurnPlayerId,
    );
    const { error: turnError } = await supabase
      .from("games")
      .update({
        turn_phase: "action",
        pending_target_id: null,
        current_turn_player_id: nextPlayerId,
      })
      .eq("game_code", gameCode);
    if (turnError) throw turnError;
  }
}

/**
 * Returns the canonical next-game lobby code for a finished game.
 * The first caller writes proposedNextCode; subsequent callers get back
 * whatever code was already stored. All "Play Again" clickers land in the
 * same lobby while each player navigates independently.
 */
export async function startNextGame(
  currentGameCode: string,
  proposedNextCode: string,
): Promise<string> {
  await supabase
    .from("games")
    .update({ next_game_code: proposedNextCode })
    .eq("game_code", currentGameCode)
    .is("next_game_code", null);

  const { data, error } = await supabase
    .from("games")
    .select("next_game_code")
    .eq("game_code", currentGameCode)
    .single();
  if (error) throw error;
  return data.next_game_code ?? proposedNextCode;
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
      "game_code, status, current_turn_player_id, turn_phase, pending_target_id, pending_ambassador_draw, winner_id, next_game_code",
    )
    .eq("game_code", gameCode)
    .single();

  if (gameError) {
    if (gameError.code === "PGRST116") return null;
    throw gameError;
  }
  if (!game) return null;

  const [
    { data: gamePlayers, error: playersError },
    { data: influencesData, error: influencesError },
  ] = await Promise.all([
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
    pendingAmbassadorDraw: game.pending_ambassador_draw as Role[] | null,
    winnerId: game.winner_id,
    nextGameCode: game.next_game_code,
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
    .order("id", { ascending: true });

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

/** Returns the next player in seat order who still has at least one live influence. */
function nextAliveTurnOrder(
  state: GameState,
  currentPlayerId: string,
): string {
  const current = state.players.find((p) => p.playerId === currentPlayerId);
  const currentSeat = current?.seatOrder ?? 0;
  const n = state.players.length;

  for (let i = 1; i <= n; i++) {
    const nextSeat = (currentSeat + i) % n;
    const candidate = state.players.find((p) => p.seatOrder === nextSeat);
    if (candidate?.influences.some((inf) => !inf.isRevealed)) {
      return candidate.playerId;
    }
  }

  return currentPlayerId;
}

// ─── Internal ────────────────────────────────────────────────────────────────

/** Shared logic for single-player coin-gain actions that end the turn immediately. */
async function _takeCoinAction(
  gameCode: string,
  playerId: string,
  action: "income" | "foreign_aid" | "tax",
  delta: number,
): Promise<void> {
  const state = await fetchGameState(gameCode);
  if (!state) throw new Error("Game not found");
  if (state.currentTurnPlayerId !== playerId) throw new Error("Not your turn");
  if (state.turnPhase !== "action") throw new Error("Not in action phase");

  const self = state.players.find((p) => p.playerId === playerId);
  if (!self) throw new Error("Player not in game");
  if (self.coins >= 10) throw new Error("You have 10+ coins — you must Coup");

  const { error: coinsError } = await supabase
    .from("game_players")
    .update({ coins: self.coins + delta })
    .eq("player_id", playerId)
    .eq("game_code", gameCode);
  if (coinsError) throw coinsError;

  const nextPlayerId = nextAliveTurnOrder(state, playerId);
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
