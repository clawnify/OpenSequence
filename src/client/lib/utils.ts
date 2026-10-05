import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Category colour families from DESIGN.md: tint (fill) / text / solid (dot, bar),
 *  generated at fixed lightness and chroma per role so every family reads equally
 *  vivid and every text-on-tint pair passes contrast. */
export const colorPalette = {
  c0: { bg: "bg-cat-0-tint", border: "border-cat-0-solid", text: "text-cat-0-text", ring: "ring-cat-0-solid", dot: "bg-cat-0-solid" },
  c1: { bg: "bg-cat-1-tint", border: "border-cat-1-solid", text: "text-cat-1-text", ring: "ring-cat-1-solid", dot: "bg-cat-1-solid" },
  c2: { bg: "bg-cat-2-tint", border: "border-cat-2-solid", text: "text-cat-2-text", ring: "ring-cat-2-solid", dot: "bg-cat-2-solid" },
  c3: { bg: "bg-cat-3-tint", border: "border-cat-3-solid", text: "text-cat-3-text", ring: "ring-cat-3-solid", dot: "bg-cat-3-solid" },
  c4: { bg: "bg-cat-4-tint", border: "border-cat-4-solid", text: "text-cat-4-text", ring: "ring-cat-4-solid", dot: "bg-cat-4-solid" },
  c5: { bg: "bg-cat-5-tint", border: "border-cat-5-solid", text: "text-cat-5-text", ring: "ring-cat-5-solid", dot: "bg-cat-5-solid" },
  c6: { bg: "bg-cat-6-tint", border: "border-cat-6-solid", text: "text-cat-6-text", ring: "ring-cat-6-solid", dot: "bg-cat-6-solid" },
  c7: { bg: "bg-cat-7-tint", border: "border-cat-7-solid", text: "text-cat-7-text", ring: "ring-cat-7-solid", dot: "bg-cat-7-solid" },
  c8: { bg: "bg-cat-8-tint", border: "border-cat-8-solid", text: "text-cat-8-text", ring: "ring-cat-8-solid", dot: "bg-cat-8-solid" },
  c9: { bg: "bg-cat-9-tint", border: "border-cat-9-solid", text: "text-cat-9-text", ring: "ring-cat-9-solid", dot: "bg-cat-9-solid" },
  /* Semantic states map to the status families, never to a category stop. */
  info:    { bg: "bg-info-tint", border: "border-info-solid", text: "text-info", ring: "ring-info-solid", dot: "bg-info-solid" },
  success: { bg: "bg-success-tint", border: "border-success-solid", text: "text-success", ring: "ring-success-solid", dot: "bg-success-solid" },
  warning: { bg: "bg-warning-tint", border: "border-warning-solid", text: "text-warning", ring: "ring-warning-solid", dot: "bg-warning-solid" },
  danger:  { bg: "bg-destructive-tint", border: "border-destructive-solid", text: "text-destructive", ring: "ring-destructive-solid", dot: "bg-destructive-solid" },
  slate: { bg: "bg-cat-neutral-tint", border: "border-cat-neutral-solid", text: "text-cat-neutral-text", ring: "ring-cat-neutral-solid", dot: "bg-cat-neutral-solid" },
} as const;

export type ColorToken = keyof typeof colorPalette;

export function colorClasses(token: string | null | undefined): typeof colorPalette[ColorToken] {
  return colorPalette[(token as ColorToken)] ?? colorPalette.c0;
}

const TOKENS = (Object.keys(colorPalette) as ColorToken[]).filter((k) => !["slate", "info", "success", "warning", "danger"].includes(k));

/** Deterministically map any string to a stable category color token (DESIGN-APPS
 *  signature #4: color = data). The same value always gets the same color. */
export function categoryToken(value: string): ColorToken {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  return TOKENS[Math.abs(hash) % TOKENS.length];
}

/** Category classes for a value (badge/pill/avatar surface). */
export function categoryClasses(value: string | null | undefined) {
  return colorClasses(value ? categoryToken(value) : "slate");
}

export function getInitials(firstName?: string | null, lastName?: string | null): string {
  return ((firstName?.[0] || "") + (lastName?.[0] || "")).toUpperCase() || "?";
}
