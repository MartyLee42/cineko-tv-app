// «Сюрприз» (ProfileSettings.design_surprise): a different design each day or
// week, picked from the profile's favourites (design_favorites; empty = all).
// Pure and deterministic, so the TV and the PWA show the same design without a
// server round trip. Periods follow the device's local calendar: days start at
// local midnight, weeks on Monday (ISO). Within each run of n periods every
// candidate shows once (a seeded shuffle per run), and two periods in a row
// never repeat a design.
import { useEffect, useState } from "react";
import { DESIGNS, type DesignSetting } from "./designs";

export type SurpriseMode = "off" | "day" | "week";
export const SURPRISE_MODES: readonly SurpriseMode[] = ["off", "day", "week"];

export interface SurpriseSettings {
  design: DesignSetting;
  design_surprise?: string | null;
  design_favorites?: readonly string[] | null;
}

const DAY_MS = 86_400_000;

/** The local calendar day as a number (days since 1970-01-01, timezone-free). */
export function localDayIndex(now: Date): number {
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS);
}

/** The period `now` falls in: a local day, or an ISO week (Monday–Sunday). */
export function surprisePeriod(mode: "day" | "week", now: Date): number {
  const day = localDayIndex(now);
  // 1970-01-01 was a Thursday: +3 puts Mondays on multiples of 7.
  return mode === "day" ? day : Math.floor((day + 3) / 7);
}

/** The next local midnight (day) or Monday midnight (week) after `now`. */
export function nextSurpriseBoundary(mode: "day" | "week", now: Date): Date {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (mode === "week") while (next.getDay() !== 1) next.setDate(next.getDate() + 1);
  return next;
}

/** The designs a surprise picks from: valid favourites in picker order, or every design. */
export function surpriseCandidates(favorites: readonly string[] | null | undefined): DesignSetting[] {
  const fav = DESIGNS.filter((d) => favorites?.includes(d));
  return fav.length > 0 ? fav : DESIGNS.slice();
}

function hash(s: string): number {
  // FNV-1a, 32 bit.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function rng(seed: number): () => number {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], seed: string): T[] {
  const out = items.slice();
  const r = rng(hash(seed));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** The candidate shown in `period` (n ≥ 2): never the same as in period - 1. */
export function surprisePick(candidates: readonly DesignSetting[], profileId: string, period: number): DesignSetting {
  const n = candidates.length;
  if (n === 2) return candidates[mod(period + hash(profileId), 2)]!;
  const run = Math.floor(period / n);
  const order = shuffled(candidates, `${profileId}:${run}`);
  // Runs meet without a repeat: if this run would open with the previous run's
  // last design, swap its first two (n ≥ 3, so the last stays put).
  const prevLast = shuffled(candidates, `${profileId}:${run - 1}`)[n - 1];
  if (order[0] === prevLast) {
    order[0] = order[1]!;
    order[1] = prevLast!;
  }
  return order[mod(period, n)]!;
}

/** The design to show now: the chosen one, or today's / this week's surprise. */
export function effectiveDesign(s: SurpriseSettings, profileId: string | null | undefined, now: Date = new Date()): DesignSetting {
  const mode = s.design_surprise;
  if (mode !== "day" && mode !== "week") return s.design;
  const candidates = surpriseCandidates(s.design_favorites);
  if (candidates.length < 2) return s.design;
  return surprisePick(candidates, profileId ?? "", surprisePeriod(mode, now));
}

/**
 * The current surprise period, re-evaluated at the next boundary (a timer)
 * and whenever the app comes back to the foreground (a TV that slept through
 * midnight). Components pass it as a dependency so the design rolls over.
 */
export function useSurprisePeriod(mode: string | null | undefined): number {
  const m = mode === "day" || mode === "week" ? mode : null;
  const [period, setPeriod] = useState(() => (m ? surprisePeriod(m, new Date()) : 0));
  useEffect(() => {
    if (!m) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const now = new Date();
      setPeriod(surprisePeriod(m, now));
      clearTimeout(timer);
      // A second past the boundary (timers on sleeping TVs run late, never early enough to matter).
      timer = setTimeout(check, nextSurpriseBoundary(m, now).getTime() - now.getTime() + 1000);
    };
    check();
    const onVisible = () => {
      if (document.visibilityState !== "hidden") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [m]);
  return m ? period : 0;
}

/** effectiveDesign for components: re-renders when the day / week rolls over. */
export function useEffectiveDesign(s: SurpriseSettings | null | undefined, profileId: string | null | undefined): DesignSetting | null {
  const period = useSurprisePeriod(s?.design_surprise);
  if (!s) return null;
  void period;
  return effectiveDesign(s, profileId);
}
