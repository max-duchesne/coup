"use client";

import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

export type Player = {
  /** `auth.uid()` for the signed-in user, or "" while loading / not signed in. */
  id: string;
  /** Display name: profile username for signed-in users, else `user_metadata.full_name`. */
  name: string;
  /** True if the user signed in via `signInAnonymously()`. */
  isAnonymous: boolean;
  /** True until auth (and profile, for non-guests) finishes loading. */
  loading: boolean;
};

const INITIAL: Player = {
  id: "",
  name: "",
  isAnonymous: false,
  loading: true,
};

function metadataName(user: User): string {
  const meta = (user.user_metadata ?? {}) as {
    full_name?: string;
    name?: string;
  };
  return (
    meta.full_name ??
    meta.name ??
    user.email?.split("@")[0] ??
    (user.is_anonymous ? "Guest" : "Player")
  );
}

function userToPlayer(user: User, profileUsername?: string | null): Player {
  const isAnonymous = Boolean(user.is_anonymous);
  const name =
    (!isAnonymous && profileUsername) || metadataName(user);
  return {
    id: user.id,
    name,
    isAnonymous,
    loading: false,
  };
}

/**
 * Returns the currently signed-in player. Identity is `auth.uid()`; the name
 * is the profile `username` for authenticated users, or `user_metadata.full_name`
 * for guests (set during sign-in or via `setPlayerName`).
 *
 * Returns `{ id: "", name: "", loading: true }` during the initial auth
 * check (and profile fetch for non-guests). Once the proxy + Supabase confirm
 * the session, the hook updates with real values. Gate any presence-channel
 * work on `!player.loading && player.id !== ""`.
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

    async function resolve(user: User | null) {
      if (!user) {
        if (active) {
          setPlayer({ id: "", name: "", isAnonymous: false, loading: false });
        }
        return;
      }
      if (user.is_anonymous) {
        if (active) setPlayer(userToPlayer(user));
        return;
      }
      const { data } = await supabase
        .from("profiles")
        .select("username")
        .eq("id", user.id)
        .maybeSingle();
      if (active) setPlayer(userToPlayer(user, data?.username));
    }

    supabase.auth.getUser().then(({ data }) => {
      void resolve(data.user);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      void resolve(session?.user ?? null);
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
