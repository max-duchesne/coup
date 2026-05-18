import type { Role } from "@/lib/game";

/**
 * Design tokens. Mirrors the CSS variables in globals.css so components can
 * import a single object instead of sprinkling hex values everywhere.
 */
export const M = {
  bg: "#0e0d10",
  surface: "#16151a",
  surface2: "#1d1c22",
  border: "rgba(255, 255, 255, 0.07)",
  borderHi: "rgba(201, 162, 83, 0.45)",
  text: "#ebe6da",
  muted: "#7a7585",
  mutedHi: "#a09aaa",
  gold: "#c9a253",
  goldDim: "#7a6432",
  blood: "#c25555",
  good: "#7fb38a",
} as const;

export const FONT_DISPLAY = "var(--font-display)";
export const FONT_BODY = "var(--font-body)";

/** Single-character glyph used as the iconic representation of each role. */
export const ROLE_GLYPH: Record<Role, string> = {
  duke: "♛",
  assassin: "†",
  captain: "⚓",
  ambassador: "✦",
  contessa: "♕",
};
