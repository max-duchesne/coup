"use client";

import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

export type Player = {
  /** `auth.uid()` for the signed-in user, or "" while loading / not signed in. */
  id: string;
  /** Display name resolved from `user_metadata.full_name` with fallbacks. */
  name: string;
  /** True if the user signed in via `signInAnonymously()`. */
  isAnonymous: boolean;
  /** True until the initial auth check completes. */
  loading: boolean;
};

const INITIAL: Player = {
  id: "",
  name: "",
  isAnonymous: false,
  loading: true,
};

function userToPlayer(user: User | null): Player {
  if (!user) {
    return { id: "", name: "", isAnonymous: false, loading: false };
  }
  const meta = (user.user_metadata ?? {}) as {
    full_name?: string;
    name?: string;
  };
  const name =
    meta.full_name ??
    meta.name ??
    user.email?.split("@")[0] ??
    (user.is_anonymous ? "Guest" : "Player");
  return {
    id: user.id,
    name,
    isAnonymous: Boolean(user.is_anonymous),
    loading: false,
  };
}

/**
 * Returns the currently signed-in player. Identity is `auth.uid()`; the name
 * is read from `user_metadata.full_name` (set during sign-up for Google,
 * email, and guest flows).
 *
 * Returns `{ id: "", name: "", loading: true }` during the initial auth
 * check. Once the proxy + Supabase confirm the session, the hook updates
 * with real values. Gate any presence-channel work on `!player.loading &&
 * player.id !== ""`.
 *
 * The route proxy redirects unauthenticated requests to `/login`, so any
 * page that calls this hook can assume a session will be available by the
 * time `loading` flips to false (unless something goes wrong, in which case
 * `id` will be "").
 */
export function usePlayer(): Player {
  const [player, setPlayer] = useState<Player>(INITIAL);

  useEffect(() => {
    const supabase = createClient();
    let active = true;

    supabase.auth.getUser().then(({ data }) => {
      if (active) setPlayer(userToPlayer(data.user));
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setPlayer(userToPlayer(session?.user ?? null));
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return player;
}

/**
 * Updates the signed-in user's display name. Persists to `user_metadata`
 * so it survives across devices and sessions. The `onAuthStateChange`
 * subscription in `usePlayer` will pick up the change automatically.
 */
export async function setPlayerName(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const supabase = createClient();
  const { error } = await supabase.auth.updateUser({
    data: { full_name: trimmed },
  });
  if (error) throw error;
}
