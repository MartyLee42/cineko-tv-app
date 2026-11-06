// The design layer: which design is applied (html.design-*), the layout
// skeleton it is drawn on (html.skel-*), the content frame each skeleton
// leaves to screens, and shell info (device).
import { createContext, useContext } from "react";
import type { Device } from "@martytv/contracts";
import { designSkeleton, useI18n, type DesignSetting, type MessageKey, type Skeleton } from "@martytv/ui";
import { pluralRu } from "./format";

/**
 * A layout skeleton (Кинозал rail / Терминал bar / Проектор pill). Screens
 * lay out by it; the later designs (Каркас, Киберпанк, Ар-деко) reuse one
 * and only change the skin (tokens, CSS, background and ornaments).
 */
export type Design = Skeleton;
/** A design as stored in the profile settings (skeleton + skin). */
export type DesignId = DesignSetting;

const DesignCtx = createContext<DesignId>("kinozal");
/** Provides the applied design id (skeleton and skin are derived from it). */
export const DesignProvider = DesignCtx.Provider;

/** The applied design's layout skeleton (what screens branch on). */
export function useDesign(): Design {
  return designSkeleton(useContext(DesignCtx));
}

/** The applied design itself: its skin (Каркас draws on Проектор's skeleton…). */
export function useSkin(): DesignId {
  return useContext(DesignCtx);
}

/**
 * Where a design's chrome leaves room for screens, in 1920×1080 canvas
 * coordinates: `box` is the focus container (spatial navigation geometry:
 * it must not overlap the menu/tab bar), `x` the text column, `top`/`bottom`
 * the usable band. Screens draw on a full-canvas stage, so backdrops can
 * still run under the chrome.
 */
export interface Frame {
  box: { left: number; top: number; width: number; height: number };
  x: number;
  top: number;
  bottom: number;
}

export const RAIL_W = 112;
const BAR_H = 132;
const TICKER_H = 44;

export const FRAMES: Record<Design, Frame> = {
  kinozal: { box: { left: RAIL_W, top: 0, width: 1920 - RAIL_W, height: 1080 }, x: 168, top: 24, bottom: 1080 },
  terminal: { box: { left: 0, top: BAR_H, width: 1920, height: 1080 - BAR_H - TICKER_H }, x: 96, top: BAR_H, bottom: 1080 - TICKER_H },
  projector: { box: { left: 0, top: BAR_H, width: 1920, height: 1080 - BAR_H }, x: 96, top: BAR_H, bottom: 1080 },
};

export function useFrame(): Frame {
  return FRAMES[useDesign()];
}

/** The paired TV (for the status corner / ticker). */
const DeviceCtx = createContext<Device | null>(null);
export const DeviceProvider = DeviceCtx.Provider;
export function useDevice(): Device | null {
  return useContext(DeviceCtx);
}

/** Counted label: `${base}.one|few|many` with {n} (Russian plural rules). */
export function usePlural() {
  const { t, locale } = useI18n();
  return (base: string, n: number) => {
    const form = locale === "ru" ? pluralRu(n) : n === 1 ? 0 : 2;
    return t(`${base}.${(["one", "few", "many"] as const)[form]}` as MessageKey, { n });
  };
}
