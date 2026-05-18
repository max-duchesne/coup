"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { Pill, SmallLabel } from "@/components/ui";
import { M } from "@/lib/design";
import { signOut } from "@/app/login/actions";

/**
 * Tiny header widget that shows either a "Sign in" link or, if the visitor
 * has a session, their display name plus a "Sign out" button. Reflects auth
 * changes live via `onAuthStateChange`.
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

  const displayName =
    (user.user_metadata?.full_name as string | undefined) ??
    user.email ??
    (user.is_anonymous ? "Guest" : "Player");
  const isAnon = Boolean(user.is_anonymous);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
        <span style={{ color: M.text, fontSize: 14 }}>{displayName}</span>
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
