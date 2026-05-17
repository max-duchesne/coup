"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { usePlayer, setPlayerName } from "@/lib/player";

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

export default function Home() {
  const router = useRouter();
  const player = usePlayer();
  const [code, setCode] = useState("");

  const trimmedName = player.name.trim();
  const trimmedCode = code.trim().toUpperCase();
  const canCreate = trimmedName.length > 0;
  const canJoin = canCreate && trimmedCode.length > 0;

  return (
    <main style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h1>Coup</h1>

      <section style={{ marginTop: 16 }}>
        <label>
          Display name:{" "}
          <input
            type="text"
            value={player.name}
            onChange={(e) => setPlayerName(e.target.value)}
            placeholder="Enter your name"
            maxLength={24}
          />
        </label>
      </section>

      <section style={{ marginTop: 16, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={!canCreate}
          onClick={() => router.push(`/${generateGameCode()}`)}
        >
          Create Game
        </button>

        <span>or</span>

        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="GAME CODE"
          maxLength={8}
          style={{ textTransform: "uppercase" }}
        />
        <button
          type="button"
          disabled={!canJoin}
          onClick={() => router.push(`/${trimmedCode}`)}
        >
          Join Game
        </button>
      </section>
    </main>
  );
}
