"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { M } from "@/lib/design";
import {
  FieldInput,
  Frame,
  Pill,
  SmallLabel,
  Wordmark,
} from "@/components/ui";
import {
  signInWithPassword,
  signUpWithPassword,
  type AuthFormState,
} from "./actions";

type Tab = "guest" | "google" | "email";
type EmailMode = "signin" | "signup";

export default function LoginView() {
  const [tab, setTab] = useState<Tab>("guest");

  return (
    <Frame>
      <header style={{ padding: "32px 48px" }}>
        <Wordmark size={24} />
      </header>
      <main
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        <div style={{ width: "100%", maxWidth: 460 }}>
          <h1
            style={{
              fontSize: 28,
              color: M.text,
              margin: 0,
              textAlign: "center",
            }}
          >
            Sign in to play
          </h1>
          <p
            style={{
              color: M.muted,
              fontSize: 16,
              textAlign: "center",
              marginTop: 8,
              marginBottom: 28,
            }}
          >
            Pick a guest name to play right away, or sign in to keep your
            identity across devices.
          </p>

          <TabBar tab={tab} onChange={setTab} />

          <div
            style={{
              marginTop: 24,
              padding: 24,
              border: `1px solid ${M.border}`,
              borderRadius: 16,
              background: M.surface,
            }}
          >
            {tab === "guest" && <GuestPanel />}
            {tab === "google" && <GooglePanel />}
            {tab === "email" && <EmailPanel onSwitchToGoogle={() => setTab("google")} />}
          </div>
        </div>
      </main>
    </Frame>
  );
}

// ─── Tabs ──────────────────────────────────────────────────────────────────

function TabBar({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "guest", label: "Guest" },
    { id: "google", label: "Google" },
    { id: "email", label: "Email" },
  ];
  return (
    <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
      {tabs.map((t) => {
        const active = t.id === tab;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            style={{
              padding: "9px 18px",
              borderRadius: 999,
              fontFamily: "inherit",
              fontSize: 14,
              letterSpacing: "0.04em",
              background: active ? M.surface2 : "transparent",
              color: active ? M.text : M.muted,
              border: `1px solid ${active ? M.borderHi : M.border}`,
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Guest ─────────────────────────────────────────────────────────────────

function GuestPanel() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function play() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a name to continue.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error: signInError } = await supabase.auth.signInAnonymously({
        options: { data: { full_name: trimmed } },
      });
      if (signInError) {
        setError(signInError.message);
        return;
      }
      router.push("/");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <SmallLabel style={{ marginBottom: 10 }}>Display name</SmallLabel>
        <FieldInput
          value={name}
          onChange={setName}
          placeholder="Enter your name"
          maxLength={24}
          style={{ width: "100%" }}
        />
      </div>
      {error && <ErrorText>{error}</ErrorText>}
      <Pill
        accent="gold"
        filled
        disabled={busy || name.trim().length === 0}
        onClick={play}
      >
        {busy ? "Starting…" : "Play as guest"}
      </Pill>
      <p style={{ color: M.muted, fontSize: 13, margin: 0, lineHeight: 1.5 }}>
        Guest accounts are tied to this browser. Sign in with Google or email
        later to keep your identity across devices.
      </p>
    </div>
  );
}

// ─── Google ────────────────────────────────────────────────────────────────

function GooglePanel() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (oauthError) {
        setError(oauthError.message);
        setBusy(false);
      }
      // On success the browser navigates to Google; nothing else to do here.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <p style={{ color: M.muted, fontSize: 15, margin: 0, lineHeight: 1.5 }}>
        Sign in with your Google account.
      </p>
      {error && <ErrorText>{error}</ErrorText>}
      <GoogleButton busy={busy} onClick={signIn} />
    </div>
  );
}

/**
 * Sign-in button that follows Google's branding guidelines (dark theme):
 * https://developers.google.com/identity/branding-guidelines
 *
 * - Dark background #131314, border #8E918F
 * - Standard-colour Google G logo on a white circle
 * - Roboto Medium / #E3E3E3 text
 */
function GoogleButton({
  busy,
  onClick,
}: {
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        width: "100%",
        padding: "10px 24px",
        borderRadius: 999,
        background: "#131314",
        border: "1px solid #8E918F",
        color: "#E3E3E3",
        fontSize: 15,
        fontFamily: "'Roboto', 'Helvetica Neue', sans-serif",
        fontWeight: 500,
        letterSpacing: "0.02em",
        cursor: busy ? "default" : "pointer",
        opacity: busy ? 0.6 : 1,
      }}
    >
      {/* Google G on white circle — Google branding requires white background */}
      <span
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 22,
          height: 22,
          borderRadius: "50%",
          background: "#fff",
          flexShrink: 0,
        }}
      >
        <GoogleGLogo size={16} />
      </span>
      {busy ? "Redirecting…" : "Sign in with Google"}
    </button>
  );
}

/** The standard-colour Google G SVG logo. Do not alter the fill colours. */
function GoogleGLogo({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

// ─── Email / Password ──────────────────────────────────────────────────────

function EmailPanel({ onSwitchToGoogle }: { onSwitchToGoogle: () => void }) {
  const [mode, setMode] = useState<EmailMode>("signin");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", gap: 16, fontSize: 14 }}>
        {(["signin", "signup"] as EmailMode[]).map((m) => {
          const active = m === mode;
          return (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 14,
                color: active ? M.text : M.muted,
                borderBottom: `2px solid ${active ? M.gold : "transparent"}`,
                paddingBottom: 4,
                letterSpacing: "0.04em",
              }}
            >
              {m === "signin" ? "Sign in" : "Sign up"}
            </button>
          );
        })}
      </div>
      {mode === "signin" ? (
        <EmailSignInForm onSwitchToGoogle={onSwitchToGoogle} />
      ) : (
        <EmailSignUpForm onSwitchToGoogle={onSwitchToGoogle} />
      )}
    </div>
  );
}

function EmailSignInForm({
  onSwitchToGoogle,
}: {
  onSwitchToGoogle: () => void;
}) {
  const [state, action, pending] = useActionState<AuthFormState, FormData>(
    signInWithPassword,
    null,
  );
  return (
    <form action={action} style={fieldsStyle}>
      <Field label="Email" name="email" type="email" autoComplete="email" />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
      />
      {state?.error && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <ErrorText>{state.error}</ErrorText>
          {state.suggestGoogle && (
            <GoogleSuggestion onSwitch={onSwitchToGoogle} />
          )}
        </div>
      )}
      <Pill type="submit" accent="gold" filled disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Pill>
    </form>
  );
}

function EmailSignUpForm({
  onSwitchToGoogle,
}: {
  onSwitchToGoogle: () => void;
}) {
  const [state, action, pending] = useActionState<AuthFormState, FormData>(
    signUpWithPassword,
    null,
  );
  const isSuccess = state?.error?.toLowerCase().includes("check your email");
  return (
    <form action={action} style={fieldsStyle}>
      <Field
        label="Display name"
        name="displayName"
        type="text"
        maxLength={24}
        autoComplete="nickname"
      />
      <Field label="Email" name="email" type="email" autoComplete="email" />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        helper="At least 8 characters."
      />
      {state?.error && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <p
            style={{
              color: isSuccess ? M.good : M.blood,
              fontSize: 14,
              margin: 0,
            }}
          >
            {state.error}
          </p>
          {state.suggestGoogle && (
            <GoogleSuggestion onSwitch={onSwitchToGoogle} />
          )}
        </div>
      )}
      <Pill type="submit" accent="gold" filled disabled={pending}>
        {pending ? "Creating account…" : "Create account"}
      </Pill>
    </form>
  );
}

/** Inline nudge that appears below an error when a Google account is suspected. */
function GoogleSuggestion({ onSwitch }: { onSwitch: () => void }) {
  return (
    <p style={{ color: M.muted, fontSize: 13, margin: 0 }}>
      Did you sign up with Google?{" "}
      <button
        type="button"
        onClick={onSwitch}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          color: M.gold,
          fontSize: 13,
          fontFamily: "inherit",
          cursor: "pointer",
          textDecoration: "underline",
        }}
      >
        Try the Google tab instead.
      </button>
    </p>
  );
}

// ─── Shared helpers ────────────────────────────────────────────────────────

const fieldsStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: 14,
};

function Field({
  label,
  name,
  type,
  autoComplete,
  maxLength,
  helper,
}: {
  label: string;
  name: string;
  type: string;
  autoComplete?: string;
  maxLength?: number;
  helper?: string;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <SmallLabel>{label}</SmallLabel>
      <input
        name={name}
        type={type}
        autoComplete={autoComplete}
        maxLength={maxLength}
        required
        className="coup-input"
        style={{
          background: M.bg,
          border: `1px solid ${M.border}`,
          borderRadius: 999,
          padding: "12px 22px",
          color: M.text,
          fontSize: 16,
          fontFamily: "inherit",
          outline: "none",
        }}
      />
      {helper && (
        <span style={{ color: M.muted, fontSize: 12 }}>{helper}</span>
      )}
    </label>
  );
}

function ErrorText({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ color: M.blood, fontSize: 14, margin: 0 }}>{children}</p>
  );
}
