"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { setPlayerName } from "@/lib/player";
import { Pill, SmallLabel } from "@/components/ui";
import { M } from "@/lib/design";
import { signOut } from "@/app/login/actions";

/**
 * Header widget showing the current user's display name plus a sign-out
 * button. Anonymous users get extra affordances: an inline name editor (so
 * they can rename without re-signing-in) and an "Upgrade" link to /login
 * where they can link a Google identity without losing their seat.
 */
export function AuthHeader() {
  const [user, setUser] = useState<User | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    let active = true;

    supabase.auth.getUser().then(({ data }) => {
      if (active) {
        setUser(data.user);
        setLoaded(true);
      }
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setLoaded(true);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  if (!loaded) {
    return <div style={{ width: 120, height: 32 }} aria-hidden />;
  }

  if (!user) {
    return (
      <Link href="/login" style={{ textDecoration: "none" }}>
        <Pill size="sm">Sign in</Pill>
      </Link>
    );
  }

  const meta = (user.user_metadata ?? {}) as { full_name?: string; name?: string };
  const displayName =
    meta.full_name ??
    meta.name ??
    user.email ??
    (user.is_anonymous ? "Guest" : "Player");
  const isAnon = Boolean(user.is_anonymous);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
        }}
      >
        {isAnon ? (
          <EditableName initialName={displayName} />
        ) : (
          <span style={{ color: M.text, fontSize: 14 }}>{displayName}</span>
        )}
        {isAnon && (
          <SmallLabel style={{ fontSize: 10, letterSpacing: "0.2em", marginTop: 2 }}>
            Guest
          </SmallLabel>
        )}
      </div>
      <form action={signOut}>
        <SignOutButton />
      </form>
    </div>
  );
}

function SignOutButton() {
  const { pending } = useFormStatus();
  return (
    <Pill type="submit" size="sm" disabled={pending}>
      {pending ? "Signing out…" : "Sign out"}
    </Pill>
  );
}

/**
 * Click-to-edit display name for anonymous users. Persists to
 * `user_metadata.full_name` via `setPlayerName` so other components
 * (lobby, chat, presence) see the new value via `usePlayer`.
 */
function EditableName({ initialName }: { initialName: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  async function commit() {
    const trimmed = value.trim();
    if (!trimmed) {
      setValue(initialName);
      setEditing(false);
      return;
    }
    if (trimmed === initialName) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await setPlayerName(trimmed);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save name");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <button
        onClick={() => { setValue(initialName); setEditing(true); }}
        title="Click to edit"
        style={{
          background: "none",
          border: "none",
          padding: 0,
          color: M.text,
          fontSize: 14,
          fontFamily: "inherit",
          cursor: "pointer",
          textDecoration: "underline dotted",
          textUnderlineOffset: 3,
          textDecorationColor: M.border,
        }}
      >
        {initialName}
      </button>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit();
          if (e.key === "Escape") {
            setValue(initialName);
            setEditing(false);
          }
        }}
        maxLength={24}
        disabled={saving}
        style={{
          background: M.surface,
          border: `1px solid ${M.border}`,
          borderRadius: 6,
          padding: "4px 8px",
          color: M.text,
          fontSize: 14,
          fontFamily: "inherit",
          outline: "none",
          width: 160,
          textAlign: "right",
        }}
      />
      {error && (
        <span style={{ color: M.blood, fontSize: 11 }}>{error}</span>
      )}
    </div>
  );
}
