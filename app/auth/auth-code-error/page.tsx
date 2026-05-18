import Link from "next/link";
import { Frame, Pill, Wordmark } from "@/components/ui";
import { M } from "@/lib/design";

export default function AuthCodeErrorPage() {
  return (
    <Frame>
      <header style={{ padding: "32px 48px" }}>
        <Wordmark size={24} />
      </header>
      <main
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 20,
          padding: 32,
          textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: 28, color: M.text, margin: 0 }}>
          Sign-in didn&apos;t complete
        </h1>
        <p style={{ color: M.muted, fontSize: 17, maxWidth: 420, margin: 0 }}>
          We couldn&apos;t finish authenticating you. The link may have expired
          or been used already. Try signing in again.
        </p>
        <Link href="/login" style={{ textDecoration: "none" }}>
          <Pill accent="gold" filled>
            Back to sign in
          </Pill>
        </Link>
      </main>
    </Frame>
  );
}
