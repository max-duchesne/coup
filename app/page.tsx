"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { usePlayer, setPlayerName } from "@/lib/player";
import { M } from "@/lib/design";
import {
  FieldInput,
  Frame,
  Pill,
  SmallLabel,
  Wordmark,
} from "@/components/ui";
import { AuthHeader } from "@/components/AuthHeader";

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
    <Frame>
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
        <header
          style={{
            padding: "32px 48px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <Wordmark size={24} />
          <AuthHeader />
        </header>

        <main
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <div style={{ width: "100%", maxWidth: 460 }}>
            <p
              style={{
                color: M.text,
                fontSize: 21,
                lineHeight: 1.5,
                textAlign: "center",
                margin: 0,
              }}
            >
              An online alternative to the card game Coup.
            </p>

            <section
              style={{
                marginTop: 36,
                display: "flex",
                flexDirection: "column",
                gap: 18,
                textAlign: "left",
              }}
            >
              <div>
                <SmallLabel style={{ marginBottom: 10 }}>Your name</SmallLabel>
                <FieldInput
                  value={player.name}
                  onChange={setPlayerName}
                  placeholder="Enter your name"
                  maxLength={24}
                  style={{ width: "100%" }}
                />
              </div>

              <div style={{ display: "flex", justifyContent: "center", marginTop: 4 }}>
                <Pill
                  accent="gold"
                  filled
                  disabled={!canCreate}
                  onClick={() => router.push(`/${generateGameCode()}`)}
                >
                  Create game
                </Pill>
              </div>

              <div
                style={{
                  marginTop: 24,
                  paddingTop: 24,
                  borderTop: `1px solid ${M.border}`,
                }}
              >
                <SmallLabel style={{ marginBottom: 10 }}>
                  Join an existing game
                </SmallLabel>
                <div style={{ display: "flex", gap: 10 }}>
                  <FieldInput
                    value={code}
                    onChange={setCode}
                    placeholder="GAME CODE"
                    maxLength={8}
                    uppercase
                    style={{ flex: 1, minWidth: 0 }}
                  />
                  <Pill
                    disabled={!canJoin}
                    onClick={() => router.push(`/${trimmedCode}`)}
                  >
                    Join
                  </Pill>
                </div>
              </div>
            </section>
          </div>
        </main>
      </div>
    </Frame>
  );
}
