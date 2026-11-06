// Geometry for the Server tab's history charts (pure, tested).

export interface ChartPoint {
  /** 0..1 across the time window (left = oldest). */
  x: number;
  /** 0..1 from the top (1 = zero). */
  y: number;
  /** True when the line must not connect to the previous point (missing samples). */
  gap: boolean;
  t: number;
  v: number;
}

/** Samples further apart than this break the line. */
export const GAP_SECONDS = 25;

export function chartPoints(samples: { t: string; v: number }[], endMs: number, minutes: number, max: number): ChartPoint[] {
  const span = minutes * 60_000;
  const start = endMs - span;
  let prev = -Infinity;
  const out: ChartPoint[] = [];
  for (const s of samples) {
    const t = Date.parse(s.t);
    if (!Number.isFinite(t) || t < start) continue;
    const v = Math.max(0, s.v);
    out.push({
      x: Math.min(1, (t - start) / span),
      y: 1 - Math.min(1, max > 0 ? v / max : 0),
      gap: out.length > 0 && t - prev > GAP_SECONDS * 1000,
      t,
      v: s.v,
    });
    prev = t;
  }
  return out;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** SVG path in a width×height box; gaps start a new subpath. */
export function buildPath(points: ChartPoint[], width: number, height: number): string {
  return points.map((p, i) => `${i === 0 || p.gap ? "M" : "L"}${r1(p.x * width)},${r1(p.y * height)}`).join("");
}

/** Index of the point nearest to x (0..1), or -1. */
export function nearest(points: ChartPoint[], x: number): number {
  let best = -1;
  let dist = Infinity;
  points.forEach((p, i) => {
    const d = Math.abs(p.x - x);
    if (d < dist) {
      dist = d;
      best = i;
    }
  });
  return best;
}
