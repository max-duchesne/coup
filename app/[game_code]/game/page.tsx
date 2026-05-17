"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { usePlayer } from "@/lib/player";
import {
  fetchGameLog,
  fetchGameState,
  takeAction,
  type GameAction,
  type GameEvent,
  type GameState,
} from "@/lib/game";

type ConnectionStatus =
  | "CONNECTING"
  | "SUBSCRIBED"
  | "CHANNEL_ERROR"
  | "TIMED_OUT"
  | "CLOSED";

type ConnectionLogEntry = {
  id: string;
  message: string;
  ts: number;
};

type PresencePayload = { id: string; name: string };

const ACTION_LABELS: Record<GameAction, string> = {
  income: "income",
  foreign_aid: "foreign aid",
};

const ACTION_DELTAS: Record<GameAction, number> = {
  income: 1,
  foreign_aid: 2,
};

function formatActionEntry(event: GameEvent, players: GameState["players"]): string {
  const delta = ACTION_DELTAS[event.action];
  const label = ACTION_LABELS[event.action];
  const next = players.find((p) => p.playerId !== event.playerId);
  return `${event.playerName} took ${label} (+${delta} coin${delta > 1 ? "s" : ""}).${next ? ` ${next.name}'s turn.` : ""}`;
}

export default function GamePage() {
  const params = useParams<{ game_code: string }>();
  const router = useRouter();
  const gameCode = (params?.game_code ?? "").toUpperCase();

  const player = usePlayer();
  const playerId = player.id;
  const playerName = player.name;

  const [dbStatus, setDbStatus] = useState<ConnectionStatus>("CONNECTING");
  const [presenceStatus, setPresenceStatus] = useState<ConnectionStatus>("CONNECTING");
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [connectionLog, setConnectionLog] = useState<ConnectionLogEntry[]>([]);
  const [onlineIds, setOnlineIds] = useState<ReadonlySet<string>>(new Set());
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

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
    const log = await fetchGameLog(gameCode);
    setEvents(log);
  }, [gameCode]);

  // DB channel — game state + event log sync
  useEffect(() => {
    if (!playerId || !gameCode) return;

    void (async () => {
      await refreshGameState();
      await refreshLog();
    })();

    const dbChannel = supabase
      .channel(`game-db:${gameCode}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "games", filter: `game_code=eq.${gameCode}` },
        () => { void refreshGameState(); },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "game_players", filter: `game_code=eq.${gameCode}` },
        () => { void refreshGameState(); },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "game_events", filter: `game_code=eq.${gameCode}` },
        () => { void refreshLog(); },
      )
      .subscribe((next) => { setDbStatus(next as ConnectionStatus); });

    return () => {
      supabase.removeChannel(dbChannel);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, [gameCode, playerId, refreshGameState, refreshLog]);

  // Presence channel — online/offline tracking + connection log
  useEffect(() => {
    if (!playerId || !gameCode || !playerName) return;

    const presenceChannel = supabase.channel(`game-presence:${gameCode}`, {
      config: { presence: { key: playerId } },
    });

    const flushOnlineIds = () => {
      const state = presenceChannel.presenceState();
      setOnlineIds(new Set(Object.keys(state)));
    };

    presenceChannel
      .on("presence", { event: "sync" }, flushOnlineIds)
      .on("presence", { event: "join" }, ({ key, newPresences }) => {
        flushOnlineIds();
        if (key === playerId) return;
        const name = (newPresences[0] as unknown as PresencePayload | undefined)?.name ?? "A player";
        setConnectionLog((prev) => [
          ...prev,
          { id: crypto.randomUUID(), message: `${name} connected.`, ts: Date.now() },
        ]);
      })
      .on("presence", { event: "leave" }, ({ key, leftPresences }) => {
        flushOnlineIds();
        if (key === playerId) return;
        const name = (leftPresences[0] as unknown as PresencePayload | undefined)?.name ?? "A player";
        setConnectionLog((prev) => [
          ...prev,
          { id: crypto.randomUUID(), message: `${name} disconnected.`, ts: Date.now() },
        ]);
      })
      .subscribe(async (next) => {
        setPresenceStatus(next as ConnectionStatus);
        if (next === "SUBSCRIBED") {
          await presenceChannel.track({ id: playerId, name: playerName });
        }
      });

    return () => {
      supabase.removeChannel(presenceChannel);
    };
  }, [gameCode, playerId, playerName]);

  // Merge DB action events and local connection events into one chronological log
  const mergedLog = useMemo(() => {
    const actionEntries = events.map((e) => ({
      key: `action-${e.id}`,
      message: formatActionEntry(e, gameState?.players ?? []),
      ts: new Date(e.createdAt).getTime(),
    }));
    const connEntries = connectionLog.map((e) => ({
      key: `conn-${e.id}`,
      message: e.message,
      ts: e.ts,
    }));
    return [...actionEntries, ...connEntries].sort((a, b) => a.ts - b.ts);
  }, [events, connectionLog, gameState?.players]);

  const handleAction = async (action: GameAction) => {
    if (!gameState || actionPending) return;
    setActionPending(true);
    try {
      await takeAction(gameCode, playerId, action);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionPending(false);
    }
  };

  if (!playerId) {
    return <main style={{ padding: 24, fontFamily: "sans-serif" }}>Loading…</main>;
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

  const isMyTurn = gameState.currentTurnPlayerId === playerId;
  const currentTurnPlayer = gameState.players.find(
    (p) => p.playerId === gameState.currentTurnPlayerId,
  );

  return (
    <main style={{ padding: 24, fontFamily: "sans-serif" }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>{gameCode}</h1>
        <span style={{ color: "#666", fontSize: 13 }}>
          db: <code>{dbStatus}</code> · presence: <code>{presenceStatus}</code>
        </span>
      </header>

      {actionError && (
        <p style={{ color: "crimson", marginTop: 12 }}>{actionError}</p>
      )}

      <section style={{ marginTop: 20 }}>
        <h2 style={{ margin: "0 0 8px" }}>Players</h2>
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {gameState.players.map((p) => {
            const isOnline = onlineIds.has(p.playerId);
            const isTurn = p.playerId === gameState.currentTurnPlayerId;
            return (
              <li
                key={p.playerId}
                style={{
                  padding: "6px 0",
                  fontWeight: isTurn ? "bold" : "normal",
                  color: isOnline ? "inherit" : "#999",
                }}
              >
                {p.name}
                {p.playerId === playerId ? " (you)" : ""}
                {" — "}
                {p.coins} coin{p.coins !== 1 ? "s" : ""}
                {isTurn ? " ← current turn" : ""}
                {!isOnline ? " (offline)" : ""}
              </li>
            );
          })}
        </ul>
      </section>

      <section style={{ marginTop: 24 }}>
        {isMyTurn ? (
          <>
            <p style={{ marginBottom: 10 }}>Your turn — choose an action:</p>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                type="button"
                disabled={actionPending}
                onClick={() => void handleAction("income")}
              >
                Take Income (+1)
              </button>
              <button
                type="button"
                disabled={actionPending}
                onClick={() => void handleAction("foreign_aid")}
              >
                Take Foreign Aid (+2)
              </button>
            </div>
          </>
        ) : (
          <p style={{ color: "#666" }}>
            Waiting for {currentTurnPlayer?.name ?? "other player"}…
          </p>
        )}
      </section>

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
