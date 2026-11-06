import { useSyncExternalStore } from "react";
import { MARTY_FAVICON } from "./marty";
import { EMBLEM_FAVICON } from "./emblem";
// Visual designs (ProfileSettings.design). Each design is a *skin* drawn on
// one of three layout *skeletons* — the original Кинозал / Терминал /
// Проектор layouts, whose focus, scroll and navigation code is shared:
//   kinozal   → rail skeleton (Кинозал)        terminal  → tab bar + ticker (Терминал)
//   projector → centred pill (Проектор)       wireframe → projector skeleton
//   cyberpunk → terminal skeleton             deco      → kinozal skeleton
//   retro80   → kinozal skeleton (VHS/arcade)  retro90   → terminal skeleton (Win95)
//   popart    → projector skeleton (comic)     constructivism → terminal skeleton (20s–30s poster)
//   matrix    → terminal skeleton (green digital rain)
// <html> gets `design-<id>` (tokens, skin CSS) and `skel-<skeleton>` (layout CSS).
export type DesignSetting = "kinozal" | "terminal" | "projector" | "wireframe" | "cyberpunk" | "deco" | "retro80" | "retro90" | "popart" | "constructivism" | "matrix";
export type Skeleton = "kinozal" | "terminal" | "projector";

/** All designs, in the order pickers show them (the contract's enum order). */
export const DESIGNS: DesignSetting[] = ["kinozal", "terminal", "projector", "wireframe", "cyberpunk", "deco", "retro80", "retro90", "popart", "constructivism", "matrix"];
export const SKELETONS: Skeleton[] = ["kinozal", "terminal", "projector"];

export const DESIGN_SKELETON: Record<DesignSetting, Skeleton> = {
  kinozal: "kinozal",
  terminal: "terminal",
  projector: "projector",
  wireframe: "projector",
  cyberpunk: "terminal",
  deco: "kinozal",
  retro80: "kinozal",
  retro90: "terminal",
  popart: "projector",
  constructivism: "terminal",
  matrix: "terminal",
};

/** The layout skeleton a design is drawn on (unknown values → Кинозал). */
export function designSkeleton(design: string): Skeleton {
  return DESIGN_SKELETON[design as DesignSetting] ?? "kinozal";
}

/** Only Кинозал has light colours; every other design is dark by design. */
export function designHasLight(design: DesignSetting): boolean {
  return design === "kinozal";
}

/** Swatch colours of each design (pickers draw them regardless of the current design). */
export const DESIGN_SWATCH: Record<DesignSetting, { bg: string; surface: string; accent: string; accent2: string; text: string }> = {
  kinozal: { bg: "#08090c", surface: "#1d1f20", accent: "#c8ff3d", accent2: "#c8ff3d", text: "#f2f4f8" },
  terminal: { bg: "#070708", surface: "#1a1a1c", accent: "#ff6b3d", accent2: "#ff6b3d", text: "#ecece8" },
  projector: { bg: "#05090b", surface: "#12262a", accent: "#5fd6c8", accent2: "#5fd6c8", text: "#f4f8f8" },
  wireframe: { bg: "#0d0420", surface: "#1e0f3d", accent: "#ff4fd8", accent2: "#3ce8ff", text: "#f6efff" },
  cyberpunk: { bg: "#06060a", surface: "#14141c", accent: "#f5f03c", accent2: "#ff2e88", text: "#eef6ff" },
  deco: { bg: "#0b0a08", surface: "#1a1712", accent: "#c9a54c", accent2: "#e8cf8a", text: "#f3ead6" },
  retro80: { bg: "#0b0e2a", surface: "#1a1f4a", accent: "#ff7a1a", accent2: "#16e0d0", text: "#fff4e6" },
  retro90: { bg: "#006e6e", surface: "#101870", accent: "#ffe85c", accent2: "#c0c0c0", text: "#ffffff" },
  popart: { bg: "#143a96", surface: "#0e2262", accent: "#ffd600", accent2: "#ff2d3c", text: "#ffffff" },
  constructivism: { bg: "#181412", surface: "#28221e", accent: "#d7261e", accent2: "#efe4cc", text: "#f3ead6" },
  matrix: { bg: "#000602", surface: "#04140a", accent: "#00ff41", accent2: "#c8ffd2", text: "#b4ffc4" },
};

/** Applies a visual design: html.design-<id>, html.skel-<skeleton> and the tab icon. */
export function applyDesign(design: DesignSetting): void {
  setAppliedDesign(design);
  const root = document.documentElement;
  const skel = designSkeleton(design);
  for (const d of DESIGNS) root.classList.toggle(`design-${d}`, d === design);
  for (const s of SKELETONS) root.classList.toggle(`skel-${s}`, s === skel);
  applyFavicon(design);
}

/** Points the page's SVG favicon (the browser tab icon) at the design's icon. */
function applyFavicon(design: DesignSetting): void {
  if (typeof document === "undefined" || !document.head) return;
  let link = document.head.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  // One icon for every design since the neon Cineko — except «Конструктивизм», which has no mascot at all.
  const svg = design === "constructivism";
  link.type = svg ? "image/svg+xml" : "image/png";
  link.href = svg ? EMBLEM_FAVICON : MARTY_FAVICON;
}

// ---------------------------------------------------------------- the applied design (a tiny store)

let applied: DesignSetting | null = null;
const listeners = new Set<() => void>();

/** Records the design `applyDesign` put on <html> (components that change per design read it). */
export function setAppliedDesign(design: DesignSetting | null): void {
  if (design === applied) return;
  applied = design;
  listeners.forEach((l) => l());
}

export function getAppliedDesign(): DesignSetting | null {
  return applied;
}

function subscribeApplied(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** The design applied to the page (null before the first `applyDesign`). Re-renders on change. */
export function useAppliedDesign(): DesignSetting | null {
  return useSyncExternalStore(subscribeApplied, getAppliedDesign, getAppliedDesign);
}

/** «Конструктивизм» is on: no mascot anywhere, the hammer-and-sickle emblem and slogans instead. */
export function useConstructivism(): boolean {
  return useAppliedDesign() === "constructivism";
}
