"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/chat";
import { useMobile } from "@/lib/hooks";

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
import {
  startGame,
  updateLobbySettings,
  ALL_ROLES,
  DEFAULT_ROLE_COUNTS,
  ROLE_LABELS,
  type Role,
} from "@/lib/game";
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
  const [cardsPerPlayer, setCardsPerPlayer] = useState(2);
  const [roleCounts, setRoleCounts] = useState<Record<Role, number>>(
    DEFAULT_ROLE_COUNTS,
  );
  const [settingsPending, setSettingsPending] = useState(false);

  const isMobile = useMobile();
  const chatOpenRef = useRef(false);
  const [chatOpen, setChatOpenState] = useState(false);
  const setChatOpen = useCallback((open: boolean) => {
    chatOpenRef.current = open;
    setChatOpenState(open);
  }, []);
  const [unreadCount, setUnreadCount] = useState(0);
  const [chatToast, setChatToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleNewChatMessage = useCallback((msg: ChatMessage) => {
    if (!chatOpenRef.current) {
      setUnreadCount((prev) => prev + 1);
      const text = `${msg.playerName}: ${msg.message}`;
      setChatToast(text);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      toastTimerRef.current = setTimeout(() => setChatToast(null), 3500);
    }
  }, []);

  const cancelledRef = useRef(false);

  const refreshPlayers = useCallback(async () => {
    const rows = await fetchLobbyPlayers(gameCode);
    setPlayers(rows);
    setLoadError(null);
  }, [gameCode]);

  // DB channel — seat list, ready state, and game settings.
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
          setLoadError(errMsg(err, "Failed to join lobby"));
        }
      }

      // Load any settings the host already set.
      if (!cancelledRef.current) {
        const { data: existingGame } = await supabase
          .from("games")
          .select("cards_per_player, role_counts")
          .eq("game_code", gameCode)
          .maybeSingle();
        if (existingGame && !cancelledRef.current) {
          setCardsPerPlayer(existingGame.cards_per_player);
          if (existingGame.role_counts)
            setRoleCounts(existingGame.role_counts as Record<Role, number>);
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
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "games",
          filter: `game_code=eq.${gameCode}`,
        },
        (payload) => {
          const row = payload.new as {
            cards_per_player?: number;
            role_counts?: Record<Role, number>;
            status?: string;
          } | null;
          // Only apply settings updates for lobby rows, not in_progress rows
          // (page.tsx handles the in_progress transition to game view).
          if (row && row.status !== "in_progress" && row.status !== "finished") {
            if (row.cards_per_player != null)
              setCardsPerPlayer(row.cards_per_player);
            if (row.role_counts != null)
              setRoleCounts(row.role_counts);
          }
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

  const handleCardsPerPlayerChange = async (value: number) => {
    if (!isHost || !playerId) return;
    const next = Math.max(1, Math.min(5, value));
    setCardsPerPlayer(next);
    setSettingsPending(true);
    try {
      await updateLobbySettings(gameCode, playerId, next, roleCounts);
    } catch (err) {
      setLoadError(errMsg(err, "Failed to update settings"));
    } finally {
      setSettingsPending(false);
    }
  };

  const handleRoleCountChange = async (role: Role, value: number) => {
    if (!isHost || !playerId) return;
    const next = Math.max(0, Math.min(10, value));
    const nextCounts = { ...roleCounts, [role]: next };
    setRoleCounts(nextCounts);
    setSettingsPending(true);
    try {
      await updateLobbySettings(gameCode, playerId, cardsPerPlayer, nextCounts);
    } catch (err) {
      setLoadError(errMsg(err, "Failed to update settings"));
    } finally {
      setSettingsPending(false);
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


  const stepBtnStyle = (active: boolean): React.CSSProperties => ({
    width: 28,
    height: 28,
    borderRadius: 8,
    border: `1px solid ${M.border}`,
    background: M.surface2,
    color: M.text,
    cursor: active ? "pointer" : "not-allowed",
    opacity: active ? 1 : 0.4,
    fontSize: 16,
    lineHeight: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  });

  const counterStyle: React.CSSProperties = {
    fontSize: 20,
    color: M.text,
    minWidth: 24,
    textAlign: "center",
    fontVariantNumeric: "tabular-nums",
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
          padding: isMobile ? "18px 16px" : "28px 24px",
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
          flexDirection: isMobile ? "column" : "row",
          gap: 24,
          padding: isMobile ? "20px 12px 96px" : "32px 24px",
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
                  ? { text: "Disconnected", color: M.muted }
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

          {/* Settings panel */}
          <div
            style={{
              marginTop: 28,
              background: M.surface,
              border: `1px solid ${M.border}`,
              borderRadius: 18,
              padding: "20px 24px",
              textAlign: "left",
            }}
          >
            <div
              style={{
                fontSize: 11,
                letterSpacing: "0.22em",
                textTransform: "uppercase",
                color: M.muted,
                marginBottom: 16,
              }}
            >
              Game settings
            </div>
            {/* Cards per player row */}
            {(() => {
              const value = cardsPerPlayer;
              return (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 20,
                  }}
                >
                  <div style={{ fontSize: 13, color: M.mutedHi, letterSpacing: "0.05em" }}>
                    Cards per player
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <button
                      disabled={!isHost || settingsPending || value <= 1}
                      onClick={() => void handleCardsPerPlayerChange(value - 1)}
                      style={stepBtnStyle(isHost && !settingsPending && value > 1)}
                    >
                      −
                    </button>
                    <span style={counterStyle}>{value}</span>
                    <button
                      disabled={!isHost || settingsPending || value >= 5}
                      onClick={() => void handleCardsPerPlayerChange(value + 1)}
                      style={stepBtnStyle(isHost && !settingsPending && value < 5)}
                    >
                      +
                    </button>
                  </div>
                </div>
              );
            })()}

            {/* Divider */}
            <div
              style={{
                fontSize: 11,
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                color: M.muted,
                marginBottom: 12,
              }}
            >
              Copies per role
            </div>

            {/* Per-role rows */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {ALL_ROLES.map((role) => {
                const value = roleCounts[role];
                return (
                  <div
                    key={role}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <div style={{ fontSize: 13, color: M.mutedHi, letterSpacing: "0.05em" }}>
                      {ROLE_LABELS[role]}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <button
                        disabled={!isHost || settingsPending || value <= 0}
                        onClick={() => void handleRoleCountChange(role, value - 1)}
                        style={stepBtnStyle(isHost && !settingsPending && value > 0)}
                      >
                        −
                      </button>
                      <span style={counterStyle}>{value}</span>
                      <button
                        disabled={!isHost || settingsPending || value >= 10}
                        onClick={() => void handleRoleCountChange(role, value + 1)}
                        style={stepBtnStyle(isHost && !settingsPending && value < 10)}
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {!isHost && (
              <div style={{ fontSize: 11, color: M.muted, letterSpacing: "0.1em", marginTop: 12 }}>
                Host only
              </div>
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

        {/* Right: chat (desktop only) */}
        {playerId && !isMobile && (
          <div style={{ width: "clamp(260px, 24vw, 340px)", flexShrink: 0, height: "calc(100vh - 120px)", position: "sticky", top: 24 }}>
            <Chat gameCode={gameCode} playerId={playerId} playerName={playerName} onNewMessage={handleNewChatMessage} />
          </div>
        )}

        {/* Mobile: floating chat button + slide-in overlay + toast */}
        {playerId && isMobile && (
          <>
            {chatToast && (
              <div
                style={{
                  position: "fixed",
                  top: 16,
                  left: "50%",
                  transform: "translateX(-50%)",
                  zIndex: 300,
                  background: M.surface2,
                  border: `1px solid ${M.border}`,
                  borderRadius: 12,
                  padding: "10px 18px",
                  fontSize: 14,
                  color: M.text,
                  maxWidth: "calc(100vw - 48px)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
                  pointerEvents: "none",
                }}
              >
                {chatToast}
              </div>
            )}

            <button
              onClick={() => { setChatOpen(true); setUnreadCount(0); }}
              style={{
                position: "fixed",
                bottom: 24,
                right: 20,
                zIndex: 100,
                width: 52,
                height: 52,
                borderRadius: "50%",
                background: M.surface2,
                border: `1px solid ${M.borderHi}`,
                color: M.gold,
                fontSize: 22,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
              }}
            >
              ☰
              {unreadCount > 0 && (
                <span
                  style={{
                    position: "absolute",
                    top: 6,
                    right: 6,
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: M.blood,
                    border: `2px solid ${M.bg}`,
                  }}
                />
              )}
            </button>

            <div
              style={{
                position: "fixed",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 200,
                background: M.bg,
                display: "flex",
                flexDirection: "column",
                transform: chatOpen ? "translateX(0)" : "translateX(100%)",
                transition: "transform 0.2s ease",
              }}
            >
              <div
                style={{
                  padding: "14px 20px",
                  borderBottom: `1px solid ${M.border}`,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    fontFamily: FONT_DISPLAY,
                    fontSize: 13,
                    letterSpacing: "0.28em",
                    color: M.muted,
                    textTransform: "uppercase",
                  }}
                >
                  Chat
                </span>
                <button
                  onClick={() => setChatOpen(false)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: M.mutedHi,
                    fontSize: 20,
                    cursor: "pointer",
                    padding: "4px 8px",
                    lineHeight: 1,
                  }}
                >
                  ✕
                </button>
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                <Chat
                  gameCode={gameCode}
                  playerId={playerId}
                  playerName={playerName}
                  onNewMessage={handleNewChatMessage}
                />
              </div>
            </div>
          </>
        )}
      </main>

    </Frame>
  );
}

