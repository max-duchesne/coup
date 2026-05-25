"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { setPlayerName } from "@/lib/player";
import { initialsFor, useMyProfile } from "@/lib/profile";
import { FONT_DISPLAY, M } from "@/lib/design";
import { Pill, SmallLabel } from "@/components/ui";
import { signOut } from "@/app/login/actions";

/**
 * Header widget showing the current user's display name plus a sign-out
 * button. Authenticated (non-guest) users also get a circular avatar
 * linking to their profile page. Anonymous users keep the inline name
 * editor and Upgrade link.
 */
export function AuthHeader() {
  const [user, setUser] = useState<User | null>(null);
  const [loaded, setLoaded] = useState(false);
  const { profile } = useMyProfile();

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
  const isAnon = Boolean(user.is_anonymous);
  // Authenticated users prefer their profile username (matches what others see).
  const displayName =
    (!isAnon && profile?.username) ||
    meta.full_name ||
    meta.name ||
    user.email ||
    (isAnon ? "Guest" : "Player");

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
        ) : profile ? (
          <Link
            href={`/profile/${user.id}`}
            style={{
              color: M.text,
              fontSize: 14,
              textDecoration: "none",
            }}
          >
            {displayName}
          </Link>
        ) : (
          <span style={{ color: M.text, fontSize: 14 }}>{displayName}</span>
        )}
        {isAnon && (
          <SmallLabel style={{ fontSize: 10, letterSpacing: "0.2em", marginTop: 2 }}>
            Guest
          </SmallLabel>
        )}
      </div>
      {!isAnon && profile && (
        <Link
          href={`/profile/${user.id}`}
          aria-label="View your profile"
          style={{ textDecoration: "none", display: "inline-flex" }}
        >
          <InitialsAvatar name={profile.username} size={36} />
        </Link>
      )}
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
 * Circular avatar showing 1–2 character initials derived from a name
 * or username. Used for non-guest users in the header and on profile
 * pages.
 */
export function InitialsAvatar({
  name,
  size = 36,
}: {
  name: string;
  size?: number;
}) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: `radial-gradient(circle at 35% 30%, ${M.surface2}, ${M.bg})`,
        border: `1px solid ${M.borderHi}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: FONT_DISPLAY,
        color: M.gold,
        fontSize: Math.round(size * 0.38),
        letterSpacing: "0.04em",
        flexShrink: 0,
        cursor: "pointer",
      }}
    >
      {initialsFor(name)}
    </div>
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
