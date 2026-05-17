"use client";

import { useEffect } from "react";
import { supabase } from "@/lib/supabase";

export default function LobbyPage({
  params,
}: {
  params: { game_code: string };
}) {
  const { game_code } = params;

  useEffect(() => {
    const channel = supabase.channel(`lobby:${game_code}`, {
      config: { presence: { key: game_code } },
    });

    channel
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState();
        console.log("presence sync", state);
      })
      .on("presence", { event: "join" }, ({ key, newPresences }) => {
        console.log("presence join", key, newPresences);
      })
      .on("presence", { event: "leave" }, ({ key, leftPresences }) => {
        console.log("presence leave", key, leftPresences);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({ online_at: new Date().toISOString() });
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [game_code]);

  return (
    <div>
      <p>{game_code} Lobby</p>
    </div>
  );
}
