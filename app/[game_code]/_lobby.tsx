"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

function errMsg(err: unknown, fallback: string): string {
  if (!err) return fallback;
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return fallback;
}
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { usePlayer } from "@/lib/player";
import { startGame } from "@/lib/game";
import {
  fetchLobbyPlayers,
  setLobbyPlayerReady,
  upsertLobbyPlayer,
  type LobbyPlayer,
} from "@/lib/lobby-players";
import { FONT_DISPLAY, M } from "@/lib/design";
import {
  Avatar,
  DisplayHeading,
  Frame,
  Pill,
  Wordmark,
} from "@/components/ui";
import Chat from "@/components/Chat";


export default function LobbyView() {
  const params = useParams<{ game_code: string }>();
  const gameCode = (params?.game_code ?? "").toUpperCase();

  const player = usePlayer();
  const playerId = player.id;
  const playerName = player.name;
  const playerLoading = player.loading;

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
    if (!playerId || !gameCode) return;

    cancelledRef.current = false;

    void (async () => {
      try {
        await upsertLobbyPlayer({
          id: playerId,
          game_code: gameCode,
          name: playerName,
        });
        if (!cancelledRef.current) await refreshPlayers();
      } catch (err) {
        if (!cancelledRef.current) {
          setLoadError(
            errMsg(err, "Failed to join lobby"),
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
      .subscribe();

    return () => {
      cancelledRef.current = true;
      supabase.removeChannel(dbChannel);
    };
  }, [gameCode, playerId, playerName, refreshPlayers]);

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
        errMsg(err, "Failed to update ready status"),
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
      // Parent page router detects games INSERT and switches to game view.
    } catch (err) {
      setLoadError(
        errMsg(err, "Failed to start game"),
      );
      setStartPending(false);
    }
  };


  if (playerLoading || !playerId) {
    return (
      <Frame>
        <main style={{ padding: 32, color: M.muted }}>Loading…</main>
      </Frame>
    );
  }

  const subheading = (() => {
    if (players.length === 0) return "Connecting…";
    if (allReady && isHost) return "Everyone is ready.";
    if (allReady) return "Waiting for the host.";
    if (players.length === 1) return "Share the game code to invite others.";
    return `${players.length} players in the lobby.`;
  })();

  return (
    <Frame>
      {/* Header */}
      <header
        style={{
          padding: "28px 48px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: `1px solid ${M.border}`,
        }}
      >
        <Wordmark size={22} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            fontSize: 14,
            color: M.muted,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}
        >
          <span style={{ fontSize: 14, color: M.muted, letterSpacing: "0.1em" }}>
            {gameCode}
          </span>
        </div>
      </header>

      <main
        style={{
          flex: 1,
          display: "flex",
          gap: 24,
          padding: "32px 24px",
          maxWidth: 1100,
          margin: "0 auto",
          width: "100%",
          alignItems: "flex-start",
        }}
      >
        {/* Left: lobby content */}
        <div style={{ flex: 1, minWidth: 0, textAlign: "center" }}>
          <DisplayHeading size={44} style={{ fontWeight: 500 }}>
            Lobby
          </DisplayHeading>
          <p
            style={{
              color: M.muted,
              fontSize: 16,
              marginTop: 10,
              lineHeight: 1.6,
            }}
          >
            {subheading}
          </p>

          {loadError && (
            <p
              style={{
                color: M.blood,
                fontSize: 16,
                marginTop: 18,
                letterSpacing: "0.02em",
              }}
            >
              {loadError}
            </p>
          )}

          {/* Seat list */}
          <div
            style={{
              marginTop: 36,
              background: M.surface,
              border: `1px solid ${M.border}`,
              borderRadius: 18,
              padding: 8,
              textAlign: "left",
            }}
          >
            {players.length === 0 ? (
              <div style={{ padding: "22px 18px", color: M.muted, fontSize: 16 }}>
                Loading players…
              </div>
            ) : (
              players.map((p, i) => {
                const online = onlineIds.has(p.id);
                const isPlayerHost = p.id === hostId;
                const status = !online
                  ? { text: "Offline", color: M.muted }
                  : p.is_ready
                    ? { text: "● Ready", color: M.good }
                    : { text: "○ Not ready", color: M.gold };

                return (
                  <div
                    key={p.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 14,
                      padding: "12px 16px",
                      borderRadius: 12,
                      borderBottom:
                        i < players.length - 1 ? `1px solid ${M.border}` : "none",
                    }}
                  >
                    <div style={{ width: 22, fontSize: 13, color: M.muted }}>
                      {String(i + 1).padStart(2, "0")}
                    </div>
                    <Avatar name={p.name} size={40} dim={!online} />
                    <div
                      style={{
                        flex: 1,
                        fontFamily: FONT_DISPLAY,
                        fontSize: 15,
                        letterSpacing: "0.12em",
                        color: online ? M.text : M.muted,
                        textTransform: "uppercase",
                      }}
                    >
                      {p.name}
                      {p.id === playerId && (
                        <span
                          style={{
                            marginLeft: 8,
                            fontFamily: "inherit",
                            fontSize: 11,
                            letterSpacing: "0.25em",
                            color: M.muted,
                          }}
                        >
                          YOU
                        </span>
                      )}
                      {isPlayerHost && (
                        <span
                          style={{
                            marginLeft: 8,
                            fontFamily: "inherit",
                            fontSize: 11,
                            letterSpacing: "0.25em",
                            color: M.gold,
                          }}
                        >
                          HOST
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        color: status.color,
                        letterSpacing: "0.18em",
                        textTransform: "uppercase",
                      }}
                    >
                      {status.text}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Actions */}
          <div
            style={{
              display: "flex",
              gap: 10,
              justifyContent: "center",
              marginTop: 28,
              flexWrap: "wrap",
            }}
          >
            <Pill
              disabled={!self || readyPending}
              onClick={() => void toggleReady()}
              accent={self?.is_ready ? "gold" : "neutral"}
            >
              {self?.is_ready ? "Unready" : "Ready"}
            </Pill>

            {isHost && (
              <Pill
                accent="gold"
                filled
                disabled={!allReady || startPending}
                onClick={() => void handleStartGame()}
              >
                {startPending ? "Starting…" : "Start game"}
              </Pill>
            )}

            {!isHost && allReady && (
              <span
                style={{
                  alignSelf: "center",
                  fontSize: 14,
                  color: M.muted,
                  letterSpacing: "0.05em",
                }}
              >
                Waiting for host.
              </span>
            )}
          </div>
        </div>

        {/* Right: chat */}
        {playerId && (
          <div style={{ width: "clamp(220px, 22vw, 280px)", flexShrink: 0, height: "calc(100vh - 120px)", position: "sticky", top: 24 }}>
            <Chat gameCode={gameCode} playerId={playerId} playerName={playerName} />
          </div>
        )}
      </main>

    </Frame>
  );
}

