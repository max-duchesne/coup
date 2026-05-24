"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/chat";
import { useMobile } from "@/lib/hooks";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { usePlayer } from "@/lib/player";
import {
  ACTION_CLAIMED_ROLE,
  eligibleBlockRoles,
  fetchGameLog,
  fetchGameState,
  isAlive,
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
  const playerLoading = player.loading;

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
  // sessionKey tracks which exchange we're in so stale selections from a previous
  // exchange (or from before a card was lost) don't carry over.
  const [exchangeState, setExchangeState] = useState<{
    sessionKey: string | null;
    selection: Set<string>;
  }>({ sessionKey: null, selection: new Set() });

  const isMobile = useMobile(960);
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

  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoLoseInfluenceRef = useRef(false);

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

  // Derived exchange selection — computed without setState-in-effect.
  // Uses a session key (the drawn card array) to detect new exchanges and
  // auto-select only live cards when the session changes.
  const activeExchangeSelection = (() => {
    if (gameState?.turnPhase !== "ambassador_exchange") return new Set<string>();
    const sessionKey = JSON.stringify(gameState.pendingAmbassadorDraw);
    const liveKeys = new Set(
      (gameState.players.find((p) => p.playerId === playerId)?.influences ?? [])
        .filter((i) => !i.isRevealed)
        .map((i) => `held-${i.id}`),
    );
    if (exchangeState.sessionKey !== sessionKey) return liveKeys;
    // Filter out any stale keys that are no longer in the pool.
    const poolKeySet = new Set([
      ...liveKeys,
      ...(gameState.pendingAmbassadorDraw ?? []).map((_, idx) => `drawn-${idx}`),
    ]);
    return new Set([...exchangeState.selection].filter((k) => poolKeySet.has(k)));
  })();

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

  // Last influence is automatic — no choice when only one card remains.
  useEffect(() => {
    if (!gameState || !playerId || !gameCode) return;

    const { turnPhase, pendingTargetId } = gameState;
    if (turnPhase !== "lose_influence" || pendingTargetId !== playerId) {
      autoLoseInfluenceRef.current = false;
      return;
    }

    const me = gameState.players.find((p) => p.playerId === playerId);
    const live = (me?.influences ?? []).filter((i) => !i.isRevealed);
    if (live.length !== 1 || autoLoseInfluenceRef.current || actionPending) return;

    autoLoseInfluenceRef.current = true;
    const influenceId = live[0].id;

    void (async () => {
      setActionPending(true);
      try {
        await loseInfluence(gameCode, playerId, influenceId);
      } catch (err) {
        autoLoseInfluenceRef.current = false;
        showError(err instanceof Error ? err.message : "Action failed");
      } finally {
        setActionPending(false);
      }
    })();
  }, [gameState, playerId, gameCode, actionPending]);

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

  const toggleExchangeCard = (
    key: string,
    limit: number,
    currentSessionKey: string,
    defaultSelection: Set<string>,
  ) => {
    setExchangeState((prev) => {
      const base =
        prev.sessionKey === currentSessionKey ? prev.selection : defaultSelection;
      const next = new Set(base);
      if (next.has(key)) next.delete(key);
      else if (next.size < limit) next.add(key);
      return { sessionKey: currentSessionKey, selection: next };
    });
  };

  // ── Early returns ─────────────────────────────────────────────────────────

  if (playerLoading || !playerId) {
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
  const iAmEliminated = me ? !isAlive(me, gameState.cardsPerPlayer) : false;
  const aliveOpponents = opponents.filter((p) =>
    isAlive(p, gameState.cardsPerPlayer),
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
  const exchangeSessionKey = JSON.stringify(pendingAmbassadorDraw);
  const exchangeDefaultSelection = new Set(
    myLiveInfluences.map((i) => `held-${i.id}`),
  );

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
          padding: isMobile ? "16px 12px 96px" : "32px 24px 48px",
          display: "flex",
          flexDirection: isMobile ? "column" : "row",
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
              gap: isMobile ? 20 : 48,
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
                cardsPerPlayer={gameState.cardsPerPlayer}
              />
            ))}
          </section>
        )}

        {/* Spotlight: contextual content based on phase */}
        <section
          style={{
            minHeight: isMobile ? 160 : 280,
            padding: isMobile ? "20px 16px" : "36px 28px",
            background: M.surface,
            border: `1px solid ${M.border}`,
            borderRadius: 18,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: isMobile ? 14 : 22,
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
          ) : iMustLoseInfluence && myLiveInfluences.length > 1 ? (
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
          ) : iMustLoseInfluence ? (
            <>
              <SmallLabel color={M.blood}>Lose an influence</SmallLabel>
              <DisplayHeading size={32}>
                {actionPending
                  ? "Revealing your last card…"
                  : "Revealing your last card."}
              </DisplayHeading>
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
                              toggleExchangeCard(
                                card.key,
                                myLiveInfluences.length,
                                exchangeSessionKey,
                                exchangeDefaultSelection,
                              )
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
                          submitChallenge(gameCode),
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
            gap: isMobile ? 16 : 32,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", gap: isMobile ? 10 : 18, flexWrap: "wrap", justifyContent: "center" }}>
            {(me?.influences ?? []).map((inf) => (
              <Card
                key={inf.id}
                role={inf.role}
                size={isMobile ? "md" : "lg"}
                dead={inf.isRevealed}
              />
            ))}
            {iAmEliminated && me && me.influences.length === 0 && (
              <Card back size={isMobile ? "md" : "lg"} dead />
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

        {/* Log — mobile only (desktop log lives in the right sidebar) */}
        {isMobile && mergedLog.length > 0 && (
          <section
            style={{
              background: M.surface,
              border: `1px solid ${M.border}`,
              borderRadius: 18,
              padding: "14px 18px",
              maxHeight: 140,
              overflowY: "auto",
            }}
          >
            <SmallLabel style={{ marginBottom: 8 }}>Log</SmallLabel>
            <ol
              style={{
                margin: 0,
                padding: 0,
                listStyle: "none",
                display: "flex",
                flexDirection: "column",
                gap: 6,
                fontSize: 14,
                color: M.mutedHi,
              }}
            >
              {mergedLog.slice(-6).map((entry, i, arr) => (
                <li
                  key={entry.key}
                  style={{ color: i === arr.length - 1 ? M.text : M.mutedHi }}
                >
                  {entry.message}
                </li>
              ))}
            </ol>
          </section>
        )}
        </div>

        {/* Right sidebar: log + chat (desktop only) */}
        {!isMobile && (
          <div
            style={{
              width: "clamp(260px, 24vw, 340px)",
              flexShrink: 0,
              height: "calc(100vh - 100px)",
              position: "sticky",
              top: 24,
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            {mergedLog.length > 0 && (
              <section
                style={{
                  flexShrink: 0,
                  maxHeight: 300,
                  overflowY: "auto",
                  background: M.surface,
                  border: `1px solid ${M.border}`,
                  borderRadius: 18,
                  padding: "18px 22px",
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
                      style={{ color: i === mergedLog.length - 1 ? M.text : M.mutedHi }}
                    >
                      {entry.message}
                    </li>
                  ))}
                </ol>
              </section>
            )}
            <div style={{ flex: 1, minHeight: 0 }}>
              <Chat
                gameCode={gameCode}
                playerId={playerId}
                playerName={playerName}
                onNewMessage={handleNewChatMessage}
              />
            </div>
          </div>
        )}

        {/* Mobile: floating chat button + slide-in overlay + toast */}
        {isMobile && (
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

            {/* Always mounted so subscription stays active */}
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
          width: "100%",
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
  cardsPerPlayer,
}: {
  player: GamePlayer;
  online: boolean;
  active: boolean;
  isPendingTarget: boolean;
  isBlocker: boolean;
  cardsPerPlayer: number;
}) {
  const eliminated = !isAlive(p, cardsPerPlayer);

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
                Disconnected
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

