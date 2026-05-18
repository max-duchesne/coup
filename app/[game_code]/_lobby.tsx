"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { usePlayer } from "@/lib/player";
import { startGame } from "@/lib/game";
import {
  fetchLobbyPlayers,
  removeLobbyPlayer,
  removeStaleSeats,
  setLobbyPlayerReady,
  upsertLobbyPlayer,
  type LobbyPlayer,
} from "@/lib/lobby-players";

type ConnectionStatus =
  | "CONNECTING"
  | "SUBSCRIBED"
  | "CHANNEL_ERROR"
  | "TIMED_OUT"
  | "CLOSED";

export default function LobbyView() {
  const params = useParams<{ game_code: string }>();
  const router = useRouter();
  const gameCode = (params?.game_code ?? "").toUpperCase();

  const player = usePlayer();
  const playerId = player.id;
  const playerName = player.name;

  const [dbStatus, setDbStatus] = useState<ConnectionStatus>("CONNECTING");
  const [presenceStatus, setPresenceStatus] =
    useState<ConnectionStatus>("CONNECTING");
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [onlineIds, setOnlineIds] = useState<ReadonlySet<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [readyPending, setReadyPending] = useState(false);
  const [startPending, setStartPending] = useState(false);

  const cancelledRef = useRef(false);

  const refreshPlayers = useCallback(async () => {
    const rows = await fetchLobbyPlayers(gameCode);
    setPlayers(rows);
    setLoadError(null);
  }, [gameCode]);

  // DB channel — seat list and ready state only.
  // Game-start navigation is handled by the parent page router.
  useEffect(() => {
    if (!playerId) return;
    if (!playerName) {
      router.replace("/");
      return;
    }
    if (!gameCode) return;

    cancelledRef.current = false;

    void (async () => {
      try {
        await removeStaleSeats(gameCode, playerName, playerId);
        await upsertLobbyPlayer({
          id: playerId,
          game_code: gameCode,
          name: playerName,
        });
        if (!cancelledRef.current) await refreshPlayers();
      } catch (err) {
        if (!cancelledRef.current) {
          setLoadError(
            err instanceof Error ? err.message : "Failed to join lobby",
          );
        }
      }
    })();

    const dbChannel = supabase
      .channel(`lobby-db:${gameCode}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "players",
          filter: `game_code=eq.${gameCode}`,
        },
        () => {
          void refreshPlayers();
        },
      )
      .subscribe((next) => {
        setDbStatus(next as ConnectionStatus);
      });

    return () => {
      cancelledRef.current = true;
      supabase.removeChannel(dbChannel);
    };
  }, [gameCode, playerId, playerName, refreshPlayers, router]);

  // Presence channel — online/offline tracking only
  useEffect(() => {
    if (!playerId || !gameCode) return;

    const presenceChannel = supabase.channel(`lobby-presence:${gameCode}`, {
      config: { presence: { key: playerId } },
    });

    const flushOnlineIds = () => {
      setOnlineIds(new Set(Object.keys(presenceChannel.presenceState())));
    };

    presenceChannel
      .on("presence", { event: "sync" }, flushOnlineIds)
      .on("presence", { event: "join" }, flushOnlineIds)
      .on("presence", { event: "leave" }, flushOnlineIds)
      .subscribe(async (next) => {
        setPresenceStatus(next as ConnectionStatus);
        if (next === "SUBSCRIBED") {
          await presenceChannel.track({ id: playerId });
        }
      });

    return () => {
      supabase.removeChannel(presenceChannel);
    };
  }, [gameCode, playerId]);

  const self = useMemo(
    () => players.find((p) => p.id === playerId),
    [players, playerId],
  );

  const hostId = players[0]?.id;
  const isHost = Boolean(hostId && hostId === playerId);
  const allReady =
    players.length > 0 &&
    players.every((p) => onlineIds.has(p.id) && p.is_ready);

  const toggleReady = async () => {
    if (!playerId || !self) return;
    setReadyPending(true);
    try {
      await setLobbyPlayerReady(playerId, !self.is_ready);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Failed to update ready status",
      );
    } finally {
      setReadyPending(false);
    }
  };

  const handleStartGame = async () => {
    if (!isHost || !allReady || startPending) return;
    setStartPending(true);
    try {
      await startGame(gameCode, players.map((p) => p.id));
      // The parent page router detects the games INSERT and switches to game view.
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Failed to start game",
      );
      setStartPending(false);
    }
  };

  const leaveLobby = async () => {
    if (playerId) await removeLobbyPlayer(playerId).catch(() => {});
    router.push("/");
  };

  if (!playerId) {
    return (
      <main style={{ padding: 24, fontFamily: "sans-serif" }}>Loading…</main>
    );
  }

  return (
    <main style={{ padding: 24, fontFamily: "sans-serif" }}>
      <header
        style={{ display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}
      >
        <h1 style={{ margin: 0 }}>{gameCode} Lobby</h1>
        <span style={{ color: "#666", fontSize: 13 }}>
          db: <code>{dbStatus}</code> · presence: <code>{presenceStatus}</code>
        </span>
        <button type="button" onClick={() => void leaveLobby()}>
          Leave
        </button>
      </header>

      {loadError && (
        <p style={{ color: "crimson", marginTop: 12 }}>{loadError}</p>
      )}

      <p style={{ marginTop: 16 }}>
        You are <strong>{playerName}</strong>
        {isHost ? " (host)" : ""}
      </p>

      <section style={{ marginTop: 16 }}>
        <button
          type="button"
          disabled={!self || readyPending}
          onClick={() => void toggleReady()}
        >
          {self?.is_ready ? "Unready" : "Ready"}
        </button>
      </section>

      <section style={{ marginTop: 16 }}>
        <h2 style={{ margin: "0 0 8px" }}>Players ({players.length})</h2>
        {players.length === 0 ? (
          <p>(loading players…)</p>
        ) : (
          <ul>
            {players.map((p) => {
              const isOnline = onlineIds.has(p.id);
              return (
                <li key={p.id} style={{ color: isOnline ? "inherit" : "#999" }}>
                  {p.name}
                  {p.id === playerId ? " (you)" : ""}
                  {p.id === hostId ? " — host" : ""}
                  {" — "}
                  {isOnline ? (p.is_ready ? "Ready" : "Not ready") : "Offline"}
                  <small style={{ marginLeft: 8 }}>
                    joined {new Date(p.joined_at).toLocaleTimeString()}
                  </small>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {allReady && isHost && (
        <section style={{ marginTop: 24 }}>
          <button
            type="button"
            disabled={startPending}
            onClick={() => void handleStartGame()}
          >
            {startPending ? "Starting…" : "Start Game"}
          </button>
        </section>
      )}

      {allReady && !isHost && (
        <p style={{ marginTop: 24, color: "#666" }}>
          Waiting for host to start the game…
        </p>
      )}
    </main>
  );
}
