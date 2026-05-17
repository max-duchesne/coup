"use client";

import { useSyncExternalStore } from "react";

const ID_KEY = "coup.playerId";
const NAME_KEY = "coup.playerName";

export type Player = { id: string; name: string };

const SERVER_SNAPSHOT: Player = { id: "", name: "" };

const listeners = new Set<() => void>();
let snapshot: Player = SERVER_SNAPSHOT;
let initialized = false;

function ensureInitialized() {
  if (initialized || typeof window === "undefined") return;
  let id = window.sessionStorage.getItem(ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.sessionStorage.setItem(ID_KEY, id);
  }
  const name = window.sessionStorage.getItem(NAME_KEY) ?? "";
  snapshot = { id, name };
  initialized = true;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): Player {
  ensureInitialized();
  return snapshot;
}

function getServerSnapshot(): Player {
  return SERVER_SNAPSHOT;
}

/**
 * Returns the per-tab player identity. Identity is generated on first read
 * and persisted in `sessionStorage` (so a tab refresh keeps the same id, but
 * each browser window/tab is a distinct player).
 *
 * During SSR / hydration, returns `{ id: "", name: "" }`. Gate any
 * presence-channel work on `player.id !== ""`.
 */
export function usePlayer(): Player {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function setPlayerName(name: string) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(NAME_KEY, name);
  ensureInitialized();
  snapshot = { ...snapshot, name };
  listeners.forEach((l) => l());
}
