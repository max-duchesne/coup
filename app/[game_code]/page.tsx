"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { usePlayer } from "@/lib/player";

type PresencePayload = {
  id: string;
  name: string;
  online_at: string;
};

type ConnectionStatus =
  | "CONNECTING"
  | "SUBSCRIBED"
  | "CHANNEL_ERROR"
  | "TIMED_OUT"
  | "CLOSED";

export default function LobbyPage() {
  const params = useParams<{ game_code: string }>();
  const router = useRouter();
  const gameCode = (params?.game_code ?? "").toUpperCase();

  const player = usePlayer();
  const playerId = player.id;
  const playerName = player.name;

  const [status, setStatus] = useState<ConnectionStatus>("CONNECTING");
  const [players, setPlayers] = useState<PresencePayload[]>([]);

  useEffect(() => {
    if (!playerId) return;
    if (!playerName) {
      router.replace("/");
      return;
    }
    if (!gameCode) return;

    const channel: RealtimeChannel = supabase.channel(`lobby:${gameCode}`, {
      config: { presence: { key: playerId } },
    });

    const flushPresence = () => {
      const state = channel.presenceState<PresencePayload>();
      const merged: PresencePayload[] = [];
      for (const key of Object.keys(state)) {
        const entries = state[key];
        if (entries && entries.length > 0) {
          merged.push(entries[0]);
        }
      }
      merged.sort((a, b) => a.online_at.localeCompare(b.online_at));
      setPlayers(merged);
    };

    channel
      .on("presence", { event: "sync" }, flushPresence)
      .on("presence", { event: "join" }, flushPresence)
      .on("presence", { event: "leave" }, flushPresence);

    channel.subscribe(async (next) => {
      setStatus(next as ConnectionStatus);
      if (next === "SUBSCRIBED") {
        await channel.track({
          id: playerId,
          name: playerName,
          online_at: new Date().toISOString(),
        } satisfies PresencePayload);
      }
    });

    return () => {
      channel.untrack().catch(() => {});
      supabase.removeChannel(channel);
    };
  }, [gameCode, playerId, playerName, router]);

  const otherCount = useMemo(
    () => players.filter((p) => p.id !== playerId).length,
    [players, playerId],
  );

  if (!playerId) {
    return (
      <main style={{ padding: 24, fontFamily: "sans-serif" }}>Loading…</main>
    );
  }

  return (
    <main style={{ padding: 24, fontFamily: "sans-serif" }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
        <h1 style={{ margin: 0 }}>{gameCode} Lobby</h1>
        <span>
          status: <code>{status}</code>
        </span>
        <button type="button" onClick={() => router.push("/")}>
          Leave
        </button>
      </header>

      <p style={{ marginTop: 16 }}>
        You are <strong>{playerName}</strong> (id: <code>{playerId.slice(0, 8)}</code>)
      </p>

      <section style={{ marginTop: 16 }}>
        <h2 style={{ margin: "0 0 8px" }}>
          Players in lobby ({players.length}) — {otherCount} other
        </h2>
        {players.length === 0 ? (
          <p>(waiting for presence sync…)</p>
        ) : (
          <ul>
            {players.map((p) => (
              <li key={p.id}>
                {p.name}
                {p.id === playerId ? " (you)" : ""}{" "}
                <small style={{ color: "#666" }}>
                  joined {new Date(p.online_at).toLocaleTimeString()}
                </small>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
