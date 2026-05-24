"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { fetchGameState } from "@/lib/game";
import LobbyView from "./_lobby";
import GameView from "./_game";
import { Frame, Wordmark } from "@/components/ui";
import { M } from "@/lib/design";

type View = "loading" | "lobby" | "game";

export default function GameCodePage() {
  const params = useParams<{ game_code: string }>();
  const gameCode = (params?.game_code ?? "").toUpperCase();

  const [view, setView] = useState<View>("loading");

  useEffect(() => {
    if (!gameCode) return;

    // Determine initial view from DB state.
    // Fall back to lobby on any error so the page never gets stuck.
    void fetchGameState(gameCode)
      .then((state) => {
        setView(state ? "game" : "lobby");
      })
      .catch(() => {
        setView("lobby");
      });

    // Switch to game view when an in_progress game row is inserted.
    // Lobby settings upserts also fire INSERT events, so we check status.
    const channel = supabase
      .channel(`route:${gameCode}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "games",
          filter: `game_code=eq.${gameCode}`,
        },
        (payload) => {
          const row = payload.new as { status?: string } | null;
          if (row?.status === "in_progress") {
            setView("game");
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [gameCode]);

  if (view === "loading") {
    return (
      <Frame>
        <header
          style={{
            padding: "28px 48px",
            borderBottom: `1px solid ${M.border}`,
          }}
        >
          <Wordmark size={22} />
        </header>
        <main style={{ padding: 32, color: M.muted, fontSize: 17 }}>
          Connecting…
        </main>
      </Frame>
    );
  }

  if (view === "game") return <GameView />;
  return <LobbyView />;
}
