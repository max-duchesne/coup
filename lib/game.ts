import { supabase } from "@/lib/supabase";

// ─── Types ───────────────────────────────────────────────────────────────────

export type GameStatus = "in_progress" | "finished";

/**
 * Phases:
 *  - action: current player picks an action.
 *  - awaiting_challenge: an action (or a block of an action) is on the table;
 *    eligible opponents may pass, challenge, or block.
 *      • If `pendingBlockerId` is null, opponents are responding to the actor's
 *        action.
 *      • If `pendingBlockerId` is set, opponents are responding to a block.
 *  - lose_influence: a single player must reveal one of their cards. The
 *    `loseInfluenceReason` column tells the resolver what to do next.
 *  - ambassador_exchange: the actor picks which cards to keep.
 */
export type TurnPhase =
  | "action"
  | "awaiting_challenge"
  | "lose_influence"
  | "ambassador_exchange";

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
  /**
   * Count of revealed (face-up) influences. Maintained on `game_players` so
   * every client can determine who's still alive without being able to read
   * opponents' hidden cards (RLS hides unrevealed cards from non-owners).
   * Use `isAlive(p)` rather than reading this directly.
   */
  revealedCount: number;
  influences: Influence[];
};

/**
 * Every player starts with this many face-down influences. Used together
 * with `revealedCount` to determine aliveness in a way that doesn't depend
 * on the caller being able to see the opponent's actual cards.
 */
const STARTING_INFLUENCES = 2;

/**
 * Whether a player still has at least one face-down influence.
 *
 * Implemented in terms of `revealedCount` (visible to every game
 * participant via `game_players` RLS) instead of `influences.some(i => !i.isRevealed)`,
 * because the latter only works when the caller can read the opponent's
 * unrevealed cards — which RLS prevents.
 */
export function isAlive(p: Pick<GamePlayer, "revealedCount">): boolean {
  return p.revealedCount < STARTING_INFLUENCES;
}

/**
 * The kinds of actions that go through the awaiting_challenge phase. Every
 * member here is blockable, challengeable, or both (foreign_aid is blockable
 * by Duke but not directly challengeable; tax/exchange are challengeable but
 * not blockable; steal/assassinate are both).
 */
export type PendingAction =
  | "foreign_aid"
  | "tax"
  | "steal"
  | "assassinate"
  | "exchange";

export type LoseInfluenceReason =
  | "coup"
  | "assassinate"
  | "failed_challenge_actor"
  | "failed_challenge_challenger"
  | "failed_block_challenge_blocker"
  | "failed_block_challenge_challenger";

export type GameState = {
  gameCode: string;
  status: GameStatus;
  currentTurnPlayerId: string;
  turnPhase: TurnPhase;
  pendingTargetId: string | null;
  pendingAction: PendingAction | null;
  pendingActionTargetId: string | null;
  pendingBlockerId: string | null;
  pendingBlockRole: Role | null;
  loseInfluenceReason: LoseInfluenceReason | null;
  challengePasses: string[];
  pendingAmbassadorDraw: Role[] | null;
  winnerId: string | null;
  nextGameCode: string | null;
  players: GamePlayer[];
};

export type GameAction =
  | "income"
  | "foreign_aid"
  | "tax"
  | "steal"
  | "assassinate"
  | "exchange"
  | "coup"
  | "lose_influence"
  | "challenge"
  | "block"
  | "eliminated"
  | "win";

export type GameEventMetadata = {
  targetPlayerId?: string;
  targetName?: string;
  /**
   * For "challenge" / "block" events: the role being claimed.
   * For "lose_influence" events: the role that was revealed.
   */
  role?: string;
  /** For "steal" events: the number of coins actually transferred. */
  amount?: number;
  /** For "challenge" / "block" events: the underlying action being responded to. */
  action?: PendingAction;
  /**
   * For "challenge" events: true if the challenger correctly identified a
   * bluff (the claimant did NOT have the card).
   */
  success?: boolean;
  /** For "challenge" events: true if the challenge was on a block. */
  isBlock?: boolean;
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

/**
 * The role that an action's actor claims. `null` for actions without a role
 * claim (foreign_aid → no Challenge button, only Block).
 */
export const ACTION_CLAIMED_ROLE: Record<PendingAction, Role | null> = {
  foreign_aid: null,
  tax: "duke",
  steal: "captain",
  assassinate: "assassin",
  exchange: "ambassador",
};

/**
 * Roles that can block each action, in the order they should appear in the UI.
 */
export const BLOCK_ROLES: Record<PendingAction, Role[]> = {
  foreign_aid: ["duke"],
  tax: [],
  steal: ["captain", "ambassador"],
  assassinate: ["contessa"],
  exchange: [],
};

// ─── Game setup ──────────────────────────────────────────────────────────────

export async function startGame(
  gameCode: string,
  playerIds: string[],
): Promise<void> {
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

  const { error: dealError } = await supabase.rpc("deal_initial_influences", {
    p_game_code: gameCode,
  });
  if (dealError) throw dealError;
}

// ─── Non-challengeable, non-blockable actions ───────────────────────────────

/** Take 1 coin. Not challengeable, not blockable. */
export async function takeIncome(
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

  const { error: coinsError } = await supabase
    .from("game_players")
    .update({ coins: self.coins + 1 })
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
    action: "income",
  });
  if (eventError) throw eventError;
}

// ─── Announceable actions (enter awaiting_challenge phase) ──────────────────

/** Foreign Aid: blockable by Duke (any opponent), not directly challengeable. */
export async function takeForeignAid(
  gameCode: string,
  playerId: string,
): Promise<void> {
  await _announceAction(gameCode, playerId, "foreign_aid", null);
}

/** Duke: collect 3 coins. */
export async function takeTax(
  gameCode: string,
  playerId: string,
): Promise<void> {
  await _announceAction(gameCode, playerId, "tax", null);
}

/** Captain: steal up to 2 coins from a target player. */
export async function takeSteal(
  gameCode: string,
  playerId: string,
  targetPlayerId: string,
): Promise<void> {
  const state = await fetchGameState(gameCode);
  if (!state) throw new Error("Game not found");
  const target = state.players.find((p) => p.playerId === targetPlayerId);
  if (!target) throw new Error("Target player not in game");
  if (target.coins === 0) throw new Error("Target has no coins to steal");
  await _announceAction(gameCode, playerId, "steal", targetPlayerId);
}

/**
 * Assassin: pay 3 coins, then announce. The 3 coins are deducted up front so
 * the cost is paid even if the action is challenged or blocked successfully.
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
      turn_phase: "awaiting_challenge",
      pending_action: "assassinate",
      pending_action_target_id: targetPlayerId,
      pending_blocker_id: null,
      pending_block_role: null,
      challenge_passes: [],
    })
    .eq("game_code", gameCode);
  if (phaseError) throw phaseError;
}

/** Ambassador: announce; the actual draw happens once the challenge phase resolves. */
export async function takeExchange(
  gameCode: string,
  playerId: string,
): Promise<void> {
  await _announceAction(gameCode, playerId, "exchange", null);
}

// ─── Pass / challenge / block ───────────────────────────────────────────────

/** Decline to challenge or block the pending action / block. */
export async function passChallenge(
  gameCode: string,
  playerId: string,
): Promise<void> {
  const state = await fetchGameState(gameCode);
  if (!state) throw new Error("Game not found");
  if (state.turnPhase !== "awaiting_challenge")
    throw new Error("Nothing to pass on right now");

  const me = state.players.find((p) => p.playerId === playerId);
  if (!me) throw new Error("Player not in game");
  if (!isAlive(me)) throw new Error("Eliminated players cannot pass");

  // The "owner" of the current claim cannot pass on their own claim.
  // - In action phase: the actor.
  // - In block phase: the blocker.
  const claimOwnerId = state.pendingBlockerId ?? state.currentTurnPlayerId;
  if (playerId === claimOwnerId)
    throw new Error("You cannot pass on your own claim");

  if (state.challengePasses.includes(playerId)) return;

  const updatedPasses = [...state.challengePasses, playerId];
  const { error } = await supabase
    .from("games")
    .update({ challenge_passes: updatedPasses })
    .eq("game_code", gameCode)
    .eq("turn_phase", "awaiting_challenge");
  if (error) throw error;

  // After writing the pass, see whether everyone eligible has passed.
  const refreshed = await fetchGameState(gameCode);
  if (!refreshed || refreshed.turnPhase !== "awaiting_challenge") return;

  const refreshedClaimOwnerId =
    refreshed.pendingBlockerId ?? refreshed.currentTurnPlayerId;
  const aliveResponders = refreshed.players.filter(
    (p) => p.playerId !== refreshedClaimOwnerId && isAlive(p),
  );
  const allPassed = aliveResponders.every((p) =>
    refreshed.challengePasses.includes(p.playerId),
  );

  if (!allPassed) return;

  if (refreshed.pendingBlockerId !== null) {
    // Block stands → original action does NOT resolve.
    await _completeAction(refreshed.gameCode, refreshed);
  } else {
    // No block, no challenge → original action resolves.
    await _resolvePendingAction(refreshed);
  }
}

/**
 * Challenge the pending action or pending block.
 * Resolved server-side via `resolve_challenge` so the claimant's hidden
 * cards are read with definer privileges; the challenger is always
 * `auth.uid()` inside the RPC.
 */
export async function submitChallenge(gameCode: string): Promise<void> {
  const { error } = await supabase.rpc("resolve_challenge", {
    p_game_code: gameCode,
  });
  if (error) throw error;
}

/**
 * Block the pending action by claiming a defense role. After a successful
 * write, opponents (everyone except the blocker) can pass or challenge the
 * block.
 */
export async function submitBlock(
  gameCode: string,
  blockerId: string,
  blockRole: Role,
): Promise<void> {
  const state = await fetchGameState(gameCode);
  if (!state) throw new Error("Game not found");
  if (state.turnPhase !== "awaiting_challenge")
    throw new Error("Nothing to block right now");
  if (state.pendingBlockerId !== null)
    throw new Error("Action is already being blocked");
  if (!state.pendingAction) throw new Error("No pending action to block");
  if (state.currentTurnPlayerId === blockerId)
    throw new Error("You cannot block your own action");

  const blocker = state.players.find((p) => p.playerId === blockerId);
  if (!blocker) throw new Error("Player not in game");
  if (!isAlive(blocker)) throw new Error("Eliminated players cannot block");

  const allowedRoles = BLOCK_ROLES[state.pendingAction];
  if (!allowedRoles.includes(blockRole))
    throw new Error("This action cannot be blocked with that role");

  // Eligibility: foreign_aid → any opponent; steal/assassinate → only target.
  if (
    state.pendingAction === "steal" ||
    state.pendingAction === "assassinate"
  ) {
    if (state.pendingActionTargetId !== blockerId)
      throw new Error("Only the target can block this action");
  } else if (state.pendingAction !== "foreign_aid") {
    throw new Error("This action cannot be blocked");
  }

  const { data, error } = await supabase
    .from("games")
    .update({
      pending_blocker_id: blockerId,
      pending_block_role: blockRole,
      challenge_passes: [],
    })
    .eq("game_code", gameCode)
    .eq("turn_phase", "awaiting_challenge")
    .is("pending_blocker_id", null)
    .select();
  if (error) throw error;
  if (!data || data.length === 0)
    throw new Error("Block no longer available");

  const actorName = state.players.find(
    (p) => p.playerId === state.currentTurnPlayerId,
  )?.name;
  const { error: eventError } = await supabase.from("game_events").insert({
    game_code: gameCode,
    player_id: blockerId,
    action: "block",
    metadata: {
      targetPlayerId: state.currentTurnPlayerId,
      targetName: actorName,
      role: blockRole,
      action: state.pendingAction,
    },
  });
  if (eventError) throw eventError;
}

// ─── Coup ────────────────────────────────────────────────────────────────────

/** Coup — costs 7 coins, transitions straight to lose_influence (not challengeable). */
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
      lose_influence_reason: "coup",
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

// ─── Lose influence (single entry point for all reveal-a-card flows) ────────

/**
 * Resolve a `lose_influence` phase (reveal, optional swap, phase advance).
 * All state transitions run in `lose_influence_and_resolve` so reveal and
 * swap cannot be split across client round-trips.
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

  const { error } = await supabase.rpc("lose_influence_and_resolve", {
    p_game_code: gameCode,
    p_influence_id: influenceId,
  });
  if (error) throw error;
}

// ─── Ambassador exchange resolution ─────────────────────────────────────────

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

  const draw = state.pendingAmbassadorDraw ?? [];
  const pool: Role[] = [...live.map((i) => i.role), ...draw];
  const remaining = [...pool];
  for (const role of keptRoles) {
    const idx = remaining.indexOf(role);
    if (idx === -1)
      throw new Error(`Card "${role}" is not available in the pool`);
    remaining.splice(idx, 1);
  }

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
      pending_action: null,
      pending_action_target_id: null,
      pending_blocker_id: null,
      pending_block_role: null,
      challenge_passes: [],
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

// ─── Next game ───────────────────────────────────────────────────────────────

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

// ─── Public helpers (UI uses these to compute eligibility) ──────────────────

/**
 * Roles `playerId` may use to block the currently pending action. Returns []
 * when the player can't block (action isn't blockable, already blocked, the
 * player isn't an eligible blocker, etc.).
 */
export function eligibleBlockRoles(
  state: GameState,
  playerId: string,
): Role[] {
  if (state.turnPhase !== "awaiting_challenge") return [];
  if (state.pendingBlockerId !== null) return [];
  if (state.currentTurnPlayerId === playerId) return [];
  if (!state.pendingAction) return [];

  const me = state.players.find((p) => p.playerId === playerId);
  if (!me || !isAlive(me)) return [];

  const allowed = BLOCK_ROLES[state.pendingAction];
  if (allowed.length === 0) return [];

  if (state.pendingAction === "foreign_aid") return allowed;
  if (state.pendingAction === "steal" || state.pendingAction === "assassinate") {
    return state.pendingActionTargetId === playerId ? allowed : [];
  }
  return [];
}

// ─── Queries ─────────────────────────────────────────────────────────────────

type GamePlayersJoinRow = {
  player_id: string;
  coins: number;
  seat_order: number;
  revealed_count: number;
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
      "game_code, status, current_turn_player_id, turn_phase, pending_target_id, pending_action, pending_action_target_id, pending_blocker_id, pending_block_role, lose_influence_reason, challenge_passes, pending_ambassador_draw, winner_id, next_game_code",
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
      .select("player_id, coins, seat_order, revealed_count, players(name)")
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
    revealedCount: row.revealed_count,
    influences: influencesByPlayer.get(row.player_id) ?? [],
  }));

  return {
    gameCode: game.game_code,
    status: game.status as GameStatus,
    currentTurnPlayerId: game.current_turn_player_id,
    turnPhase: game.turn_phase as TurnPhase,
    pendingTargetId: game.pending_target_id,
    pendingAction: (game.pending_action as PendingAction | null) ?? null,
    pendingActionTargetId: game.pending_action_target_id,
    pendingBlockerId: game.pending_blocker_id,
    pendingBlockRole: (game.pending_block_role as Role | null) ?? null,
    loseInfluenceReason:
      (game.lose_influence_reason as LoseInfluenceReason | null) ?? null,
    challengePasses: game.challenge_passes ?? [],
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
    if (candidate && isAlive(candidate)) {
      return candidate.playerId;
    }
  }

  return currentPlayerId;
}

// ─── Internal: announce an action (enter awaiting_challenge) ────────────────

async function _announceAction(
  gameCode: string,
  playerId: string,
  action: PendingAction,
  targetPlayerId: string | null,
): Promise<void> {
  const state = await fetchGameState(gameCode);
  if (!state) throw new Error("Game not found");
  if (state.currentTurnPlayerId !== playerId) throw new Error("Not your turn");
  if (state.turnPhase !== "action") throw new Error("Not in action phase");

  const self = state.players.find((p) => p.playerId === playerId);
  if (!self) throw new Error("Player not in game");
  if (self.coins >= 10) throw new Error("You have 10+ coins — you must Coup");

  const { error } = await supabase
    .from("games")
    .update({
      turn_phase: "awaiting_challenge",
      pending_action: action,
      pending_action_target_id: targetPlayerId,
      pending_blocker_id: null,
      pending_block_role: null,
      challenge_passes: [],
    })
    .eq("game_code", gameCode);
  if (error) throw error;
}

// ─── Internal: clear all pending state and advance the turn ─────────────────

async function _completeAction(
  gameCode: string,
  state: GameState,
): Promise<void> {
  const nextPlayerId = nextAliveTurnOrder(state, state.currentTurnPlayerId);
  const { error } = await supabase
    .from("games")
    .update({
      turn_phase: "action",
      pending_target_id: null,
      pending_action: null,
      pending_action_target_id: null,
      pending_blocker_id: null,
      pending_block_role: null,
      lose_influence_reason: null,
      challenge_passes: [],
      current_turn_player_id: nextPlayerId,
    })
    .eq("game_code", gameCode);
  if (error) throw error;
}

// ─── Internal: apply a pending action's effect ──────────────────────────────

async function _resolvePendingAction(state: GameState): Promise<void> {
  const action = state.pendingAction;
  if (!action) throw new Error("No pending action to resolve");

  const actor = state.players.find(
    (p) => p.playerId === state.currentTurnPlayerId,
  );
  if (!actor) throw new Error("Actor not in game");

  switch (action) {
    case "foreign_aid": {
      const { error: coinsError } = await supabase
        .from("game_players")
        .update({ coins: actor.coins + 2 })
        .eq("player_id", actor.playerId)
        .eq("game_code", state.gameCode);
      if (coinsError) throw coinsError;

      await supabase.from("game_events").insert({
        game_code: state.gameCode,
        player_id: actor.playerId,
        action: "foreign_aid",
      });

      await _completeAction(state.gameCode, state);
      return;
    }
    case "tax": {
      const { error: coinsError } = await supabase
        .from("game_players")
        .update({ coins: actor.coins + 3 })
        .eq("player_id", actor.playerId)
        .eq("game_code", state.gameCode);
      if (coinsError) throw coinsError;

      await supabase.from("game_events").insert({
        game_code: state.gameCode,
        player_id: actor.playerId,
        action: "tax",
      });

      await _completeAction(state.gameCode, state);
      return;
    }
    case "steal": {
      const target = state.players.find(
        (p) => p.playerId === state.pendingActionTargetId,
      );
      if (!target) throw new Error("Target player not in game");
      const stolen = Math.min(2, target.coins);

      if (stolen > 0) {
        const { error: actorErr } = await supabase
          .from("game_players")
          .update({ coins: actor.coins + stolen })
          .eq("player_id", actor.playerId)
          .eq("game_code", state.gameCode);
        if (actorErr) throw actorErr;

        const { error: targetErr } = await supabase
          .from("game_players")
          .update({ coins: target.coins - stolen })
          .eq("player_id", target.playerId)
          .eq("game_code", state.gameCode);
        if (targetErr) throw targetErr;
      }

      await supabase.from("game_events").insert({
        game_code: state.gameCode,
        player_id: actor.playerId,
        action: "steal",
        metadata: {
          targetPlayerId: target.playerId,
          targetName: target.name,
          amount: stolen,
        },
      });

      await _completeAction(state.gameCode, state);
      return;
    }
    case "exchange": {
      const { error } = await supabase.rpc("draw_ambassador_cards", {
        p_game_code: state.gameCode,
      });
      if (error) throw error;
      return;
    }
    case "assassinate": {
      const target = state.players.find(
        (p) => p.playerId === state.pendingActionTargetId,
      );
      if (!target) throw new Error("Target player not in game");

      const targetAlive = isAlive(target);

      await supabase.from("game_events").insert({
        game_code: state.gameCode,
        player_id: actor.playerId,
        action: "assassinate",
        metadata: {
          targetPlayerId: target.playerId,
          targetName: target.name,
        },
      });

      if (targetAlive) {
        const { error } = await supabase
          .from("games")
          .update({
            turn_phase: "lose_influence",
            pending_target_id: target.playerId,
            lose_influence_reason: "assassinate",
            pending_action: null,
            pending_action_target_id: null,
            pending_blocker_id: null,
            pending_block_role: null,
            challenge_passes: [],
          })
          .eq("game_code", state.gameCode);
        if (error) throw error;
      } else {
        await _completeAction(state.gameCode, state);
      }
      return;
    }
  }
}
