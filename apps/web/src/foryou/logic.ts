// Pure helpers for the web Phase 6 pages: diary calendar layout, Taste DNA
// chart geometry, feedback batching and admin run progress.

// ---------------------------------------------------------------- diary calendar

export interface CalendarCell {
  /** YYYY-MM-DD, or null for padding before the 1st / after the last day. */
  date: string | null;
  day: number | null;
}

/** "2026-10" → its days in Monday-first weeks (UTC; padded with nulls to full weeks). */
export function calendarWeeks(month: string): CalendarCell[][] {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // Monday = 0
  const cells: CalendarCell[] = [];
  for (let i = 0; i < lead; i++) cells.push({ date: null, day: null });
  for (let d = 1; d <= days; d++) cells.push({ date: `${month}-${String(d).padStart(2, "0")}`, day: d });
  while (cells.length % 7) cells.push({ date: null, day: null });
  const weeks: CalendarCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** "2026-10" ± n months. */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function currentMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** A valid ?month= value, else null. */
export function parseMonth(s: string | null): string | null {
  return s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s) ? s : null;
}

// ---------------------------------------------------------------- taste charts

export interface Bar {
  x: number;
  y: number;
  w: number;
  h: number;
  value: number;
}

/** Vertical histogram bars (rating 1…10) inside width × height with a gap. */
export function histogramBars(values: readonly number[], width: number, height: number, gap = 4): Bar[] {
  const n = values.length;
  if (!n) return [];
  const max = Math.max(1, ...values);
  const w = (width - gap * (n - 1)) / n;
  return values.map((v, i) => {
    const h = v > 0 ? Math.max(2, (v / max) * height) : 0;
    return { x: i * (w + gap), y: height - h, w, h, value: v };
  });
}

/**
 * A diverging bar for a score −1…1 in a track `width` wide centred at 0:
 * left offset and width as percentages (positive grows right of centre).
 */
export function divergingBar(score: number): { left: number; width: number } {
  const s = Math.max(-1, Math.min(1, score));
  const half = Math.abs(s) * 50;
  return s >= 0 ? { left: 50, width: half } : { left: 50 - half, width: half };
}

/** Share of `part` in `total` as a 0…100 percentage (0 for an empty total). */
export function percent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

/** Splits affinities into liked (score > 0, best first) and disliked (score < 0, worst first). */
export function splitAffinities<A extends { score: number }>(items: readonly A[], max = 8): { likes: A[]; dislikes: A[] } {
  const likes = items.filter((a) => a.score > 0).sort((a, b) => b.score - a.score).slice(0, max);
  const dislikes = items.filter((a) => a.score < 0).sort((a, b) => a.score - b.score).slice(0, Math.max(3, Math.floor(max / 2)));
  return { likes, dislikes };
}

/** A Taste DNA theme (TMDB keyword); `localized` = `name` is in the UI's catalog language. */
export interface ThemeLike {
  id: number;
  name: string;
  localized: boolean;
  score: number;
  count: number;
}

/** Themes in the shape the affinity bars take. */
export function themeAffinities(items: readonly ThemeLike[]): { key: string; name: string; score: number; count: number }[] {
  return items.map((x) => ({ key: String(x.id), name: x.name, score: x.score, count: x.count }));
}

/**
 * The headline «Вам нравятся фильмы про …»: up to n clearly liked themes
 * with a name in the UI language; without any, the best one as-is
 * (`localized: false` → «Ваша тема: heist»). null when nothing is liked.
 */
export function likedThemes(items: readonly ThemeLike[], n = 3): { text: string; localized: boolean } | null {
  const liked = items.filter((x) => x.score >= 0.3).sort((a, b) => b.score - a.score);
  const named = liked.filter((x) => x.localized).slice(0, n);
  if (named.length) return { text: named.map((x) => x.name).join(", "), localized: true };
  return liked.length ? { text: liked[0]!.name, localized: false } : null;
}

/** SVG donut arc path for a fraction (0…1) of a circle, starting at 12 o'clock. */
export function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const f = Math.max(0, Math.min(1, from));
  const t = Math.max(f, Math.min(1, to));
  if (t - f >= 0.9999) {
    // A full circle can't be one arc: two halves.
    return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx} ${cy + r} A ${r} ${r} 0 1 1 ${cx} ${cy - r}`;
  }
  const pt = (x: number) => {
    const a = x * 2 * Math.PI - Math.PI / 2;
    return `${round(cx + r * Math.cos(a))} ${round(cy + r * Math.sin(a))}`;
  };
  const large = t - f > 0.5 ? 1 : 0;
  return `M ${pt(f)} A ${r} ${r} 0 ${large} 1 ${pt(t)}`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------- feedback batching

export type FeedbackAction = "impression" | "open" | "dismiss" | "undismiss" | "play" | "complete";

export interface FeedbackEvent {
  media_id: string;
  action: FeedbackAction;
  row_id?: string;
}

/**
 * Collects feedback events and flushes them in batches (≤ 100): impressions
 * are deduplicated per (media, row) for the queue's lifetime; other actions
 * always go out. `flush` returns the batch to send and empties the queue.
 */
export class FeedbackQueue {
  private pending: FeedbackEvent[] = [];
  private seen = new Set<string>();

  add(e: FeedbackEvent): boolean {
    if (e.action === "impression") {
      const k = `${e.media_id}|${e.row_id ?? ""}`;
      if (this.seen.has(k)) return false;
      this.seen.add(k);
    }
    this.pending.push(e);
    return true;
  }

  get size(): number {
    return this.pending.length;
  }

  flush(max = 100): FeedbackEvent[] {
    const out = this.pending.slice(0, max);
    this.pending = this.pending.slice(max);
    return out;
  }
}

// ---------------------------------------------------------------- admin runs

export interface RunLike {
  status: "running" | "completed" | "failed";
  profiles_total: number;
  profiles_done: number;
}

/** 0…1 progress of a run (completed runs are 1; failed ones show how far they got). */
export function runProgress(r: RunLike): number {
  if (r.status === "completed") return 1;
  return r.profiles_total > 0 ? Math.min(1, r.profiles_done / r.profiles_total) : 0;
}

export function anyRunning(runs: readonly RunLike[] | undefined): boolean {
  return !!runs?.some((r) => r.status === "running");
}
