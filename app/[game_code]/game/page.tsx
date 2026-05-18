"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { usePlayer } from "@/lib/player";
import {
  fetchGameLog,
  fetchGameState,
  loseInfluence,
  performCoup,
  startNextGame,
  takeAction,
  ROLE_LABELS,
  type GameEvent,
  type GameState,
} from "@/lib/game";

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

function formatLogEntry(
  event: GameEvent,
  players: GameState["players"],
): string {
  switch (event.action) {
    case "income": {
      const next = players.find((p) => p.playerId !== event.playerId);
      return `${event.playerName} took income (+1 coin).${next ? ` ${next.name}'s turn.` : ""}`;
    }
    case "foreign_aid": {
      const next = players.find((p) => p.playerId !== event.playerId);
      return `${event.playerName} took foreign aid (+2 coins).${next ? ` ${next.name}'s turn.` : ""}`;
    }
    case "coup":
      return `${event.playerName} couped ${event.metadata?.targetName ?? "someone"}.`;
    case "lose_influence": {
      const roleLabel = event.metadata?.role
        ? (ROLE_LABELS[event.metadata.role as keyof typeof ROLE_LABELS] ??
          event.metadata.role)
        : "an influence";
      return `${event.playerName} lost ${roleLabel}.`;
    }
    case "eliminated":
      return `${event.playerName} is out.`;
    case "win":
      return `${event.playerName} wins!`;
    default:
      return `${event.playerName}: ${event.action}`;
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

  // DB channel — game state + log sync
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


  // Presence channel — online/offline + connection log
  useEffect(() => {
    if (!playerId || !gameCode || !playerName) return;

    const presenceChannel = supabase.channel(`game-presence:${gameCode}`, {
      config: { presence: { key: playerId } },
    });

    const flushOnlineIds = () => {
      setOnlineIds(new Set(Object.keys(presenceChannel.presenceState())));
    };

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
      message: formatLogEntry(e, gameState?.players ?? []),
      ts: new Date(e.createdAt).getTime(),
      id: e.id,
    }));
    const connEntries = connectionLog.map((e) => ({
      key: `conn-${e.id}`,
      message: e.message,
      ts: e.ts,
      id: null,
    }));
    // Sort: action entries by event id (stable insert order), connection events
    // by wall-clock timestamp, interleaved by timestamp.
    return [...actionEntries, ...connEntries].sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      if (a.id !== null && b.id !== null) return a.id - b.id;
      return 0;
    });
  }, [events, connectionLog, gameState?.players]);

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

  const { currentTurnPlayerId, turnPhase, pendingTargetId, players, status, winnerId } =
    gameState;
  const me = players.find((p) => p.playerId === playerId);
  const currentTurnPlayer = players.find((p) => p.playerId === currentTurnPlayerId);
  const winner = players.find((p) => p.playerId === winnerId);
  const isMyTurn = currentTurnPlayerId === playerId;
  const iMustLoseInfluence =
    turnPhase === "lose_influence" && pendingTargetId === playerId;
  const mustCoup = isMyTurn && turnPhase === "action" && (me?.coins ?? 0) >= 10;
  const canCoup = (me?.coins ?? 0) >= 7;
  const myLiveInfluences = (me?.influences ?? []).filter((i) => !i.isRevealed);
  const iAmEliminated = myLiveInfluences.length === 0;

  return (
    <main style={{ padding: 24, fontFamily: "sans-serif" }}>
      {/* Header */}
      <header
        style={{ display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}
      >
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
            const isTurn = p.playerId === currentTurnPlayerId && status === "in_progress";
            const isMe = p.playerId === playerId;
            const isEliminated = p.influences.every((i) => i.isRevealed);
            return (
              <li
                key={p.playerId}
                style={{
                  padding: "6px 0",
                  fontWeight: isTurn ? "bold" : "normal",
                  color: isEliminated ? "#999" : isOnline ? "inherit" : "#bbb",
                  textDecoration: isEliminated ? "line-through" : "none",
                }}
              >
                {p.name}
                {isMe ? " (you)" : ""}
                {isEliminated ? " — out" : ` — ${p.coins} coin${p.coins !== 1 ? "s" : ""}`}
                {isTurn ? " ← current turn" : ""}
                {!isEliminated && !isOnline ? " (offline)" : ""}
                {/* Influences */}
                {!isEliminated && (
                  <ul style={{ listStyle: "none", padding: "4px 0 0 16px", margin: 0, fontSize: 13 }}>
                    {p.influences.map((inf) => (
                      <li
                        key={inf.id}
                        style={{ color: inf.isRevealed ? "#c00" : "inherit" }}
                      >
                        {isMe || inf.isRevealed
                          ? ROLE_LABELS[inf.role]
                          : "Hidden"}
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

      {/* Action area — hidden once game is over */}
      {status === "in_progress" && (
        <section style={{ marginTop: 24 }}>
          {iMustLoseInfluence ? (
            <>
              <p style={{ fontWeight: "bold", marginBottom: 10 }}>
                You have been couped — choose an influence to lose:
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
              to choose an influence…
            </p>
          ) : iAmEliminated ? (
            <p style={{ color: "#999" }}>You are out — spectating.</p>
          ) : isMyTurn ? (
            <>
              {mustCoup && (
                <p style={{ color: "crimson", marginBottom: 8 }}>
                  You have 10+ coins — you must Coup!
                </p>
              )}
              <p style={{ marginBottom: 10 }}>Your turn — choose an action:</p>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  disabled={actionPending || mustCoup}
                  onClick={() =>
                    void wrap(() => takeAction(gameCode, playerId, "income"))
                  }
                >
                  Take Income (+1)
                </button>
                <button
                  type="button"
                  disabled={actionPending || mustCoup}
                  onClick={() =>
                    void wrap(() =>
                      takeAction(gameCode, playerId, "foreign_aid"),
                    )
                  }
                >
                  Take Foreign Aid (+2)
                </button>
                {players
                  .filter(
                    (p) =>
                      p.playerId !== playerId &&
                      p.influences.some((i) => !i.isRevealed),
                  )
                  .map((target) => (
                    <button
                      key={target.playerId}
                      type="button"
                      disabled={actionPending || !canCoup}
                      onClick={() =>
                        void wrap(() =>
                          performCoup(gameCode, playerId, target.playerId),
                        )
                      }
                    >
                      Coup {target.name} (7 coins)
                    </button>
                  ))}
              </div>
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
            <button
              type="button"
              onClick={() => router.push("/")}
            >
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
