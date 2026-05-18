"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { usePlayer } from "@/lib/player";
import {
  fetchGameLog,
  fetchGameState,
  loseInfluence,
  passChallenge,
  performCoup,
  resolveExchange,
  startNextGame,
  submitChallenge,
  takeAssassinate,
  takeExchange,
  takeForeignAid,
  takeIncome,
  takeSteal,
  takeTax,
  ROLE_LABELS,
  type ChallengeableAction,
  type GameEvent,
  type GameState,
  type Role,
} from "@/lib/game";

const ACTION_TO_ROLE: Record<ChallengeableAction, Role> = {
  tax: "duke",
  steal: "captain",
  assassinate: "assassin",
  exchange: "ambassador",
};

const ACTION_LABELS: Record<ChallengeableAction, string> = {
  tax: "Tax",
  steal: "Steal",
  assassinate: "Assassinate",
  exchange: "Exchange",
};

type ConnectionStatus =
  | "CONNECTING"
  | "SUBSCRIBED"
  | "CHANNEL_ERROR"
  | "TIMED_OUT"
  | "CLOSED";

type ConnectionLogEntry = { id: string; message: string; ts: number };
type PresencePayload = { id: string; name: string };

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateGameCode(length = 4): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

function formatLogEntry(event: GameEvent): string {
  const n = event.playerName;
  const t = event.metadata?.targetName;
  switch (event.action) {
    case "income":
      return `${n} took income (+1 coin).`;
    case "foreign_aid":
      return `${n} took foreign aid (+2 coins).`;
    case "tax":
      return `${n} collected tax (+3 coins).`;
    case "steal":
      return `${n} stole ${event.metadata?.amount ?? 2} coin(s) from ${t ?? "someone"}.`;
    case "assassinate":
      return `${n} assassinated ${t ?? "someone"}.`;
    case "exchange":
      return `${n} exchanged cards.`;
    case "coup":
      return `${n} couped ${t ?? "someone"}.`;
    case "lose_influence": {
      const roleLabel = event.metadata?.role
        ? (ROLE_LABELS[event.metadata.role as Role] ?? event.metadata.role)
        : "an influence";
      return `${n} lost ${roleLabel}.`;
    }
    case "challenge": {
      const role = event.metadata?.role
        ? (ROLE_LABELS[event.metadata.role as Role] ?? event.metadata.role)
        : "the claim";
      // success === true means the challenger correctly identified a bluff.
      const success = event.metadata?.success === true;
      return success
        ? `${n} challenged ${t ?? "someone"}'s ${role} claim — ${t ?? "they"} was bluffing.`
        : `${n} challenged ${t ?? "someone"}'s ${role} claim — ${t ?? "they"} had it. ${n} loses an influence.`;
    }
    case "eliminated":
      return `${n} is out.`;
    case "win":
      return `${n} wins!`;
    default:
      return `${n}: ${event.action}`;
  }
}

export default function GamePage() {
  const params = useParams<{ game_code: string }>();
  const router = useRouter();
  const gameCode = (params?.game_code ?? "").toUpperCase();

  const player = usePlayer();
  const playerId = player.id;
  const playerName = player.name;

  const [dbStatus, setDbStatus] = useState<ConnectionStatus>("CONNECTING");
  const [presenceStatus, setPresenceStatus] =
    useState<ConnectionStatus>("CONNECTING");
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [connectionLog, setConnectionLog] = useState<ConnectionLogEntry[]>([]);
  const [onlineIds, setOnlineIds] = useState<ReadonlySet<string>>(new Set());
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nextGamePending, setNextGamePending] = useState(false);

  // Exchange selection: keys are "held-{influenceId}" or "drawn-{index}"
  const [exchangeSelection, setExchangeSelection] = useState<Set<string>>(
    new Set(),
  );

  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showError = (msg: string) => {
    setActionError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setActionError(null), 3000);
  };

  const refreshGameState = useCallback(async () => {
    const state = await fetchGameState(gameCode);
    if (!state) {
      router.replace(`/${gameCode}`);
      return;
    }
    setGameState(state);
  }, [gameCode, router]);

  const refreshLog = useCallback(async () => {
    setEvents(await fetchGameLog(gameCode));
  }, [gameCode]);

  // DB channel
  useEffect(() => {
    if (!playerId || !gameCode) return;

    void (async () => {
      await refreshGameState();
      await refreshLog();
    })();

    const dbChannel = supabase
      .channel(`game-db:${gameCode}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "games", filter: `game_code=eq.${gameCode}` },
        () => { void refreshGameState(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "game_players", filter: `game_code=eq.${gameCode}` },
        () => { void refreshGameState(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "player_influences", filter: `game_code=eq.${gameCode}` },
        () => { void refreshGameState(); })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "game_events", filter: `game_code=eq.${gameCode}` },
        () => { void refreshLog(); })
      .subscribe((next) => { setDbStatus(next as ConnectionStatus); });

    return () => {
      supabase.removeChannel(dbChannel);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, [gameCode, playerId, refreshGameState, refreshLog]);

  // Only treat the exchange selection as active while the exchange phase is live.
  // This avoids needing a setState-in-effect reset.
  const activeExchangeSelection =
    gameState?.turnPhase === "ambassador_exchange"
      ? exchangeSelection
      : new Set<string>();

  // Presence channel
  useEffect(() => {
    if (!playerId || !gameCode || !playerName) return;

    const presenceChannel = supabase.channel(`game-presence:${gameCode}`, {
      config: { presence: { key: playerId } },
    });

    const flushOnlineIds = () =>
      setOnlineIds(new Set(Object.keys(presenceChannel.presenceState())));

    presenceChannel
      .on("presence", { event: "sync" }, flushOnlineIds)
      .on("presence", { event: "join" }, ({ key, newPresences }) => {
        flushOnlineIds();
        if (key === playerId) return;
        const name =
          (newPresences[0] as unknown as PresencePayload | undefined)?.name ??
          "A player";
        setConnectionLog((prev) => [
          ...prev,
          { id: crypto.randomUUID(), message: `${name} connected.`, ts: Date.now() },
        ]);
      })
      .on("presence", { event: "leave" }, ({ key, leftPresences }) => {
        flushOnlineIds();
        if (key === playerId) return;
        const name =
          (leftPresences[0] as unknown as PresencePayload | undefined)?.name ??
          "A player";
        setConnectionLog((prev) => [
          ...prev,
          { id: crypto.randomUUID(), message: `${name} disconnected.`, ts: Date.now() },
        ]);
      })
      .subscribe(async (next) => {
        setPresenceStatus(next as ConnectionStatus);
        if (next === "SUBSCRIBED")
          await presenceChannel.track({ id: playerId, name: playerName });
      });

    return () => { supabase.removeChannel(presenceChannel); };
  }, [gameCode, playerId, playerName]);

  const mergedLog = useMemo(() => {
    const actionEntries = events.map((e) => ({
      key: `action-${e.id}`,
      message: formatLogEntry(e),
      ts: new Date(e.createdAt).getTime(),
      id: e.id,
    }));
    const connEntries = connectionLog.map((e) => ({
      key: `conn-${e.id}`,
      message: e.message,
      ts: e.ts,
      id: null,
    }));
    return [...actionEntries, ...connEntries].sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      if (a.id !== null && b.id !== null) return a.id - b.id;
      return 0;
    });
  }, [events, connectionLog]);

  const wrap = async (fn: () => Promise<void>) => {
    setActionPending(true);
    try {
      await fn();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionPending(false);
    }
  };

  const handlePlayAgain = async () => {
    setNextGamePending(true);
    try {
      const nextCode = await startNextGame(gameCode, generateGameCode());
      router.push(`/${nextCode}`);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to start next game");
      setNextGamePending(false);
    }
  };

  const toggleExchangeCard = (key: string, limit: number) => {
    setExchangeSelection((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else if (next.size < limit) {
        next.add(key);
      }
      return next;
    });
  };

  // ── Early returns ───────────────────────────────────────────────────────────

  if (!playerId) {
    return (
      <main style={{ padding: 24, fontFamily: "sans-serif" }}>Loading…</main>
    );
  }

  if (!gameState) {
    return (
      <main style={{ padding: 24, fontFamily: "sans-serif" }}>
        <p>Connecting to game…</p>
        <p style={{ color: "#666", fontSize: 13 }}>
          db: <code>{dbStatus}</code> · presence: <code>{presenceStatus}</code>
        </p>
      </main>
    );
  }

  const {
    currentTurnPlayerId,
    turnPhase,
    pendingTargetId,
    pendingAction,
    pendingActionTargetId,
    challengePasses,
    pendingAmbassadorDraw,
    players,
    status,
    winnerId,
  } = gameState;

  const me = players.find((p) => p.playerId === playerId);
  const currentTurnPlayer = players.find(
    (p) => p.playerId === currentTurnPlayerId,
  );
  const winner = players.find((p) => p.playerId === winnerId);
  const isMyTurn = currentTurnPlayerId === playerId;
  const iMustLoseInfluence =
    turnPhase === "lose_influence" && pendingTargetId === playerId;
  const isMyExchange =
    turnPhase === "ambassador_exchange" && isMyTurn;
  const mustCoup = isMyTurn && turnPhase === "action" && (me?.coins ?? 0) >= 10;
  const canCoup = (me?.coins ?? 0) >= 7;
  const canAssassinate = (me?.coins ?? 0) >= 3;
  const canStealFrom = (p: { coins: number }) => p.coins > 0;
  const myLiveInfluences = (me?.influences ?? []).filter((i) => !i.isRevealed);
  const iAmEliminated = myLiveInfluences.length === 0;
  const aliveOpponents = players.filter(
    (p) =>
      p.playerId !== playerId && p.influences.some((i) => !i.isRevealed),
  );

  // Awaiting-challenge derived state
  const iAlreadyPassed = challengePasses.includes(playerId);
  const iCanRespondToChallenge =
    turnPhase === "awaiting_challenge" &&
    !isMyTurn &&
    !iAmEliminated &&
    !iAlreadyPassed;
  const pendingActionTarget = pendingActionTargetId
    ? players.find((p) => p.playerId === pendingActionTargetId)
    : null;

  // Ambassador exchange pool
  const exchangePool: { key: string; label: string; role: Role }[] = [
    ...myLiveInfluences.map((i) => ({
      key: `held-${i.id}`,
      label: `Your card: ${ROLE_LABELS[i.role]}`,
      role: i.role,
    })),
    ...(pendingAmbassadorDraw ?? []).map((role, idx) => ({
      key: `drawn-${idx}`,
      label: `Drawn: ${ROLE_LABELS[role]}`,
      role,
    })),
  ];

  const handleResolveExchange = (selection: Set<string>) => {
    const kept: Role[] = exchangePool
      .filter((c) => selection.has(c.key))
      .map((c) => c.role);
    void wrap(() => resolveExchange(gameCode, playerId, kept));
  };

  return (
    <main style={{ padding: 24, fontFamily: "sans-serif" }}>
      {/* Header */}
      <header style={{ display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>{gameCode}</h1>
        <span style={{ color: "#666", fontSize: 13 }}>
          db: <code>{dbStatus}</code> · presence: <code>{presenceStatus}</code>
        </span>
      </header>

      {actionError && (
        <p style={{ color: "crimson", marginTop: 12 }}>{actionError}</p>
      )}

      {/* Player list */}
      <section style={{ marginTop: 20 }}>
        <h2 style={{ margin: "0 0 8px" }}>Players</h2>
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {players.map((p) => {
            const isOnline = onlineIds.has(p.playerId);
            const isTurn =
              p.playerId === currentTurnPlayerId && status === "in_progress";
            const isMe = p.playerId === playerId;
            const isElim = p.influences.every((i) => i.isRevealed);
            return (
              <li
                key={p.playerId}
                style={{
                  padding: "6px 0",
                  fontWeight: isTurn ? "bold" : "normal",
                  color: isElim ? "#999" : isOnline ? "inherit" : "#bbb",
                  textDecoration: isElim ? "line-through" : "none",
                }}
              >
                {p.name}
                {isMe ? " (you)" : ""}
                {isElim
                  ? " — out"
                  : ` — ${p.coins} coin${p.coins !== 1 ? "s" : ""}`}
                {isTurn ? " ← current turn" : ""}
                {!isElim && !isOnline ? " (offline)" : ""}
                {!isElim && (
                  <ul style={{ listStyle: "none", padding: "4px 0 0 16px", margin: 0, fontSize: 13 }}>
                    {p.influences.map((inf) => (
                      <li
                        key={inf.id}
                        style={{ color: inf.isRevealed ? "#c00" : "inherit" }}
                      >
                        {isMe || inf.isRevealed ? ROLE_LABELS[inf.role] : "Hidden"}
                        {inf.isRevealed ? " (revealed)" : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* Action area */}
      {status === "in_progress" && (
        <section style={{ marginTop: 24 }}>
          {iMustLoseInfluence ? (
            <>
              <p style={{ fontWeight: "bold", marginBottom: 10 }}>
                You must lose an influence — choose a card:
              </p>
              <div style={{ display: "flex", gap: 10 }}>
                {myLiveInfluences.map((inf) => (
                  <button
                    key={inf.id}
                    type="button"
                    disabled={actionPending}
                    onClick={() =>
                      void wrap(() => loseInfluence(gameCode, playerId, inf.id))
                    }
                  >
                    Lose {ROLE_LABELS[inf.role]}
                  </button>
                ))}
              </div>
            </>
          ) : turnPhase === "lose_influence" ? (
            <p style={{ color: "#666" }}>
              Waiting for{" "}
              {players.find((p) => p.playerId === pendingTargetId)?.name ??
                "opponent"}{" "}
              to choose a card to lose…
            </p>
          ) : isMyExchange ? (
            <>
              <p style={{ fontWeight: "bold", marginBottom: 8 }}>
                Choose {myLiveInfluences.length} card{myLiveInfluences.length !== 1 ? "s" : ""} to keep:
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                {exchangePool.map((card) => {
                  const selected = activeExchangeSelection.has(card.key);
                  return (
                    <button
                      key={card.key}
                      type="button"
                      disabled={
                        actionPending ||
                        (!selected &&
                          activeExchangeSelection.size >= myLiveInfluences.length)
                      }
                      onClick={() =>
                        toggleExchangeCard(card.key, myLiveInfluences.length)
                      }
                      style={{
                        outline: selected ? "2px solid #0070f3" : "none",
                        fontWeight: selected ? "bold" : "normal",
                      }}
                    >
                      {card.label}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                disabled={
                  actionPending ||
                  activeExchangeSelection.size !== myLiveInfluences.length
                }
                onClick={() => handleResolveExchange(activeExchangeSelection)}
              >
                Confirm ({activeExchangeSelection.size}/{myLiveInfluences.length} selected)
              </button>
            </>
          ) : turnPhase === "ambassador_exchange" ? (
            <p style={{ color: "#666" }}>
              Waiting for {currentTurnPlayer?.name ?? "someone"} to exchange
              cards…
            </p>
          ) : turnPhase === "awaiting_challenge" && pendingAction ? (
            <>
              <p style={{ marginBottom: 8 }}>
                <strong>{currentTurnPlayer?.name ?? "Someone"}</strong> claims{" "}
                <strong>{ROLE_LABELS[ACTION_TO_ROLE[pendingAction]]}</strong> to{" "}
                {ACTION_LABELS[pendingAction]}
                {pendingActionTarget ? ` ${pendingAction === "steal" ? "from" : "on"} ${pendingActionTarget.name}` : ""}.
              </p>
              {iCanRespondToChallenge ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    disabled={actionPending}
                    onClick={() =>
                      void wrap(() => passChallenge(gameCode, playerId))
                    }
                  >
                    Pass
                  </button>
                  <button
                    type="button"
                    disabled={actionPending}
                    onClick={() =>
                      void wrap(() => submitChallenge(gameCode, playerId))
                    }
                  >
                    Challenge
                  </button>
                </div>
              ) : isMyTurn ? (
                <p style={{ color: "#666" }}>
                  Waiting for opponents to pass or challenge…
                </p>
              ) : iAmEliminated ? (
                <p style={{ color: "#999" }}>You are out — spectating.</p>
              ) : iAlreadyPassed ? (
                <p style={{ color: "#666" }}>
                  You passed — waiting for other players…
                </p>
              ) : null}
            </>
          ) : iAmEliminated ? (
            <p style={{ color: "#999" }}>You are out — spectating.</p>
          ) : isMyTurn ? (
            <>
              {mustCoup && (
                <p style={{ color: "crimson", marginBottom: 8 }}>
                  You have 10+ coins — you must Coup!
                </p>
              )}
              <p style={{ marginBottom: 8 }}>Your turn:</p>

              {/* General actions */}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                <button
                  type="button"
                  disabled={actionPending || mustCoup}
                  onClick={() => void wrap(() => takeIncome(gameCode, playerId))}
                >
                  Income (+1)
                </button>
                <button
                  type="button"
                  disabled={actionPending || mustCoup}
                  onClick={() =>
                    void wrap(() => takeForeignAid(gameCode, playerId))
                  }
                >
                  Foreign Aid (+2)
                </button>
                <button
                  type="button"
                  disabled={actionPending || mustCoup}
                  onClick={() => void wrap(() => takeTax(gameCode, playerId))}
                >
                  Tax — Duke (+3)
                </button>
                <button
                  type="button"
                  disabled={actionPending || mustCoup}
                  onClick={() =>
                    void wrap(() => takeExchange(gameCode, playerId))
                  }
                >
                  Exchange — Ambassador
                </button>
              </div>

              {/* Per-opponent actions */}
              {aliveOpponents.map((target) => (
                <div
                  key={target.playerId}
                  style={{
                    display: "flex",
                    gap: 8,
                    flexWrap: "wrap",
                    marginBottom: 8,
                    alignItems: "center",
                  }}
                >
                  <span style={{ minWidth: 80, fontSize: 13, color: "#555" }}>
                    vs {target.name}:
                  </span>
                  <button
                    type="button"
                    disabled={
                      actionPending || mustCoup || !canStealFrom(target)
                    }
                    onClick={() =>
                      void wrap(() =>
                        takeSteal(gameCode, playerId, target.playerId),
                      )
                    }
                  >
                    Steal — Captain
                  </button>
                  <button
                    type="button"
                    disabled={actionPending || mustCoup || !canAssassinate}
                    onClick={() =>
                      void wrap(() =>
                        takeAssassinate(gameCode, playerId, target.playerId),
                      )
                    }
                  >
                    Assassinate — Assassin (3 coins)
                  </button>
                  <button
                    type="button"
                    disabled={actionPending || !canCoup}
                    onClick={() =>
                      void wrap(() =>
                        performCoup(gameCode, playerId, target.playerId),
                      )
                    }
                  >
                    Coup (7 coins)
                  </button>
                </div>
              ))}
            </>
          ) : (
            <p style={{ color: "#666" }}>
              Waiting for {currentTurnPlayer?.name ?? "other player"}…
            </p>
          )}
        </section>
      )}

      {/* Game over */}
      {status === "finished" && (
        <section style={{ marginTop: 24 }}>
          <h2 style={{ margin: "0 0 12px" }}>
            {winner
              ? winner.playerId === playerId
                ? "You win!"
                : `${winner.name} wins!`
              : "Game over"}
          </h2>
          <div style={{ display: "flex", gap: 12 }}>
            <button type="button" onClick={() => router.push("/")}>
              Quit
            </button>
            <button
              type="button"
              disabled={nextGamePending}
              onClick={() => void handlePlayAgain()}
            >
              {nextGamePending ? "Starting…" : "Play Again"}
            </button>
          </div>
        </section>
      )}

      {/* Log */}
      {mergedLog.length > 0 && (
        <section style={{ marginTop: 24 }}>
          <h2 style={{ margin: "0 0 8px" }}>Log</h2>
          <ol style={{ paddingLeft: 20, margin: 0 }}>
            {mergedLog.map((entry) => (
              <li key={entry.key} style={{ marginBottom: 4 }}>
                {entry.message}
              </li>
            ))}
          </ol>
        </section>
      )}
    </main>
  );
}
