import { supabase } from "@/lib/supabase";

// ─── Types ───────────────────────────────────────────────────────────────────

export type GameStatus = "in_progress" | "finished";

/**
 * Phases:
 *  - action: current player picks an action.
 *  - awaiting_challenge: a challengeable action was announced; opponents
 *    pass or challenge before it resolves.
 *  - lose_influence: a single player must reveal one of their cards. The
 *    `loseInfluenceReason` column tells the resolver what to do next:
 *      - "coup" / "assassinate" / "failed_challenge_actor": just lose card,
 *        advance turn.
 *      - "failed_challenge_challenger": lose card, then run the action's
 *        effect (with a card swap for the actor's revealed claim).
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
  influences: Influence[];
};

/** The kind of action sitting in `awaiting_challenge`. */
export type ChallengeableAction = "tax" | "steal" | "assassinate" | "exchange";

export type LoseInfluenceReason =
  | "coup"
  | "assassinate"
  | "failed_challenge_actor"
  | "failed_challenge_challenger";

export type GameState = {
  gameCode: string;
  status: GameStatus;
  currentTurnPlayerId: string;
  turnPhase: TurnPhase;
  pendingTargetId: string | null;
  pendingAction: ChallengeableAction | null;
  pendingActionTargetId: string | null;
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
  | "eliminated"
  | "win";

export type GameEventMetadata = {
  targetPlayerId?: string;
  targetName?: string;
  role?: string;
  amount?: number;
  /** For "challenge" events: which action was being claimed. */
  action?: ChallengeableAction;
  /**
   * For "challenge" events: true if the challenger correctly identified a
   * bluff (actor did NOT have the card). False if the actor had it.
   */
  success?: boolean;
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

const ROLES: Role[] = ["duke", "assassin", "captain", "ambassador", "contessa"];
const DECK: Role[] = ROLES.flatMap((r) => [r, r, r]);
const COPIES_PER_ROLE = 3;

const ACTION_TO_ROLE: Record<ChallengeableAction, Role> = {
  tax: "duke",
  steal: "captain",
  assassinate: "assassin",
  exchange: "ambassador",
};

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

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

// ─── Non-challengeable actions (resolve immediately) ────────────────────────

/** Take 1 coin. Not challengeable. */
export async function takeIncome(
  gameCode: string,
  playerId: string,
): Promise<void> {
  await _takeCoinAction(gameCode, playerId, "income", 1);
}

/**
 * Take 2 coins (Foreign Aid). For now we treat this as not challengeable;
 * it cannot be challenged (no role claim), and the Duke block is a defense
 * action that will be added in a later step.
 */
export async function takeForeignAid(
  gameCode: string,
  playerId: string,
): Promise<void> {
  await _takeCoinAction(gameCode, playerId, "foreign_aid", 2);
}

// ─── Challengeable actions: announce, then awaiting_challenge ───────────────

/** Duke: collect 3 coins. */
export async function takeTax(
  gameCode: string,
  playerId: string,
): Promise<void> {
  await _announceChallengeableAction(gameCode, playerId, "tax", null);
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
  await _announceChallengeableAction(gameCode, playerId, "steal", targetPlayerId);
}

/**
 * Assassin: pay 3 coins, then announce. The 3 coins are deducted up front so
 * the cost is paid even if the action is challenged unsuccessfully.
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

  // Deduct 3 coins now (cost is paid even if challenged successfully).
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
  await _announceChallengeableAction(gameCode, playerId, "exchange", null);
}

// ─── Challenge resolution ───────────────────────────────────────────────────

/** Decline to challenge the pending action. */
export async function passChallenge(
  gameCode: string,
  playerId: string,
): Promise<void> {
  const state = await fetchGameState(gameCode);
  if (!state) throw new Error("Game not found");
  if (state.turnPhase !== "awaiting_challenge")
    throw new Error("No pending action to pass");
  if (state.currentTurnPlayerId === playerId)
    throw new Error("The acting player cannot pass");

  const me = state.players.find((p) => p.playerId === playerId);
  if (!me) throw new Error("Player not in game");
  if (!me.influences.some((i) => !i.isRevealed))
    throw new Error("Eliminated players cannot pass");

  if (state.challengePasses.includes(playerId)) return;

  const updatedPasses = [...state.challengePasses, playerId];
  const { error } = await supabase
    .from("games")
    .update({ challenge_passes: updatedPasses })
    .eq("game_code", gameCode)
    .eq("turn_phase", "awaiting_challenge");
  if (error) throw error;

  // Re-fetch to see the canonical pass list (in case of concurrent passes)
  // and decide whether the action should now resolve.
  const refreshed = await fetchGameState(gameCode);
  if (!refreshed || refreshed.turnPhase !== "awaiting_challenge") return;

  const aliveNonActors = refreshed.players.filter(
    (p) =>
      p.playerId !== refreshed.currentTurnPlayerId &&
      p.influences.some((i) => !i.isRevealed),
  );
  const allPassed = aliveNonActors.every((p) =>
    refreshed.challengePasses.includes(p.playerId),
  );

  if (allPassed) {
    await _resolvePendingAction(refreshed, { swapClaimed: false });
  }
}

/**
 * Challenge the pending action.
 * If the actor has the claimed role, the challenger loses an influence and
 * the action still resolves (with a card swap for the actor). Otherwise the
 * actor loses an influence and the action does not resolve.
 */
export async function submitChallenge(
  gameCode: string,
  challengerId: string,
): Promise<void> {
  const state = await fetchGameState(gameCode);
  if (!state) throw new Error("Game not found");
  if (state.turnPhase !== "awaiting_challenge")
    throw new Error("No pending action to challenge");
  if (state.currentTurnPlayerId === challengerId)
    throw new Error("The acting player cannot challenge");

  const challenger = state.players.find((p) => p.playerId === challengerId);
  if (!challenger) throw new Error("Player not in game");
  if (!challenger.influences.some((i) => !i.isRevealed))
    throw new Error("Eliminated players cannot challenge");

  const actor = state.players.find(
    (p) => p.playerId === state.currentTurnPlayerId,
  );
  if (!actor) throw new Error("Actor not in game");
  if (!state.pendingAction) throw new Error("No pending action");

  const claimedRole = ACTION_TO_ROLE[state.pendingAction];
  const actorHasClaim = actor.influences.some(
    (i) => !i.isRevealed && i.role === claimedRole,
  );

  // First-to-challenge wins: atomically transition out of awaiting_challenge.
  // If two clients race, only one update will affect a row.
  const update = actorHasClaim
    ? {
        turn_phase: "lose_influence",
        pending_target_id: challengerId,
        lose_influence_reason: "failed_challenge_challenger",
      }
    : {
        turn_phase: "lose_influence",
        pending_target_id: actor.playerId,
        lose_influence_reason: "failed_challenge_actor",
      };

  const { data: claimed, error: claimError } = await supabase
    .from("games")
    .update(update)
    .eq("game_code", gameCode)
    .eq("turn_phase", "awaiting_challenge")
    .select();
  if (claimError) throw claimError;
  if (!claimed || claimed.length === 0)
    throw new Error("Challenge no longer available");

  const { error: eventError } = await supabase.from("game_events").insert({
    game_code: gameCode,
    player_id: challengerId,
    action: "challenge",
    metadata: {
      targetPlayerId: actor.playerId,
      targetName: actor.name,
      role: claimedRole,
      action: state.pendingAction,
      success: !actorHasClaim,
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
 * Resolve a `lose_influence` phase. Behavior depends on `loseInfluenceReason`:
 *  - "failed_challenge_challenger": after the reveal, the actor swaps the
 *    claimed card with the deck and the original action resolves. For
 *    assassinate, this may chain into a second `lose_influence` for the
 *    action's target (which is the same player as the challenger when they
 *    chose to challenge their own assassination, hence two cards lost).
 *  - everything else (coup, assassinate, failed_challenge_actor, null):
 *    just reveal the card and advance the turn.
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

  const { error: loseEventError } = await supabase
    .from("game_events")
    .insert({
      game_code: gameCode,
      player_id: playerId,
      action: "lose_influence",
      metadata: { role: influence.role },
    });
  if (loseEventError) throw loseEventError;

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

  const updatedPlayers = state.players.map((p) =>
    p.playerId === playerId ? { ...p, influences: updatedInfluences } : p,
  );
  const alivePlayers = updatedPlayers.filter((p) =>
    p.influences.some((i) => !i.isRevealed),
  );

  if (alivePlayers.length === 1) {
    const winner = alivePlayers[0];
    const { error: winEventError } = await supabase.from("game_events").insert({
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
        pending_action: null,
        pending_action_target_id: null,
        lose_influence_reason: null,
        challenge_passes: [],
        status: "finished",
        winner_id: winner.playerId,
      })
      .eq("game_code", gameCode);
    if (finishError) throw finishError;
    return;
  }

  const updatedState: GameState = { ...state, players: updatedPlayers };

  if (state.loseInfluenceReason === "failed_challenge_challenger") {
    // The actor won the challenge — swap their claimed card and resolve the
    // original action.
    await _resolvePendingAction(updatedState, { swapClaimed: true });
    return;
  }

  // Default: lose_influence due to a coup, assassination, or the actor
  // failing their own challenge. Just advance the turn.
  await _completeAction(gameCode, updatedState);
}

// ─── Ambassador exchange resolution ─────────────────────────────────────────

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
      "game_code, status, current_turn_player_id, turn_phase, pending_target_id, pending_action, pending_action_target_id, lose_influence_reason, challenge_passes, pending_ambassador_draw, winner_id, next_game_code",
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
    pendingAction: (game.pending_action as ChallengeableAction | null) ?? null,
    pendingActionTargetId: game.pending_action_target_id,
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

// ─── Internal: shared coin-gain action ──────────────────────────────────────

async function _takeCoinAction(
  gameCode: string,
  playerId: string,
  action: "income" | "foreign_aid",
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

// ─── Internal: announce a challengeable action ──────────────────────────────

async function _announceChallengeableAction(
  gameCode: string,
  playerId: string,
  action: ChallengeableAction,
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
      challenge_passes: [],
    })
    .eq("game_code", gameCode);
  if (error) throw error;
}

// ─── Internal: clear all challenge / pending state and advance turn ────────

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
      lose_influence_reason: null,
      challenge_passes: [],
      current_turn_player_id: nextPlayerId,
    })
    .eq("game_code", gameCode);
  if (error) throw error;
}

// ─── Internal: apply a pending action's effect ──────────────────────────────

/**
 * Resolve the action stored in `state.pendingAction`. Called when:
 *   - All non-actor alive players have passed (`swapClaimed: false`), or
 *   - The challenger lost the challenge (`swapClaimed: true`); in that case
 *     the actor first swaps their revealed claim card with the deck.
 */
async function _resolvePendingAction(
  state: GameState,
  opts: { swapClaimed: boolean },
): Promise<void> {
  const action = state.pendingAction;
  if (!action) throw new Error("No pending action to resolve");

  const actor = state.players.find(
    (p) => p.playerId === state.currentTurnPlayerId,
  );
  if (!actor) throw new Error("Actor not in game");

  if (opts.swapClaimed) {
    await _swapClaimedCard(state, actor.playerId, ACTION_TO_ROLE[action]);
  }

  switch (action) {
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
      const drawn = _drawTwoFromDeck(state);
      const { error } = await supabase
        .from("games")
        .update({
          turn_phase: "ambassador_exchange",
          pending_ambassador_draw: drawn,
          pending_action: null,
          pending_action_target_id: null,
          lose_influence_reason: null,
          challenge_passes: [],
        })
        .eq("game_code", state.gameCode);
      if (error) throw error;
      return;
    }
    case "assassinate": {
      const target = state.players.find(
        (p) => p.playerId === state.pendingActionTargetId,
      );
      if (!target) throw new Error("Target player not in game");

      const targetAlive = target.influences.some((i) => !i.isRevealed);

      // Always log the assassinate event so the action shows up regardless of
      // whether the target was already eliminated by a failed challenge.
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

// ─── Internal: deck math ────────────────────────────────────────────────────

function _computeDeck(state: GameState): Role[] {
  const counts: Record<Role, number> = {
    duke: COPIES_PER_ROLE,
    assassin: COPIES_PER_ROLE,
    captain: COPIES_PER_ROLE,
    ambassador: COPIES_PER_ROLE,
    contessa: COPIES_PER_ROLE,
  };
  for (const p of state.players) {
    for (const inf of p.influences) {
      counts[inf.role]--;
    }
  }
  const deck: Role[] = [];
  for (const r of ROLES) {
    for (let i = 0; i < counts[r]; i++) deck.push(r);
  }
  return deck;
}

/** Pull 2 random cards off the conceptual deck. */
function _drawTwoFromDeck(state: GameState): Role[] {
  const deck = shuffle(_computeDeck(state));
  return deck.slice(0, 2);
}

/**
 * Replace the actor's revealed-claim card with a fresh draw. The card going
 * back to the deck is the one being replaced, so we treat it as available
 * again when sampling.
 */
async function _swapClaimedCard(
  state: GameState,
  actorId: string,
  role: Role,
): Promise<void> {
  const actor = state.players.find((p) => p.playerId === actorId);
  if (!actor) throw new Error("Actor not in game");
  const card = actor.influences.find((i) => !i.isRevealed && i.role === role);
  if (!card) throw new Error("Actor has no live card matching the claim");

  const deck = _computeDeck(state);
  // The card going back to the deck:
  deck.push(role);
  const newRole = deck[Math.floor(Math.random() * deck.length)] as Role;

  const { error } = await supabase
    .from("player_influences")
    .update({ role: newRole })
    .eq("id", card.id);
  if (error) throw error;
}
