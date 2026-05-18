"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { usePlayer } from "@/lib/player";
import {
  ACTION_CLAIMED_ROLE,
  eligibleBlockRoles,
  fetchGameLog,
  fetchGameState,
  loseInfluence,
  passChallenge,
  performCoup,
  resolveExchange,
  startNextGame,
  submitBlock,
  submitChallenge,
  takeAssassinate,
  takeExchange,
  takeForeignAid,
  takeIncome,
  takeSteal,
  takeTax,
  ROLE_LABELS,
  type GameEvent,
  type GamePlayer,
  type GameState,
  type PendingAction,
  type Role,
} from "@/lib/game";
import { FONT_DISPLAY, M } from "@/lib/design";
import {
  Avatar,
  Card,
  Coin,
  CoinPill,
  DisplayHeading,
  Frame,
  Pill,
  SmallLabel,
  Wordmark,
} from "@/components/ui";
import Chat from "@/components/Chat";


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

const ACTION_LABELS: Record<PendingAction, string> = {
  foreign_aid: "Foreign Aid",
  tax: "Tax",
  steal: "Steal",
  assassinate: "Assassinate",
  exchange: "Exchange",
};

const TARGET_PREPOSITION: Partial<Record<PendingAction, string>> = {
  steal: "from",
  assassinate: "on",
};

function formatLogEntry(event: GameEvent): string {
  const n = event.playerName;
  const t = event.metadata?.targetName;
  switch (event.action) {
    case "income":
      return `${n} took income (+1).`;
    case "foreign_aid":
      return `${n} took foreign aid (+2).`;
    case "tax":
      return `${n} took tax (+3).`;
    case "steal":
      return `${n} stole ${event.metadata?.amount ?? 2} from ${t ?? "someone"}.`;
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
      const isBlock = event.metadata?.isBlock === true;
      const success = event.metadata?.success === true;
      const claimDescriptor = isBlock ? `${role} block` : `${role} claim`;
      return success
        ? `${n} challenged ${t ?? "someone"}'s ${claimDescriptor} — bluff exposed.`
        : `${n} challenged ${t ?? "someone"}'s ${claimDescriptor} — ${t ?? "they"} had it.`;
    }
    case "block": {
      const role = event.metadata?.role
        ? (ROLE_LABELS[event.metadata.role as Role] ?? event.metadata.role)
        : "an influence";
      const blockedAction = event.metadata?.action
        ? (ACTION_LABELS[event.metadata.action] ?? event.metadata.action)
        : "the action";
      return `${n} blocked ${t ?? "someone"}'s ${blockedAction} (claiming ${role}).`;
    }
    case "eliminated":
      return `${n} is out.`;
    case "win":
      return `${n} wins.`;
    default:
      return `${n}: ${event.action}`;
  }
}

export default function GameView() {
  const params = useParams<{ game_code: string }>();
  const router = useRouter();
  const gameCode = (params?.game_code ?? "").toUpperCase();

  const player = usePlayer();
  const playerId = player.id;
  const playerName = player.name;

  const [gameState, setGameState] = useState<GameState | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [connectionLog, setConnectionLog] = useState<ConnectionLogEntry[]>([]);
  const [onlineIds, setOnlineIds] = useState<ReadonlySet<string>>(new Set());
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nextGamePending, setNextGamePending] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{
    label: string;
    fn: () => Promise<void>;
  } | null>(null);

  // Exchange selection: keys are "held-{influenceId}" or "drawn-{index}".
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
        { event: "*", schema: "public", table: "player_influences", filter: `game_code=eq.${gameCode}` },
        () => { void refreshGameState(); },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "game_events", filter: `game_code=eq.${gameCode}` },
        () => { void refreshLog(); },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(dbChannel);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, [gameCode, playerId, refreshGameState, refreshLog]);

  // Reset exchange selection whenever we leave the exchange phase.
  // We compute it derivedly (rather than via setState in effect) to avoid
  // the set-state-in-effect lint rule.
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

  const requestConfirm = (label: string, fn: () => Promise<void>) => {
    setPendingConfirm({ label, fn });
  };

  const executeConfirm = async () => {
    if (!pendingConfirm) return;
    const { fn } = pendingConfirm;
    setPendingConfirm(null);
    await wrap(fn);
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
      if (next.has(key)) next.delete(key);
      else if (next.size < limit) next.add(key);
      return next;
    });
  };

  // ── Early returns ─────────────────────────────────────────────────────────

  if (!playerId) {
    return (
      <Frame>
        <main style={{ padding: 32, color: M.muted, fontSize: 17 }}>Loading…</main>
      </Frame>
    );
  }

  if (!gameState) {
    return (
      <Frame>
        <main style={{ padding: 32 }}>
          <p style={{ color: M.muted, fontSize: 17 }}>Connecting…</p>
        </main>
      </Frame>
    );
  }

  // ── Derived state ─────────────────────────────────────────────────────────

  const {
    currentTurnPlayerId,
    turnPhase,
    pendingTargetId,
    pendingAction,
    pendingActionTargetId,
    pendingBlockerId,
    pendingBlockRole,
    challengePasses,
    pendingAmbassadorDraw,
    players,
    status,
    winnerId,
  } = gameState;

  const me = players.find((p) => p.playerId === playerId);
  const opponents = players.filter((p) => p.playerId !== playerId);
  const currentTurnPlayer = players.find((p) => p.playerId === currentTurnPlayerId);
  const winner = players.find((p) => p.playerId === winnerId);
  const isMyTurn = currentTurnPlayerId === playerId;
  const iMustLoseInfluence =
    turnPhase === "lose_influence" && pendingTargetId === playerId;
  const isMyExchange = turnPhase === "ambassador_exchange" && isMyTurn;
  const mustCoup = isMyTurn && turnPhase === "action" && (me?.coins ?? 0) >= 10;
  const canCoup = (me?.coins ?? 0) >= 7;
  const canAssassinate = (me?.coins ?? 0) >= 3;
  const canStealFrom = (p: { coins: number }) => p.coins > 0;
  const myLiveInfluences = (me?.influences ?? []).filter((i) => !i.isRevealed);
  const iAmEliminated = myLiveInfluences.length === 0;
  const aliveOpponents = opponents.filter((p) =>
    p.influences.some((i) => !i.isRevealed),
  );

  const iAlreadyPassed = challengePasses.includes(playerId);
  const inBlockChallenge =
    turnPhase === "awaiting_challenge" && pendingBlockerId !== null;
  const blocker = pendingBlockerId
    ? players.find((p) => p.playerId === pendingBlockerId)
    : null;
  const claimOwnerId = pendingBlockerId ?? currentTurnPlayerId;
  const iAmClaimOwner = playerId === claimOwnerId;
  const iCanRespond =
    turnPhase === "awaiting_challenge" &&
    !iAmClaimOwner &&
    !iAmEliminated &&
    !iAlreadyPassed;
  const claimHasRole = inBlockChallenge
    ? pendingBlockRole !== null
    : pendingAction !== null && ACTION_CLAIMED_ROLE[pendingAction] !== null;
  const myBlockRoles =
    turnPhase === "awaiting_challenge" && !inBlockChallenge
      ? eligibleBlockRoles(gameState, playerId)
      : [];
  const pendingActionTarget = pendingActionTargetId
    ? players.find((p) => p.playerId === pendingActionTargetId)
    : null;

  const exchangePool: { key: string; label: string; role: Role }[] = [
    ...myLiveInfluences.map((i) => ({
      key: `held-${i.id}`,
      label: ROLE_LABELS[i.role],
      role: i.role,
    })),
    ...(pendingAmbassadorDraw ?? []).map((role, idx) => ({
      key: `drawn-${idx}`,
      label: ROLE_LABELS[role],
      role,
    })),
  ];

  const handleResolveExchange = (selection: Set<string>) => {
    const kept: Role[] = exchangePool
      .filter((c) => selection.has(c.key))
      .map((c) => c.role);
    void wrap(() => resolveExchange(gameCode, playerId, kept));
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Frame>
      {/* Top bar */}
      <header
        style={{
          padding: "20px 32px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: `1px solid ${M.border}`,
        }}
      >
        <Wordmark size={22} sub={`Room · ${gameCode}`} />
      </header>

      <main
        style={{
          maxWidth: 1340,
          margin: "0 auto",
          padding: "32px 24px 48px",
          display: "flex",
          gap: 24,
          alignItems: "flex-start",
          width: "100%",
        }}
      >
        {/* Left: game content */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 32,
          }}
        >
        {/* Opponents row */}
        {opponents.length > 0 && (
          <section
            style={{
              display: "flex",
              gap: 56,
              flexWrap: "wrap",
              justifyContent: "center",
            }}
          >
            {opponents.map((p) => (
              <OpponentBlock
                key={p.playerId}
                player={p}
                online={onlineIds.has(p.playerId)}
                active={p.playerId === currentTurnPlayerId && status === "in_progress"}
                isPendingTarget={
                  status === "in_progress" &&
                  ((turnPhase === "awaiting_challenge" &&
                    pendingActionTargetId === p.playerId) ||
                    pendingTargetId === p.playerId)
                }
                isBlocker={pendingBlockerId === p.playerId}
              />
            ))}
          </section>
        )}

        {/* Spotlight: contextual content based on phase */}
        <section
          style={{
            minHeight: 280,
            padding: "36px 28px",
            background: M.surface,
            border: `1px solid ${M.border}`,
            borderRadius: 18,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 22,
            textAlign: "center",
          }}
        >
          {actionError && (
            <p
              style={{
                color: M.blood,
                fontSize: 16,
                letterSpacing: "0.02em",
                margin: 0,
              }}
            >
              {actionError}
            </p>
          )}

          {pendingConfirm ? (
            <ConfirmPanel
              label={pendingConfirm.label}
              pending={actionPending}
              onConfirm={() => void executeConfirm()}
              onBack={() => setPendingConfirm(null)}
            />
          ) : status === "finished" ? (
            <GameOverPanel
              winner={winner}
              isMe={winner?.playerId === playerId}
              onQuit={() => router.push("/")}
              onPlayAgain={() => void handlePlayAgain()}
              nextGamePending={nextGamePending}
            />
          ) : iMustLoseInfluence ? (
            <>
              <SmallLabel color={M.blood}>Lose an influence</SmallLabel>
              <DisplayHeading size={32}>
                Choose a card to reveal.
              </DisplayHeading>
              <div style={{ display: "flex", gap: 14, marginTop: 4 }}>
                {myLiveInfluences.map((inf) => (
                  <Card
                    key={inf.id}
                    role={inf.role}
                    size="lg"
                    onClick={
                      actionPending
                        ? undefined
                        : () =>
                            requestConfirm(
                              `Reveal ${ROLE_LABELS[inf.role]}`,
                              () => loseInfluence(gameCode, playerId, inf.id),
                            )
                    }
                    disabled={actionPending}
                  />
                ))}
              </div>
            </>
          ) : turnPhase === "lose_influence" ? (
            <>
              <SmallLabel>Lose an influence</SmallLabel>
              <DisplayHeading size={30}>
                {players.find((p) => p.playerId === pendingTargetId)?.name ??
                  "A player"}{" "}
                is choosing a card.
              </DisplayHeading>
            </>
          ) : isMyExchange ? (
            <>
              <SmallLabel color={M.gold}>Exchange</SmallLabel>
              <DisplayHeading size={30}>
                Keep {myLiveInfluences.length} card
                {myLiveInfluences.length !== 1 ? "s" : ""}.
              </DisplayHeading>
              <div
                style={{
                  display: "flex",
                  gap: 14,
                  flexWrap: "wrap",
                  justifyContent: "center",
                  marginTop: 4,
                }}
              >
                {exchangePool.map((card) => {
                  const selected = activeExchangeSelection.has(card.key);
                  const atLimit =
                    !selected &&
                    activeExchangeSelection.size >= myLiveInfluences.length;
                  return (
                    <Card
                      key={card.key}
                      role={card.role}
                      size="md"
                      selected={selected}
                      disabled={actionPending || atLimit}
                      onClick={
                        actionPending || atLimit
                          ? undefined
                          : () =>
                              toggleExchangeCard(card.key, myLiveInfluences.length)
                      }
                    />
                  );
                })}
              </div>
              <Pill
                accent="gold"
                filled
                disabled={
                  actionPending ||
                  activeExchangeSelection.size !== myLiveInfluences.length
                }
                onClick={() => handleResolveExchange(activeExchangeSelection)}
              >
                Keep ({activeExchangeSelection.size}/{myLiveInfluences.length})
              </Pill>
            </>
          ) : turnPhase === "ambassador_exchange" ? (
            <>
              <SmallLabel>Exchange</SmallLabel>
              <DisplayHeading size={30}>
                {currentTurnPlayer?.name ?? "A player"} is exchanging.
              </DisplayHeading>
            </>
          ) : turnPhase === "awaiting_challenge" && pendingAction ? (
            <>
              <SmallLabel color={M.gold}>
                {inBlockChallenge ? "Block" : "Response"}
              </SmallLabel>
              {/* Banner */}
              {inBlockChallenge && pendingBlockRole ? (
                <DisplayHeading size={30}>
                  <span style={{ color: M.gold }}>
                    {blocker?.name ?? "Someone"}
                  </span>{" "}
                  blocks{" "}
                  <span style={{ color: M.gold }}>
                    {currentTurnPlayer?.name ?? "the actor"}
                  </span>
                  &apos;s {ACTION_LABELS[pendingAction]} — claiming{" "}
                  <span style={{ color: M.gold }}>
                    {ROLE_LABELS[pendingBlockRole]}
                  </span>
                  .
                </DisplayHeading>
              ) : pendingAction === "foreign_aid" ? (
                <DisplayHeading size={30}>
                  <span style={{ color: M.gold }}>
                    {currentTurnPlayer?.name ?? "Someone"}
                  </span>{" "}
                  takes Foreign Aid.
                </DisplayHeading>
              ) : ACTION_CLAIMED_ROLE[pendingAction] ? (
                <DisplayHeading size={30}>
                  <span style={{ color: M.gold }}>
                    {currentTurnPlayer?.name ?? "Someone"}
                  </span>{" "}
                  claims{" "}
                  <span style={{ color: M.gold }}>
                    {ROLE_LABELS[ACTION_CLAIMED_ROLE[pendingAction]!]}
                  </span>{" "}
                  to {ACTION_LABELS[pendingAction]}
                  {pendingActionTarget
                    ? ` ${TARGET_PREPOSITION[pendingAction] ?? "on"} ${pendingActionTarget.name}`
                    : ""}
                  .
                </DisplayHeading>
              ) : null}

              {/* Response buttons */}
              {iCanRespond ? (
                <div
                  style={{
                    display: "flex",
                    gap: 10,
                    flexWrap: "wrap",
                    justifyContent: "center",
                    marginTop: 10,
                  }}
                >
                  <Pill
                    disabled={actionPending}
                    onClick={() => void wrap(() => passChallenge(gameCode, playerId))}
                  >
                    Allow
                  </Pill>
                  {claimHasRole && (
                    <Pill
                      danger
                      disabled={actionPending}
                      onClick={() =>
                        requestConfirm("Challenge", () =>
                          submitChallenge(gameCode, playerId),
                        )
                      }
                    >
                      Challenge
                    </Pill>
                  )}
                  {myBlockRoles.map((role) => (
                    <Pill
                      key={role}
                      accent="gold"
                      disabled={actionPending}
                      onClick={() =>
                        requestConfirm(`Block · ${ROLE_LABELS[role]}`, () =>
                          submitBlock(gameCode, playerId, role),
                        )
                      }
                    >
                      Block · {ROLE_LABELS[role]}
                    </Pill>
                  ))}
                </div>
              ) : iAmClaimOwner ? (
                <SmallLabel>Waiting for opponents.</SmallLabel>
              ) : iAmEliminated ? (
                <SmallLabel>You&apos;re out.</SmallLabel>
              ) : iAlreadyPassed ? (
                <SmallLabel>Allowed. Waiting for others.</SmallLabel>
              ) : null}
            </>
          ) : iAmEliminated ? (
            <>
              <SmallLabel>Eliminated</SmallLabel>
              <DisplayHeading size={30}>You&apos;re out.</DisplayHeading>
            </>
          ) : isMyTurn ? (
            <ActionTray
              mustCoup={mustCoup}
              actionPending={actionPending}
              canCoup={canCoup}
              canAssassinate={canAssassinate}
              canStealFrom={canStealFrom}
              gameCode={gameCode}
              playerId={playerId}
              opponents={aliveOpponents}
              onAction={requestConfirm}
            />
          ) : (
            <>
              <SmallLabel>{currentTurnPlayer?.name ?? "Opponent"}&apos;s turn</SmallLabel>
              <DisplayHeading size={30}>
                Waiting.
              </DisplayHeading>
            </>
          )}
        </section>

        {/* My hand */}
        <section
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "flex-end",
            gap: 72,
          }}
        >
          <div style={{ display: "flex", gap: 18 }}>
            {(me?.influences ?? []).map((inf) => (
              <Card
                key={inf.id}
                role={inf.role}
                size="lg"
                dead={inf.isRevealed}
              />
            ))}
            {iAmEliminated && me && me.influences.length === 0 && (
              <Card back size="lg" dead />
            )}
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
              paddingBottom: 14,
            }}
          >
            <SmallLabel>{playerName || "—"}</SmallLabel>
            <CoinPill n={me?.coins ?? 0} />
          </div>
        </section>

        {/* Log */}
        {mergedLog.length > 0 && (
          <section
            style={{
              background: M.surface,
              border: `1px solid ${M.border}`,
              borderRadius: 18,
              padding: "18px 22px",
              maxHeight: 280,
              overflowY: "auto",
            }}
          >
            <SmallLabel style={{ marginBottom: 12 }}>Log</SmallLabel>
            <ol
              style={{
                margin: 0,
                padding: 0,
                listStyle: "none",
                display: "flex",
                flexDirection: "column",
                gap: 8,
                fontSize: 16,
                color: M.mutedHi,
                letterSpacing: "0.005em",
              }}
            >
              {mergedLog.map((entry, i) => (
                <li
                  key={entry.key}
                  style={{
                    color: i === mergedLog.length - 1 ? M.text : M.mutedHi,
                  }}
                >
                  {entry.message}
                </li>
              ))}
            </ol>
          </section>
        )}
        </div>

        {/* Right: chat */}
        <div
          style={{
            width: "clamp(220px, 22vw, 280px)",
            flexShrink: 0,
            height: "calc(100vh - 100px)",
            position: "sticky",
            top: 24,
          }}
        >
          <Chat gameCode={gameCode} playerId={playerId} playerName={playerName} />
        </div>
      </main>
    </Frame>
  );
}

// ─── Action tray (current player's turn, action phase) ──────────────────────

function ActionTray({
  mustCoup,
  actionPending,
  canCoup,
  canAssassinate,
  canStealFrom,
  gameCode,
  playerId,
  opponents,
  onAction,
}: {
  mustCoup: boolean;
  actionPending: boolean;
  canCoup: boolean;
  canAssassinate: boolean;
  canStealFrom: (p: { coins: number }) => boolean;
  gameCode: string;
  playerId: string;
  opponents: GamePlayer[];
  onAction: (label: string, fn: () => Promise<void>) => void;
}) {
  return (
    <>
      <SmallLabel color={M.gold}>Your turn</SmallLabel>
      <DisplayHeading size={30}>
        {mustCoup ? "Coup required." : "Choose an action."}
      </DisplayHeading>
      {mustCoup && (
        <p style={{ color: M.blood, fontSize: 15, margin: 0 }}>
          10 or more coins force a Coup.
        </p>
      )}

      {/* General (non-targeted) actions */}
      <div
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          justifyContent: "center",
          marginTop: 8,
        }}
      >
        <ActionPill
          label="Income"
          gain="+1"
          disabled={actionPending || mustCoup}
          onClick={() => onAction("Income (+1)", () => takeIncome(gameCode, playerId))}
        />
        <ActionPill
          label="Foreign Aid"
          gain="+2"
          disabled={actionPending || mustCoup}
          onClick={() => onAction("Foreign Aid (+2)", () => takeForeignAid(gameCode, playerId))}
        />
        <ActionPill
          label="Tax · Duke"
          gain="+3"
          disabled={actionPending || mustCoup}
          onClick={() => onAction("Tax (+3)", () => takeTax(gameCode, playerId))}
        />
        <ActionPill
          label="Exchange · Ambassador"
          disabled={actionPending || mustCoup}
          onClick={() => onAction("Exchange", () => takeExchange(gameCode, playerId))}
        />
      </div>

      {/* Per-opponent targeted actions */}
      {opponents.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            marginTop: 8,
            width: "100%",
            maxWidth: 600,
          }}
        >
          {opponents.map((target) => (
            <div
              key={target.playerId}
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                justifyContent: "center",
                alignItems: "center",
              }}
            >
              <span
                style={{
                  fontFamily: FONT_DISPLAY,
                  fontSize: 13,
                  letterSpacing: "0.22em",
                  color: M.muted,
                  textTransform: "uppercase",
                  minWidth: 60,
                  textAlign: "right",
                }}
              >
                vs {target.name}
              </span>
              <ActionPill
                label="Steal · Captain"
                gain="+2"
                disabled={actionPending || mustCoup || !canStealFrom(target)}
                onClick={() =>
                  onAction(`Steal from ${target.name}`, () =>
                    takeSteal(gameCode, playerId, target.playerId),
                  )
                }
              />
              <ActionPill
                label="Assassinate · Assassin"
                cost={3}
                disabled={actionPending || mustCoup || !canAssassinate}
                onClick={() =>
                  onAction(`Assassinate ${target.name}`, () =>
                    takeAssassinate(gameCode, playerId, target.playerId),
                  )
                }
                danger
              />
              <ActionPill
                label="Coup"
                cost={7}
                disabled={actionPending || !canCoup}
                onClick={() =>
                  onAction(`Coup ${target.name}`, () =>
                    performCoup(gameCode, playerId, target.playerId),
                  )
                }
                danger
              />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function ActionPill({
  label,
  cost,
  gain,
  disabled,
  onClick,
  danger,
}: {
  label: string;
  cost?: number;
  gain?: string;
  disabled?: boolean;
  onClick?: () => void;
  danger?: boolean;
}) {
  return (
    <Pill danger={danger} disabled={disabled} onClick={onClick}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span>{label}</span>
        {cost != null && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 14,
              opacity: 0.7,
            }}
          >
            <Coin size={12} /> {cost}
          </span>
        )}
        {gain && (
          <span style={{ fontSize: 14, color: M.muted }}>{gain}</span>
        )}
      </span>
    </Pill>
  );
}

// ─── Opponent block ─────────────────────────────────────────────────────────

function OpponentBlock({
  player: p,
  online,
  active,
  isPendingTarget,
  isBlocker,
}: {
  player: GamePlayer;
  online: boolean;
  active: boolean;
  isPendingTarget: boolean;
  isBlocker: boolean;
}) {
  const eliminated = p.influences.every((i) => i.isRevealed);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12,
        position: "relative",
        opacity: eliminated ? 0.4 : online ? 1 : 0.6,
        transition: "opacity 0.2s",
      }}
    >
      {active && !eliminated && (
        <div
          style={{
            position: "absolute",
            top: -18,
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: 11,
            letterSpacing: "0.32em",
            color: M.gold,
            textTransform: "uppercase",
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          Turn
        </div>
      )}
      {isBlocker && !eliminated && (
        <div
          style={{
            position: "absolute",
            top: -18,
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: 11,
            letterSpacing: "0.32em",
            color: M.gold,
            textTransform: "uppercase",
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          Blocking
        </div>
      )}
      {isPendingTarget && !eliminated && !active && !isBlocker && (
        <div
          style={{
            position: "absolute",
            top: -18,
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: 11,
            letterSpacing: "0.32em",
            color: M.blood,
            textTransform: "uppercase",
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          Target
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Avatar name={p.name} dim={!online || eliminated} />
        <div>
          <div
            style={{
              fontFamily: FONT_DISPLAY,
              fontSize: 18,
              letterSpacing: "0.18em",
              color: active ? M.gold : eliminated ? M.muted : M.text,
              textTransform: "uppercase",
            }}
          >
            {p.name}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginTop: 2,
              color: eliminated ? M.muted : M.mutedHi,
              fontSize: 18,
            }}
          >
            {eliminated ? (
              <span style={{ letterSpacing: "0.12em", textTransform: "uppercase", fontSize: 13 }}>
                Out
              </span>
            ) : !online ? (
              <span style={{ letterSpacing: "0.12em", textTransform: "uppercase", fontSize: 13 }}>
                Offline
              </span>
            ) : (
              <>
                <Coin size={14} /> {p.coins}
              </>
            )}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        {p.influences.map((inf) =>
          inf.isRevealed ? (
            <Card key={inf.id} role={inf.role} size="sm" dead />
          ) : (
            <Card key={inf.id} back size="sm" />
          ),
        )}
      </div>
    </div>
  );
}

// ─── Game over panel ────────────────────────────────────────────────────────

function GameOverPanel({
  winner,
  isMe,
  onQuit,
  onPlayAgain,
  nextGamePending,
}: {
  winner?: GamePlayer;
  isMe: boolean;
  onQuit: () => void;
  onPlayAgain: () => void;
  nextGamePending: boolean;
}) {
  return (
    <>
      <SmallLabel color={M.gold}>Winner</SmallLabel>
      <DisplayHeading size={56} style={{ fontWeight: 500, letterSpacing: "0.06em" }}>
        {isMe ? "You win." : (winner?.name?.toUpperCase() ?? "—")}
      </DisplayHeading>
      {winner && (
        <div style={{ display: "flex", gap: 14, marginTop: 4 }}>
          {winner.influences.map((inf) => (
            <Card
              key={inf.id}
              role={inf.role}
              size="lg"
              dead={inf.isRevealed}
              selected={!inf.isRevealed}
            />
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap", justifyContent: "center" }}>
        <Pill onClick={onQuit}>Quit</Pill>
        <Pill accent="gold" filled disabled={nextGamePending} onClick={onPlayAgain}>
          {nextGamePending ? "Starting…" : "Play again"}
        </Pill>
      </div>
    </>
  );
}

// ─── Confirm panel ──────────────────────────────────────────────────────────

function ConfirmPanel({
  label,
  pending,
  onConfirm,
  onBack,
}: {
  label: string;
  pending: boolean;
  onConfirm: () => void;
  onBack: () => void;
}) {
  return (
    <>
      <SmallLabel>Confirm</SmallLabel>
      <DisplayHeading size={34}>{label}</DisplayHeading>
      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
        <Pill onClick={onBack} disabled={pending}>
          Go back
        </Pill>
        <Pill accent="gold" filled disabled={pending} onClick={onConfirm}>
          {pending ? "…" : "Confirm"}
        </Pill>
      </div>
    </>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

