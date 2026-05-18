"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { fetchGameState } from "@/lib/game";
import LobbyView from "./_lobby";
import GameView from "./_game";

type View = "loading" | "lobby" | "game";

export default function GameCodePage() {
  const params = useParams<{ game_code: string }>();
  const gameCode = (params?.game_code ?? "").toUpperCase();

  const [view, setView] = useState<View>("loading");

  useEffect(() => {
    if (!gameCode) return;

    // Determine initial view from DB state.
    void fetchGameState(gameCode).then((state) => {
      setView(state ? "game" : "lobby");
    });

    // Switch to game view the moment a game row is inserted (host starts the game).
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
        () => {
          setView("game");
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [gameCode]);

  if (view === "loading") {
    return (
      <main style={{ padding: 24, fontFamily: "sans-serif" }}>Loading…</main>
    );
  }

  if (view === "game") return <GameView />;
  return <LobbyView />;
}
