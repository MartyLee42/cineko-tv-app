// Pure helpers of the film-homage loading styles (loaders/Glass, Dig,
// Chocolates, Honey, GhostMeter, Scanner, Claw…): how strong the ripples
// are, how many chocolates are gone, when loading has stalled, where the
// needle points, how many bees fly. No React, no DOM: unit-tested.
import type { MessageKey } from "@martytv/ui";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** «Стакан воды»: ripple strength 0.15..1 — faint at first, stronger as the buffer fills (eased in). */
export function rippleStrength(p: number): number {
  const x = clamp01(p);
  return Math.round((0.15 + 0.85 * Math.pow(x, 1.4)) * 1000) / 1000;
}

/** How many ripple rings are visible: 1 at the start, 3 from ~2/3 on. */
export function rippleRings(p: number): number {
  return Math.min(3, 1 + Math.floor(clamp01(p) * 3));
}

/** «Коробка конфет»: the box holds this many; one goes every 1/12 (≈ 8 %). */
export const CHOCOLATES = 12;

/** Chocolates eaten at progress `p` (0..total; all of them at 100 %). */
export function chocolatesEaten(p: number, total = CHOCOLATES): number {
  return Math.min(total, Math.floor(clamp01(p) * total + 1e-6));
}

/**
 * Loading is "stalled" when progress grew less than `minStep` over the last
 * `ms` (the honey pot's «неправильные пчёлы», the claw's slip). Feed it every
 * render/tick; it never counts the finished load (p ≥ 1) as stalled.
 */
export class StallTracker {
  private base = -1;
  private since = 0;
  constructor(
    private readonly ms = 6000,
    private readonly minStep = 0.005,
  ) {}

  update(p: number, now: number): boolean {
    if (this.base < 0 || p - this.base >= this.minStep || p < this.base) {
      this.base = p;
      this.since = now;
    }
    return p < 1 && now - this.since >= this.ms;
  }
}

/** «Призракометр»: the needle's angle in degrees, from `from` (0 %) to `to` (100 %). */
export function needleAngle(p: number, from = -66, to = 66): number {
  return Math.round((from + (to - from) * clamp01(p)) * 10) / 10;
}

/** Lights lit on the meter's row of `n` (the first one is always on). */
export function meterLights(p: number, n = 8): number {
  return Math.max(1, Math.min(n, Math.ceil(clamp01(p) * n)));
}

/** «Горшочек мёда»: bees on screen for the torrent's peers — one per three, at least one when anyone is there, never more than `max`. */
export function beeCount(peers: number | null | undefined, max = 10): number {
  if (!peers || peers <= 0) return 0;
  return Math.max(1, Math.min(max, Math.ceil(peers / 3)));
}

/** «Сканер цели»: the runtime as «1 ч 52 мин» parts (null when unknown). */
export function runtimeLabel(minutes: number | null | undefined): { key: MessageKey; vars: Record<string, number> } | null {
  if (!minutes || minutes <= 0 || !isFinite(minutes)) return null;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (!h) return { key: "loaders2.time.m", vars: { m } };
  if (!m) return { key: "loaders2.time.h", vars: { h } };
  return { key: "loaders2.time.hm", vars: { h, m } };
}

/** A stable small hash (placeholder layouts, which fact goes in which chocolate). */
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Deterministic pseudo-random 0..1 sequence from a seed (star fields, toy piles). */
export function seeded(seed: number): () => number {
  let x = seed || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 100000) / 100000;
  };
}

/** One line in a chocolate: a fact as is, or a «Жанр: …» line to translate. */
export type FactLine = { text: string } | { key: MessageKey; v: string };

/** The bits of MediaDetail the fallback lines use. */
export interface FactSource {
  year?: number | null;
  genres?: { name: string }[];
  runtime?: number | null;
  countries?: string[];
  tagline?: string;
  crew?: { name: string; job: string }[];
  cast?: { name: string }[];
  rating?: number | null;
}

/**
 * What the chocolates say: the title's facts when they're already cached
 * (never fetched for this), else lines built from the cached Details.
 * Facts are capped in length (a chocolate is small).
 */
export function chocolateLines(facts: readonly string[] | null | undefined, d: FactSource | null | undefined, runtime: (min: number) => string | null): FactLine[] {
  const out: FactLine[] = [];
  for (const f of facts ?? []) {
    const s = f.trim();
    if (s) out.push({ text: s.length > 180 ? `${s.slice(0, 177).trimEnd()}…` : s });
  }
  if (out.length >= 4 || !d) return out;
  if (d.tagline?.trim()) out.push({ text: d.tagline.trim() });
  if (d.genres?.length) out.push({ key: "loaders2.fact.genres", v: d.genres.slice(0, 3).map((g) => g.name.toLowerCase()).join(", ") });
  if (d.year) out.push({ key: "loaders2.fact.year", v: String(d.year) });
  const dir = d.crew?.find((c) => c.job === "Director");
  if (dir) out.push({ key: "loaders2.fact.director", v: dir.name });
  const rt = d.runtime ? runtime(d.runtime) : null;
  if (rt) out.push({ key: "loaders2.fact.runtime", v: rt });
  if (d.cast?.length) out.push({ key: "loaders2.fact.cast", v: d.cast.slice(0, 3).map((c) => c.name).join(", ") });
  if (d.countries?.length) out.push({ key: "loaders2.fact.countries", v: d.countries.slice(0, 3).join(", ") });
  if (d.rating) out.push({ key: "loaders2.fact.rating", v: d.rating.toFixed(1) });
  return out;
}

/** The line inside the `k`-th chocolate (k from 1): spread over the list, starting at a seed-chosen one. */
export function lineFor<T>(lines: readonly T[], k: number, seed: string): T | null {
  if (!lines.length || k < 1) return null;
  return lines[(hashSeed(seed) + k - 1) % lines.length] ?? null;
}

/**
 * «Кран-машина»: where the claw is. 0–55 %: travels over the poster and
 * lowers; 55–90 %: grips and lifts; 90–100 %: carries it to the chute (x = 0)
 * and lets go at 100 %. `x` 0..1 (chute → poster), `drop` 0..1 (top → pile).
 */
export function clawPose(p: number): { x: number; drop: number; closed: boolean; holding: boolean; released: boolean } {
  const q = clamp01(p);
  if (q >= 1) return { x: 0, drop: 0.2, closed: false, holding: false, released: true };
  if (q < 0.25) return { x: q / 0.25, drop: 0, closed: false, holding: false, released: false };
  if (q < 0.55) return { x: 1, drop: (q - 0.25) / 0.3, closed: false, holding: false, released: false };
  if (q < 0.9) return { x: 1, drop: 1 - ((q - 0.55) / 0.35) * 0.8, closed: true, holding: true, released: false };
  return { x: 1 - (q - 0.9) / 0.1, drop: 0.2, closed: true, holding: true, released: false };
}
