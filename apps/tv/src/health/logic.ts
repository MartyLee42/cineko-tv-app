// TV health («Состояние»), pure part: turning raw timings into the reported
// numbers, the schedule and the reporting gate. The browser glue lives in
// sampler.ts / agent.ts (they touch the DOM and the API).

/** First report this long after start. */
export const FIRST_REPORT_MS = 2 * 60_000;
/** Then every … */
export const REPORT_EVERY_MS = 10 * 60_000;
/** The server accepts one sample per TV per minute. */
export const MIN_GAP_MS = 61_000;
/** Measuring window (rAF + timer drift). */
export const SAMPLE_MS = 3000;
/** A frame longer than this counts as slow. */
export const SLOW_FRAME_MS = 50;
/** Timer tick for the event-loop lag probe. */
export const LAG_TICK_MS = 100;
/** localStorage key of the on/off switch («Отправлять состояние ТВ»). */
export const HEALTH_PREF_KEY = "martytv.health_report";

/** The switch is on unless explicitly turned off ("0"). */
export function healthEnabled(raw: string | null | undefined): boolean {
  return raw !== "0";
}

export type GateResult = "ok" | "off" | "hidden" | "too_soon";

/** Whether a report may be sampled and posted now. Off wins: no sampling, no posts. */
export function healthGate(s: { enabled: boolean; hidden: boolean; now: number; lastPostAt: number | null }): GateResult {
  if (!s.enabled) return "off";
  if (s.hidden) return "hidden";
  if (s.lastPostAt !== null && s.now - s.lastPostAt < MIN_GAP_MS) return "too_soon";
  return "ok";
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

/** Median fps and share of slow frames from rAF timestamps (ms). */
export function frameStats(stamps: number[]): { fps: number | null; slowPct: number | null } {
  const d: number[] = [];
  for (let i = 1; i < stamps.length; i++) {
    const x = stamps[i]! - stamps[i - 1]!;
    if (x > 0) d.push(x);
  }
  if (d.length < 5) return { fps: null, slowPct: null };
  const m = median(d)!;
  const slow = d.filter((x) => x > SLOW_FRAME_MS).length;
  return { fps: Math.min(240, 1000 / m), slowPct: (slow / d.length) * 100 };
}

/** Median and worst timer drift (ms) from (actual − expected) delays. */
export function lagStats(drifts: number[]): { lag: number | null; lagMax: number | null } {
  const xs = drifts.filter((x) => isFinite(x)).map((x) => Math.max(0, x));
  if (!xs.length) return { lag: null, lagMax: null };
  return { lag: median(xs), lagMax: Math.max(...xs) };
}

export interface Quality {
  dropped: number;
  total: number;
}

/**
 * Accumulates getVideoPlaybackQuality() counters over a playback session.
 * Engines reset them on a new source (or a new <video>), so a drop in
 * `total` folds the previous stretch in and starts over.
 */
export class QualityTracker {
  private acc: Quality = { dropped: 0, total: 0 };
  private start: Quality | null = null;
  private last: Quality | null = null;
  private owner: unknown = null;

  /** A reading from `owner` (the <video>). */
  note(q: Quality | null, owner: unknown) {
    if (!q || !isFinite(q.total) || !isFinite(q.dropped)) return;
    if (this.start && this.last && (owner !== this.owner || q.total < this.last.total)) {
      // Fresh counters (new source / element) start from zero.
      this.fold();
      this.start = { dropped: 0, total: 0 };
    }
    if (!this.start) this.start = q;
    this.owner = owner;
    this.last = q;
  }

  private fold() {
    if (this.start && this.last) {
      this.acc = {
        dropped: this.acc.dropped + Math.max(0, this.last.dropped - this.start.dropped),
        total: this.acc.total + Math.max(0, this.last.total - this.start.total),
      };
    }
    this.start = this.last = null;
  }

  /** The session's totals; resets for the next session. */
  finish(): Quality {
    this.fold();
    const out = this.acc;
    this.acc = { dropped: 0, total: 0 };
    this.owner = null;
    return { dropped: Math.min(out.dropped, out.total), total: out.total };
  }

  get active(): boolean {
    return this.start !== null || this.acc.total > 0;
  }
}

/** What the browser exposes about memory/CPU (all optional). */
export interface StaticInfo {
  heapUsed?: number | null;
  heapTotal?: number | null;
  heapLimit?: number | null;
  deviceMemory?: number | null;
  cores?: number | null;
}

export interface Measured {
  fps: number | null;
  slowPct: number | null;
  lag: number | null;
  lagMax: number | null;
}

export interface SampleInput {
  reason: "periodic" | "playback";
  uptimeMs: number;
  screen: string | null;
  playing: boolean;
  model: string | null;
  info: StaticInfo;
  measured: Measured | null;
  longTasks: { count: number; ms: number } | null;
  quality: Quality | null;
}

const MB = 1024 * 1024;
const ok = (v: number | null | undefined): v is number => typeof v === "number" && isFinite(v) && v >= 0;
const r1 = (v: number) => Math.round(v * 10) / 10;

/** The POST body (DeviceHealthSample): unknown values left out, rounded, small. */
export function buildSample(i: SampleInput): Record<string, unknown> {
  const out: Record<string, unknown> = { reason: i.reason, uptime_s: Math.max(0, Math.round(i.uptimeMs / 1000)), playing: i.playing };
  if (i.screen && /^[a-z_]{1,24}$/.test(i.screen)) out.screen = i.screen;
  if (i.model) out.model = i.model.slice(0, 120);
  const m = i.info;
  if (ok(m.heapUsed)) out.heap_used_mb = r1(m.heapUsed / MB);
  if (ok(m.heapTotal)) out.heap_total_mb = r1(m.heapTotal / MB);
  if (ok(m.heapLimit) && m.heapLimit > 0) out.heap_limit_mb = r1(m.heapLimit / MB);
  if (ok(m.deviceMemory) && m.deviceMemory <= 1024) out.device_memory_gb = m.deviceMemory;
  if (ok(m.cores) && m.cores <= 1024) out.cores = Math.round(m.cores);
  const s = i.measured;
  if (s) {
    if (ok(s.fps)) out.fps = r1(Math.min(1000, s.fps));
    if (ok(s.slowPct)) out.slow_frames_pct = r1(Math.min(100, s.slowPct));
    if (ok(s.lag)) out.lag_ms = r1(Math.min(600_000, s.lag));
    if (ok(s.lagMax)) out.lag_max_ms = r1(Math.min(600_000, s.lagMax));
  }
  if (i.longTasks) {
    out.long_tasks = Math.round(i.longTasks.count);
    out.long_task_ms = r1(i.longTasks.ms);
  }
  if (i.quality && i.quality.total > 0) {
    out.total_frames = Math.round(i.quality.total);
    out.dropped_frames = Math.min(Math.round(i.quality.dropped), out.total_frames as number);
  }
  return out;
}

/** The same numbers as HealthValues (for local display with @martytv/ui's healthParts). */
export function sampleValues(body: Record<string, unknown>): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "number") out[k] = v;
  return out;
}
