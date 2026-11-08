import type { Schemas } from "@martytv/contracts";

// Admin → «Рекомендации»: learned source weights + quality metrics (pure helpers).

export type ForYouWeights = Schemas["ForYouWeights"];
export type ProfileWeights = Schemas["ForYouProfileWeights"];
export type SourceWeight = Schemas["ForYouSourceWeight"];
export type ForYouQuality = Schemas["ForYouQuality"];
export type QualityStats = Schemas["ForYouQualityStats"];
export type QualityWindow = ForYouQuality["window"];

export const QUALITY_WINDOWS: QualityWindow[] = ["30", "90", "all"];

/** Below this many ratings a mean is shown as «мало данных». */
export const MIN_SAMPLE = 5;

export function enough(n: number): boolean {
  return n >= MIN_SAMPLE;
}

/** 0.674 → "67 %" (null → "—"). */
export function pct(v: number | null | undefined, locale: string): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${Math.round(v * 100).toLocaleString(locale)} %`;
}

/** A share-weighted count: integers as is, fractions with one decimal. */
export function count(v: number, locale: string): string {
  return v.toLocaleString(locale, { maximumFractionDigits: Number.isInteger(v) ? 0 : 1 });
}

export function num(v: number | null | undefined, locale: string, digits = 1): string {
  return v == null ? "—" : v.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** up / down / same: the last nightly step of a weight. */
export function trend(w: SourceWeight): "up" | "down" | "same" {
  if (w.weight > w.prev_weight + 1e-9) return "up";
  if (w.weight < w.prev_weight - 1e-9) return "down";
  return "same";
}

export type FunnelStep = { key: "shown" | "played" | "finished" | "rated" | "liked"; n: number; share: number | null };

/** The funnel with each step's share of «shown». */
export function funnelSteps(f: QualityStats["funnel"]): FunnelStep[] {
  const keys: FunnelStep["key"][] = ["shown", "played", "finished", "rated", "liked"];
  return keys.map((key) => ({ key, n: f[key], share: f.shown > 0 ? f[key] / f.shown : null }));
}

export type SourceRow = {
  source: string;
  shown: number;
  opens: number;
  plays: number;
  weight: SourceWeight | null;
  avg: number | null;
  liked: number | null;
  rated: number;
};

/**
 * One table per profile: the learned weights (60-day counts) joined with the
 * quality report's per-source ratings, in the API's source order; sources
 * with neither are left out.
 */
export function sourceRows(order: string[], weights: SourceWeight[] | undefined, quality: QualityStats["sources"] | undefined): SourceRow[] {
  const ws = new Map((weights ?? []).map((w) => [w.source, w]));
  const qs = new Map((quality ?? []).map((q) => [q.source, q]));
  const keys = [...order, ...[...ws.keys(), ...qs.keys()].filter((k) => !order.includes(k))];
  const out: SourceRow[] = [];
  for (const k of new Set(keys)) {
    const w = ws.get(k);
    const q = qs.get(k);
    if (!w && !q) continue;
    out.push({
      source: k,
      shown: w ? w.impressions : (q?.shown ?? 0),
      opens: w?.opens ?? 0,
      plays: w ? w.plays : (q?.plays ?? 0),
      weight: w ?? null,
      avg: q?.avg ?? null,
      liked: q?.liked ?? null,
      rated: q?.rated ?? 0,
    });
  }
  return out;
}
