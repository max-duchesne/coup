import { describe, it, expect, vi } from "vitest";

// game.ts imports @/lib/supabase at module load time; mock it so the pure
// functions (buildDeck, etc.) can be tested without a live Supabase client.
vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import { buildDeck, ALL_ROLES, DEFAULT_ROLE_COUNTS, type Role } from "../game";

describe("buildDeck", () => {
  it("default counts produce 15 cards (3 of each of 5 roles)", () => {
    const deck = buildDeck(DEFAULT_ROLE_COUNTS);
    expect(deck).toHaveLength(15);
  });

  it("each role appears exactly 3 times in the default deck", () => {
    const deck = buildDeck(DEFAULT_ROLE_COUNTS);
    for (const role of ALL_ROLES) {
      expect(deck.filter((r) => r === role)).toHaveLength(3);
    }
  });

  it("total card count equals sum of role_counts", () => {
    const counts: Record<Role, number> = {
      duke: 2,
      assassin: 4,
      captain: 1,
      ambassador: 3,
      contessa: 5,
    };
    const expected = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(buildDeck(counts)).toHaveLength(expected);
  });

  it("each role appears exactly the specified number of times", () => {
    const counts: Record<Role, number> = {
      duke: 2,
      assassin: 4,
      captain: 1,
      ambassador: 3,
      contessa: 5,
    };
    const deck = buildDeck(counts);
    for (const role of ALL_ROLES) {
      expect(deck.filter((r) => r === role)).toHaveLength(counts[role]);
    }
  });

  it("edge case: 1 of each role produces 5 cards", () => {
    const counts: Record<Role, number> = {
      duke: 1,
      assassin: 1,
      captain: 1,
      ambassador: 1,
      contessa: 1,
    };
    const deck = buildDeck(counts);
    expect(deck).toHaveLength(5);
    for (const role of ALL_ROLES) {
      expect(deck.filter((r) => r === role)).toHaveLength(1);
    }
  });

  it("edge case: unequal counts (5 dukes, 1 of everything else)", () => {
    const counts: Record<Role, number> = {
      duke: 5,
      assassin: 1,
      captain: 1,
      ambassador: 1,
      contessa: 1,
    };
    const deck = buildDeck(counts);
    expect(deck).toHaveLength(9);
    expect(deck.filter((r) => r === "duke")).toHaveLength(5);
    for (const role of ALL_ROLES.filter((r) => r !== "duke")) {
      expect(deck.filter((r) => r === role)).toHaveLength(1);
    }
  });

  it("deck order follows ALL_ROLES sequence before shuffling", () => {
    const deck = buildDeck(DEFAULT_ROLE_COUNTS);
    // Unshuffled deck: 3 dukes, then 3 assassins, then 3 captains, etc.
    expect(deck.slice(0, 3)).toEqual(["duke", "duke", "duke"]);
    expect(deck.slice(3, 6)).toEqual(["assassin", "assassin", "assassin"]);
    expect(deck.slice(6, 9)).toEqual(["captain", "captain", "captain"]);
    expect(deck.slice(9, 12)).toEqual(["ambassador", "ambassador", "ambassador"]);
    expect(deck.slice(12, 15)).toEqual(["contessa", "contessa", "contessa"]);
  });
});
