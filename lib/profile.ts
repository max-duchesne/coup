"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@/lib/database.types";

export type Profile = Tables<"profiles">;

export type PlayerStats = {
  total_games: number;
  total_wins: number;
  total_games_30d: number;
  total_wins_30d: number;
  win_pct: number;
  win_pct_30d: number;
};

export type GameLogEntry = {
  game_code: string;
  finished_at: string | null;
  finish_position: number;
  total_players: number;
};

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

export function isValidUsername(s: string): boolean {
  return USERNAME_RE.test(s);
}

export function initialsFor(name: string): string {
  const cleaned = (name ?? "").trim();
  if (!cleaned) return "?";
  const parts = cleaned.split(/[\s_]+/).filter(Boolean);
  if (parts.length === 1) {
    return parts[0]!.slice(0, 2).toUpperCase();
  }
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export async function getProfileById(id: string): Promise<Profile | null> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getProfileByUsername(
  username: string,
): Promise<Profile | null> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .ilike("username", username)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function updateUsername(
  id: string,
  newUsername: string,
): Promise<void> {
  if (!isValidUsername(newUsername)) {
    throw new Error("Username must be 3–20 letters, digits or underscores.");
  }
  const supabase = createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ username: newUsername })
    .eq("id", id);
  if (error) {
    // Postgres unique-violation surfaces as 23505.
    if (
      (error as { code?: string }).code === "23505" ||
      /duplicate/i.test(error.message)
    ) {
      throw new Error("That username is already taken.");
    }
    throw error;
  }
}

export async function getPlayerStats(id: string): Promise<PlayerStats> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("get_player_stats", {
    p_player_id: id,
  });
  if (error) throw error;
  const row = data?.[0];
  return (
    row ?? {
      total_games: 0,
      total_wins: 0,
      total_games_30d: 0,
      total_wins_30d: 0,
      win_pct: 0,
      win_pct_30d: 0,
    }
  );
}

export async function getPlayerGameLog(
  id: string,
  limit = 20,
): Promise<GameLogEntry[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("get_player_game_log", {
    pid: id,
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []) as GameLogEntry[];
}

/**
 * Loads the signed-in user's profile (if they have one — guests don't).
 * Returns `{ profile: null, loading: false }` for anonymous / signed-out
 * users so callers can render a guest-style header.
 */
export function useMyProfile(): {
  profile: Profile | null;
  loading: boolean;
} {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    let active = true;

    async function load(userId: string | null) {
      if (!userId) {
        if (active) {
          setProfile(null);
          setLoading(false);
        }
        return;
      }
      const { data } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .maybeSingle();
      if (active) {
        setProfile(data ?? null);
        setLoading(false);
      }
    }

    supabase.auth.getUser().then(({ data }) => {
      const u = data.user;
      if (!u || u.is_anonymous) {
        if (active) {
          setProfile(null);
          setLoading(false);
        }
        return;
      }
      void load(u.id);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      const u = session?.user;
      if (!u || u.is_anonymous) {
        setProfile(null);
        setLoading(false);
        return;
      }
      void load(u.id);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return { profile, loading };
}
