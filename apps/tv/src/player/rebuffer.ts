// Rebuffering to a threshold and the bandwidth estimate (ported from the web
// player, apps/web/src/player/logic.ts «rebuffering» / «bandwidth»). TV
// engines resume the moment a sliver of data arrives and stall again
// ("2 s play → loading → …") when the connection is barely faster than the
// file; after a stall the controller pauses itself and resumes only once
// enough is buffered ahead. Pure, plus the per-device rate store at the end.
import {
  addThroughputSample,
  currentThroughput,
  hintThroughput,
  medianThroughput,
  parseSamples,
  releaseBitrate,
  type SampleSource,
  type ThroughputSample,
} from "@martytv/media-types";
import { storage } from "../platform";

export const REBUFFER_MIN = 20;
export const REBUFFER_MAX = 60;
export const REBUFFER_AFTER_SEEK = 8;

/** Seconds to have buffered ahead before resuming: max(20, 3 × last stall) ≤ 60; 8 after a seek. */
export function rebufferTarget(lastStallSeconds: number | null | undefined, afterSeek: boolean): number {
  if (afterSeek) return REBUFFER_AFTER_SEEK;
  return Math.min(REBUFFER_MAX, Math.max(REBUFFER_MIN, 3 * (lastStallSeconds ?? 0)));
}

/** Seconds buffered ahead of `t` (the range containing t; 0 when t isn't buffered). */
export function bufferedAhead(ranges: readonly [number, number][], t: number): number {
  for (const [a, b] of ranges) if (t >= a - 0.25 && t <= b) return Math.max(0, b - t);
  return 0;
}

export type ResumeReason = "threshold" | "canplaythrough" | "end" | "plateau";

/** The buffered end hasn't grown for this long: the engine stopped fetching. */
export const PLATEAU_MS = 5_000;
/** …and at least this much (or the whole target) is buffered: play it. */
export const PLATEAU_MIN_AHEAD = 4;
/** Nothing arrives for this long with (almost) nothing buffered: the stream is dead — reload it here. */
export const DEAD_STALL_MS = 25_000;

/**
 * Whether a rebuffer is over, and why. `end`: the buffer reaches the end of
 * the file. `plateau`: a paused engine stopped fetching below the target
 * (Android WebView caps what a paused progressive stream preloads): the
 * percentage sat at 99 % «forever» — play what is there instead. Times
 * absolute; `stuckMs`: since the buffered end last grew.
 */
export function rebufferDone(o: {
  ahead: number;
  target: number;
  canPlayThrough: boolean;
  time: number;
  duration: number | null | undefined;
  stuckMs?: number;
}): ResumeReason | null {
  if (o.duration && o.duration > 0 && o.time + o.ahead >= o.duration - 0.5) return "end";
  // «99 %» is as good as there: play instead of hanging on it.
  if (o.ahead >= o.target * 0.99) return "threshold";
  if (o.canPlayThrough) return "canplaythrough";
  if ((o.stuckMs ?? 0) >= PLATEAU_MS && o.ahead >= Math.min(PLATEAU_MIN_AHEAD, o.target)) return "plateau";
  return null;
}

/** The stream died during a rebuffer: nothing new for DEAD_STALL_MS and less than PLATEAU_MIN_AHEAD buffered. */
export function rebufferDead(ahead: number, stuckMs: number): boolean {
  return stuckMs >= DEAD_STALL_MS && ahead < PLATEAU_MIN_AHEAD;
}

/** «Буферизация… N%»: progress towards the target (0–99 until done). */
export function rebufferPercent(ahead: number, target: number): number {
  if (target <= 0) return 99;
  return Math.max(0, Math.min(99, Math.floor((ahead / target) * 100)));
}

// ---------------------------------------------------------------- bandwidth

export { releaseBitrate as sourceBitrate };

/** One observation of the buffer's end: wall time (ms) and media time (s). */
export interface RateSample {
  at: number;
  end: number;
}

/**
 * Effective download rate (bits/s) from how fast the buffered end grows:
 * media seconds gained per wall second × the file's bitrate, over the last
 * `windowMs`. Feed samples only while the engine is still fetching (buffer
 * not full). Null until ≥ 3 s of samples.
 */
export function estimateRate(samples: readonly RateSample[], bitrate: number | null, now: number, windowMs = 15_000): number | null {
  if (!bitrate) return null;
  const recent = samples.filter((s) => s.at >= now - windowMs);
  if (recent.length < 2) return null;
  const first = recent[0]!;
  const last = recent[recent.length - 1]!;
  const dt = (last.at - first.at) / 1000;
  if (dt < 3) return null;
  return (Math.max(0, last.end - first.end) / dt) * bitrate;
}

export const LOW_RATE_FACTOR = 1.1;
export const LOW_RATE_FOR = 20_000;
export const STALL_WINDOW = 120_000;
export const STALLS_FOR_HINT = 3;

export interface BandwidthState {
  /** Since when the rate has been below 1.1 × bitrate (ms), or null. */
  lowSince: number | null;
  /** Show «Скорость соединения ниже…». */
  hint: boolean;
}

/** The lighter-release hint: rate < 1.1 × bitrate for > 20 s, or > 3 stalls in 2 min. */
export function bandwidthCheck(o: { rate: number | null; bitrate: number | null; lowSince: number | null; stalls: readonly number[]; now: number }): BandwidthState {
  const low = o.rate != null && o.bitrate != null && o.rate < LOW_RATE_FACTOR * o.bitrate;
  const lowSince = low ? (o.lowSince ?? o.now) : null;
  const recentStalls = o.stalls.filter((t) => t > o.now - STALL_WINDOW).length;
  return { lowSince, hint: (lowSince != null && o.now - lowSince > LOW_RATE_FOR) || recentStalls > STALLS_FOR_HINT };
}

// ---------------------------------------------------------------- slow-link hint schedule

/** The hint hides itself after this long without a key press. */
export const SLOW_HINT_MS = 15_000;
/** After an auto-hide it may come back only after this long. */
export const SLOW_COOLDOWN_MS = 10 * 60_000;
/** At most this many times per playback. */
export const SLOW_MAX_SHOWS = 2;

/** One playback's hint history. `dismissed`: Back / «Не сейчас» (never again in this playback). */
export interface SlowHintLog {
  shows: number;
  hiddenAt: number | null;
  dismissed: boolean;
}

export const SLOW_LOG0: SlowHintLog = { shows: 0, hiddenAt: null, dismissed: false };

/** May the hint appear now (the bandwidth check wants it)? */
export function slowHintAllowed(log: SlowHintLog, now: number): boolean {
  if (log.dismissed || log.shows >= SLOW_MAX_SHOWS) return false;
  return log.hiddenAt === null || now - log.hiddenAt >= SLOW_COOLDOWN_MS;
}

/** Shown since `shownAt` (or the last key press): time to hide it? */
export function slowHintExpired(shownAt: number, now: number): boolean {
  return now - shownAt >= SLOW_HINT_MS;
}

/** Megabits with one decimal («7.4»). */
export function mbit(bps: number | null | undefined): string {
  return bps == null ? "?" : (Math.round(bps / 100_000) / 10).toFixed(1);
}

// ---------------------------------------------------------------- per-device rate memory

// v2: v1 samples could come from a torrent still warming up (a TV that
// streamed 20 Mbit/s fine was remembered at 1.5), so they are dropped.
const RATE_KEY = "martytv.tv_rate2";
const SLOW_HINT_KEY = "martytv.slow_hint";

/** Settings → «Предупреждать о медленной скорости» (this TV; off by default). */
export const slowHintPref = {
  get(): boolean {
    return storage.get(SLOW_HINT_KEY) === "1";
  },
  set(on: boolean) {
    storage.set(SLOW_HINT_KEY, on ? "1" : "0");
  },
};

const PREBUFFER_KEY = "martytv.show_prebuffer";

/** Settings → «Показывать буфер» (this TV; off by default). */
export const prebufferPref = {
  get(): boolean {
    return storage.get(PREBUFFER_KEY) === "1";
  },
  set(on: boolean) {
    storage.set(PREBUFFER_KEY, on ? "1" : "0");
  },
};

/** How long after a source starts / a seek buffer growth says nothing about the link (the torrent warms up). Tests may shorten it. */
export function rateWarmupMs(): number {
  const o = (globalThis as { __martytvRateWarmupMs?: number }).__martytvRateWarmupMs;
  return typeof o === "number" ? o : 30_000;
}

/**
 * A session's sample: the measured estimate, but never below what the
 * session proved (a bitrate played > 2 min without stalls → the link is at
 * least 1.2 × that).
 */
export function sessionSample(est: number | null, proven: number | null): number | null {
  if (est === null) return proven;
  return proven === null ? est : Math.max(est, proven);
}

/**
 * This TV's throughput samples (per device, localStorage): one per playback
 * session plus the background speed tests (settings/speedtest.ts), with
 * their source and time. The current estimate (newest speed test weighing
 * most: @martytv/media-types currentThroughput) ranks releases and is
 * reported as the device's auto throughput.
 */
export const rateStore = {
  list(): ThroughputSample[] {
    try {
      return parseSamples(JSON.parse(storage.get(RATE_KEY) ?? "[]"));
    } catch {
      return [];
    }
  },
  samples(): number[] {
    return this.list().map((s) => s.bps);
  },
  /** The current estimate (bits/s), or null. */
  get(now = Date.now()): number | null {
    return currentThroughput(this.list(), now);
  },
  /** The estimate for the release-list network hint (a measurement ≤ 24 h old), or null. */
  hintBps(now = Date.now()): number | null {
    return hintThroughput(this.list(), now);
  },
  add(bps: number, src: SampleSource = "playback", now = Date.now()) {
    storage.set(RATE_KEY, JSON.stringify(addThroughputSample(this.list(), { bps, at: now, src })));
  },
};

/**
 * A session's rate sample: the median of the estimates taken while the
 * buffer was filling. Needs a few estimates (≥ 3) to count.
 */
export function sessionRate(estimates: readonly number[]): number | null {
  if (estimates.length < 3) return null;
  return medianThroughput(estimates);
}
