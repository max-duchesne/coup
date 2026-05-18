"use client";

import type { CSSProperties, ReactNode } from "react";
import { ROLE_LABELS, type Role } from "@/lib/game";
import { FONT_DISPLAY, M, ROLE_GLYPH } from "@/lib/design";

// ─── Coin ──────────────────────────────────────────────────────────────────

export function Coin({ size = 14 }: { size?: number }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: size / 2,
        background: `radial-gradient(circle at 35% 30%, #e8c47a 0%, ${M.gold} 55%, #6b4f1a 100%)`,
        boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.4)",
        flexShrink: 0,
      }}
    />
  );
}

export function CoinPill({
  n,
  size = "md",
}: {
  n: number;
  size?: "sm" | "md";
}) {
  const small = size === "sm";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: small ? "5px 12px" : "7px 16px",
        borderRadius: 999,
        background: M.surface,
        border: `1px solid ${M.border}`,
        fontSize: small ? 15 : 18,
        color: M.text,
        letterSpacing: "0.02em",
        fontWeight: 500,
      }}
    >
      <Coin size={small ? 12 : 15} />
      {n}
    </span>
  );
}

// ─── Avatar ────────────────────────────────────────────────────────────────

export function Avatar({
  name,
  size = 36,
  dim = false,
}: {
  name: string;
  size?: number;
  dim?: boolean;
}) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: `radial-gradient(circle at 35% 30%, ${M.surface2}, ${M.bg})`,
        border: `1px solid ${M.border}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: FONT_DISPLAY,
        color: dim ? M.muted : M.text,
        fontSize: size * 0.36,
        letterSpacing: "0.02em",
        flexShrink: 0,
      }}
    >
      {(name[0] ?? "?").toUpperCase()}
    </div>
  );
}

// ─── Card ──────────────────────────────────────────────────────────────────

export type CardSize = "xs" | "sm" | "md" | "lg";

export function Card({
  role,
  back = false,
  dead = false,
  size = "md",
  selected = false,
  disabled = false,
  onClick,
}: {
  role?: Role;
  back?: boolean;
  dead?: boolean;
  size?: CardSize;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const dims = {
    xs: { w: 50, h: 72, r: 8 },
    sm: { w: 64, h: 92, r: 12 },
    md: { w: 110, h: 158, r: 12 },
    lg: { w: 142, h: 200, r: 14 },
  }[size];

  const showFace = !back && Boolean(role);
  const glyphSize =
    size === "lg" ? 80 : size === "md" ? 62 : size === "sm" ? 38 : 28;
  const nameSize =
    size === "lg" ? 14 : size === "md" ? 12 : size === "sm" ? 9 : 0;

  const baseStyle: CSSProperties = {
    width: dims.w,
    height: dims.h,
    borderRadius: dims.r,
    background: `linear-gradient(160deg, ${M.surface2} 0%, ${M.surface} 100%)`,
    border: `1px solid ${selected ? M.borderHi : M.border}`,
    boxShadow: selected
      ? `0 0 0 1px ${M.borderHi}, 0 12px 32px rgba(0,0,0,.45)`
      : "none",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: size === "lg" ? 14 : 8,
    position: "relative",
    opacity: dead ? 0.35 : disabled ? 0.5 : 1,
    cursor: onClick && !disabled && !dead ? "pointer" : "default",
  };

  const className = onClick && !disabled && !dead ? "coup-card-clickable" : "";

  if (!showFace) {
    return (
      <div style={baseStyle} onClick={onClick} className={className}>
        <div
          style={{
            width: dims.w * 0.45,
            height: dims.w * 0.45,
            borderRadius: "50%",
            border: `1px solid ${dead ? M.border : "rgba(201,162,83,0.18)"}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: FONT_DISPLAY,
            fontSize: size === "xs" ? 14 : 18,
            color: dead ? M.muted : "rgba(201,162,83,0.5)",
            letterSpacing: "0.05em",
          }}
        >
          C
        </div>
        {dead && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: dims.r,
              background: "rgba(14,13,16,0.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: FONT_DISPLAY,
              fontSize: size === "sm" ? 9 : 11,
              color: M.muted,
              letterSpacing: "0.18em",
            }}
          >
            LOST
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={baseStyle} onClick={onClick} className={className}>
      <div
        style={{
          fontFamily: FONT_DISPLAY,
          fontSize: glyphSize,
          color: M.gold,
          lineHeight: 1,
          textShadow: "0 2px 16px rgba(201,162,83,0.18)",
        }}
      >
        {ROLE_GLYPH[role!]}
      </div>
      {nameSize > 0 && (
        <div
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: nameSize,
            letterSpacing: "0.22em",
            color: M.text,
            textTransform: "uppercase",
          }}
        >
          {ROLE_LABELS[role!]}
        </div>
      )}
      {dead && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: dims.r,
            background: "rgba(14,13,16,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: FONT_DISPLAY,
            fontSize: 11,
            letterSpacing: "0.25em",
            color: M.muted,
          }}
        >
          LOST
        </div>
      )}
    </div>
  );
}

// ─── Pill ──────────────────────────────────────────────────────────────────

type PillProps = {
  children: ReactNode;
  accent?: "neutral" | "gold";
  filled?: boolean;
  danger?: boolean;
  size?: "sm" | "md";
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
  style?: CSSProperties;
};

export function Pill({
  children,
  accent = "neutral",
  filled = false,
  danger = false,
  size = "md",
  disabled = false,
  onClick,
  type = "button",
  style,
}: PillProps) {
  const pad = size === "sm" ? "7px 14px" : "10px 20px";
  const fs = size === "sm" ? 13 : 15;
  const accentColor = danger
    ? M.blood
    : accent === "gold"
      ? M.gold
      : M.text;
  const borderColor = filled
    ? accentColor
    : danger
      ? "rgba(194,85,85,0.35)"
      : accent === "gold"
        ? "rgba(201,162,83,0.35)"
        : M.border;

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`coup-pill${filled ? " coup-pill-filled" : ""}`}
      style={{
        padding: pad,
        borderRadius: 999,
        fontSize: fs,
        fontFamily: "inherit",
        fontWeight: 500,
        letterSpacing: "0.02em",
        background: filled ? accentColor : "transparent",
        color: filled ? M.bg : accentColor,
        border: `1px solid ${borderColor}`,
        opacity: disabled ? 0.4 : 1,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

// ─── Wordmark ──────────────────────────────────────────────────────────────

export function Wordmark({
  size = 22,
  sub,
}: {
  size?: number;
  sub?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
      <div
        style={{
          fontFamily: FONT_DISPLAY,
          fontWeight: 600,
          fontSize: size,
          letterSpacing: "0.42em",
          color: M.text,
        }}
      >
        COUP
      </div>
      {sub && (
        <div
          style={{
            fontSize: 10.5,
            letterSpacing: "0.3em",
            color: M.muted,
            textTransform: "uppercase",
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

// ─── Frame ─────────────────────────────────────────────────────────────────

export function Frame({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: M.bg,
        color: M.text,
        position: "relative",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ─── SmallLabel ────────────────────────────────────────────────────────────

export function SmallLabel({
  children,
  color,
  style,
}: {
  children: ReactNode;
  color?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        fontSize: 11,
        color: color ?? M.muted,
        letterSpacing: "0.32em",
        textTransform: "uppercase",
        fontWeight: 600,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ─── DisplayHeading ────────────────────────────────────────────────────────

export function DisplayHeading({
  children,
  size = 28,
  style,
}: {
  children: ReactNode;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        fontFamily: FONT_DISPLAY,
        fontSize: size,
        letterSpacing: "0.02em",
        lineHeight: 1.15,
        color: M.text,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ─── FieldInput ────────────────────────────────────────────────────────────

export function FieldInput({
  value,
  onChange,
  placeholder,
  maxLength,
  uppercase = false,
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  uppercase?: boolean;
  style?: CSSProperties;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      maxLength={maxLength}
      className="coup-input"
      style={{
        background: M.surface,
        border: `1px solid ${M.border}`,
        borderRadius: 999,
        padding: "10px 18px",
        color: M.text,
        fontSize: 13,
        fontFamily: "inherit",
        outline: "none",
        textTransform: uppercase ? "uppercase" : "none",
        letterSpacing: uppercase ? "0.18em" : "0.02em",
        ...style,
      }}
    />
  );
}
