// Connection speed (docs «Device playback profiles» → «Background speed
// test»), shared by the TV app and the PWA:
//
// - throughput samples with their source (a background speed test against
//   our own GET /speedtest, or a playback session) and time; the current
//   estimate weighs the newest speed test most, so moving to another Wi-Fi
//   changes the estimate (and the release suggestions) after one test;
// - the measurement itself (adaptive: a 1 MB probe, then a sample sized for
//   ~4 s), with the transport injected;
// - the background scheduler: after start-up, every few hours and when the
//   network seems to have changed — never while something plays;
// - the release-list hint «Сеть сейчас ~8 Мбит/с — подойдут 1080p до ~4 ГБ».
// Pure / injected so both apps unit-test it.
import { medianThroughput, THROUGHPUT_HEADROOM, type MaxResolution } from "./playbackPrefs";

// ---------------------------------------------------------------- samples

export type SampleSource = "speedtest" | "playback";

export interface ThroughputSample {
  /** Bits/s. */
  bps: number;
  /** Epoch ms; 0 for samples stored before timestamps existed. */
  at: number;
  src: SampleSource;
}

/** Samples kept per device. */
export const MAX_SAMPLES = 12;
/** The estimate is the median of at most this many recent samples. */
export const ESTIMATE_SAMPLES = 7;
/** Older samples are dropped. */
export const SAMPLE_MAX_AGE_MS = 30 * 24 * 3600_000;
/** Within ×2 of the newest speed test = the same network. */
export const SAME_NETWORK_FACTOR = 2;

/** Stored JSON → samples (legacy plain-number arrays become old playback samples). */
export function parseSamples(raw: unknown): ThroughputSample[] {
  if (!Array.isArray(raw)) return [];
  const out: ThroughputSample[] = [];
  for (const x of raw) {
    if (typeof x === "number") {
      if (Number.isFinite(x) && x > 0) out.push({ bps: x, at: 0, src: "playback" });
    } else if (x && typeof x === "object") {
      const o = x as { bps?: unknown; at?: unknown; src?: unknown };
      if (typeof o.bps === "number" && Number.isFinite(o.bps) && o.bps > 0) {
        out.push({ bps: o.bps, at: typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0, src: o.src === "speedtest" ? "speedtest" : "playback" });
      }
    }
  }
  return out;
}

/** Appends a sample (newest last), keeping the last MAX_SAMPLES. */
export function addThroughputSample(list: readonly ThroughputSample[], s: ThroughputSample, max = MAX_SAMPLES): ThroughputSample[] {
  if (!Number.isFinite(s.bps) || s.bps <= 0) return [...list];
  return [...list, { ...s, bps: Math.round(s.bps) }].slice(-max);
}

function fresh(list: readonly ThroughputSample[], now: number): ThroughputSample[] {
  return list.filter((s) => s.bps > 0 && (s.at === 0 || now - s.at <= SAMPLE_MAX_AGE_MS));
}

/** The newest speed test, or null. */
export function latestSpeedtest(list: readonly ThroughputSample[]): ThroughputSample | null {
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!.src === "speedtest") return list[i]!;
  return null;
}

/** The newest timestamped sample (any source), or null. */
export function latestSample(list: readonly ThroughputSample[]): ThroughputSample | null {
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!.at > 0) return list[i]!;
  return null;
}

/**
 * The current throughput estimate (bits/s), or null.
 *
 * Without a speed test: the median of the recent samples (as before). With
 * one, the newest test anchors the current network: samples taken after it
 * count, older ones only when within ×2 of it, and an older speed test
 * outside that range is a network boundary — nothing before it counts. So
 * a test on a new Wi-Fi replaces the old estimate at once, while one-off
 * slow playback sessions (a weak swarm) don't pull it down.
 */
export function currentThroughput(list: readonly ThroughputSample[], now: number): number | null {
  const s = fresh(list, now);
  let k = -1;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i]!.src === "speedtest") {
      k = i;
      break;
    }
  }
  if (k < 0) return medianThroughput(s.slice(-ESTIMATE_SAMPLES).map((x) => x.bps));
  const anchor = s[k]!.bps;
  const same = (b: number) => b <= anchor * SAME_NETWORK_FACTOR && b >= anchor / SAME_NETWORK_FACTOR;
  const picked: number[] = s.slice(k).map((x) => x.bps);
  for (let i = k - 1; i >= 0; i--) {
    const x = s[i]!;
    if (same(x.bps)) picked.unshift(x.bps);
    else if (x.src === "speedtest") break;
  }
  return medianThroughput(picked.slice(-ESTIMATE_SAMPLES));
}

// ---------------------------------------------------------------- measurement

/** What a speed-test request returns (a fetch Response, or a test fake). */
export interface SpeedtestResponse {
  ok: boolean;
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void> } } | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface MeasureOptions {
  /** GET /speedtest?bytes=N (authenticated by the app's API client). */
  fetchBytes: (bytes: number, signal: AbortSignal) => Promise<SpeedtestResponse>;
  now?: () => number;
  signal?: AbortSignal;
  /** Aim for samples this long (ms). */
  targetMs?: number;
  /** The whole test gives up after this long (ms); a partial sample still counts. */
  timeoutMs?: number;
  maxBytes?: number;
}

export const PROBE_BYTES = 1 << 20;
export const SPEEDTEST_MAX_BYTES = 25 << 20;
export const SPEEDTEST_TARGET_MS = 4000;
export const SPEEDTEST_TIMEOUT_MS = 15_000;
/** A partial sample counts from this many bytes (a slow link times out). */
const MIN_PARTIAL_BYTES = 128 << 10;

export class SpeedtestAborted extends Error {
  constructor() {
    super("speed test aborted");
    this.name = "SpeedtestAborted";
  }
}

interface Timed {
  bytes: number;
  ms: number;
  complete: boolean;
}

/** One timed download: from the first byte (latency excluded) when the body streams. */
async function timedFetch(o: Required<Pick<MeasureOptions, "fetchBytes" | "now">>, bytes: number, signal: AbortSignal): Promise<Timed> {
  const t0 = o.now();
  let got = 0;
  let start = t0;
  try {
    const res = await o.fetchBytes(bytes, signal);
    if (!res.ok) throw new Error("speed test request failed");
    const reader = res.body?.getReader?.();
    if (!reader) {
      const buf = await res.arrayBuffer();
      return { bytes: buf.byteLength, ms: o.now() - t0, complete: true };
    }
    let first = true;
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (first) {
        // Timing starts once data flows; the first chunk is not counted.
        first = false;
        start = o.now();
        continue;
      }
      got += value.byteLength;
    }
    // Everything in one chunk: time the whole request instead.
    if (got === 0 || o.now() - start <= 0) return { bytes: total, ms: o.now() - t0, complete: true };
    return { bytes: got, ms: o.now() - start, complete: true };
  } catch (e) {
    if (got > 0) return { bytes: got, ms: o.now() - start, complete: false };
    throw e;
  }
}

const rate = (t: Timed) => (t.ms > 0 ? (t.bytes * 8 * 1000) / t.ms : null);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/**
 * Measures the device → server throughput (bits/s): a 1 MB probe, then a
 * sample sized to last ~targetMs (once more, larger, when that was still
 * too quick). On timeout a partial sample counts (slow links); an abort
 * from `signal` (playback started) throws SpeedtestAborted.
 */
export async function measureThroughput(opts: MeasureOptions): Promise<number | null> {
  const now = opts.now ?? Date.now;
  const target = opts.targetMs ?? SPEEDTEST_TARGET_MS;
  const max = opts.maxBytes ?? SPEEDTEST_MAX_BYTES;
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, opts.timeoutMs ?? SPEEDTEST_TIMEOUT_MS);
  const outer = () => ctl.abort();
  if (opts.signal?.aborted) ctl.abort();
  opts.signal?.addEventListener("abort", outer);
  const o = { fetchBytes: opts.fetchBytes, now };
  const aborted = () => !!opts.signal?.aborted;
  let best: number | null = null;
  try {
    let size = Math.min(PROBE_BYTES, max);
    for (let step = 0; step < 3; step++) {
      let t: Timed;
      try {
        t = await timedFetch(o, size, ctl.signal);
      } catch (e) {
        if (aborted()) throw new SpeedtestAborted();
        if (timedOut) return best;
        throw e;
      }
      if (aborted()) throw new SpeedtestAborted();
      const r = rate(t);
      if (!t.complete) return t.bytes >= MIN_PARTIAL_BYTES && r ? r : best;
      if (r == null) return best;
      best = r;
      // Long enough (or as big as allowed): done.
      if (step > 0 && (t.ms >= target * 0.4 || size >= max)) return r;
      if (timedOut) return r;
      const next = Math.round(clamp((r * target) / 8000, 2 * PROBE_BYTES, max));
      if (step > 0 && next <= size) return r;
      size = next;
    }
    return best;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", outer);
  }
}

// ---------------------------------------------------------------- scheduler

/** First background test after start, once the app has settled. */
export const SETTLE_MS = 25_000;
/** Regular background tests at most this often. */
export const INTERVAL_MS = 6 * 3600_000;
/** On start: skip when a test ran this recently. */
export const START_MIN_GAP_MS = 30 * 60_000;
/** A network change: at most one test per this long (debounce). */
export const NETWORK_MIN_GAP_MS = 2 * 60_000;
/** A possible change without a network signature: at most one test per this long. */
export const NETWORK_UNKNOWN_GAP_MS = 10 * 60_000;
/** Debounce of network-change events before testing. */
export const NETWORK_DEBOUNCE_MS = 5_000;
/** Hidden at least this long: on return the network may be another one. */
export const LONG_HIDDEN_MS = 30 * 60_000;
/** Busy (playing) when a test was due: retry this long after it ends. */
export const AFTER_PLAYBACK_MS = 60_000;

export type Trigger = "start" | "interval" | "network" | "visible" | "manual";

export type SkipReason = "disabled" | "playing" | "hidden" | "offline" | "save_data" | "cellular" | "recent";

export interface SchedulerEnv {
  /** The background setting («Измерять скорость интернета в фоне»). */
  enabled: boolean;
  /** Video plays / the player or a stream being prepared is open. */
  busy: boolean;
  hidden: boolean;
  online: boolean;
  saveData: boolean;
  /** A metered / cellular connection (where detectable). */
  cellular: boolean;
}

export interface SchedulerState {
  /** The last test (epoch ms), or null. */
  lastRunAt: number | null;
  /** The network signature at the last test (navigator.connection), or null. */
  netSig: string | null;
}

/**
 * Whether a test may run now for `trigger`. Manual runs ignore the setting
 * and connection type but never run during playback or offline.
 */
export function shouldRun(trigger: Trigger, st: SchedulerState, env: SchedulerEnv, now: number, netSig: string | null = null): { run: boolean; reason?: SkipReason } {
  if (env.busy) return { run: false, reason: "playing" };
  if (!env.online) return { run: false, reason: "offline" };
  if (trigger === "manual") return { run: true };
  if (!env.enabled) return { run: false, reason: "disabled" };
  if (env.hidden) return { run: false, reason: "hidden" };
  if (env.saveData) return { run: false, reason: "save_data" };
  if (env.cellular) return { run: false, reason: "cellular" };
  const since = st.lastRunAt == null || now < st.lastRunAt ? Infinity : now - st.lastRunAt;
  switch (trigger) {
    case "start":
      return since >= START_MIN_GAP_MS ? { run: true } : { run: false, reason: "recent" };
    case "interval":
      return since >= INTERVAL_MS ? { run: true } : { run: false, reason: "recent" };
    case "network":
      // A changed signature (or none known) after the debounce gap.
      if (since < NETWORK_MIN_GAP_MS) return { run: false, reason: "recent" };
      // Same signature as at the last test: nothing changed.
      if (netSig != null && st.netSig != null && netSig === st.netSig && since < INTERVAL_MS) return { run: false, reason: "recent" };
      // No signature (TV engines, Safari): `online` after a blip — not more than every 10 min.
      if (netSig == null && since < NETWORK_UNKNOWN_GAP_MS) return { run: false, reason: "recent" };
      return { run: true };
    case "visible":
      return since >= LONG_HIDDEN_MS ? { run: true } : { run: false, reason: "recent" };
  }
}

/** navigator.connection, where the engine has it. */
export interface ConnectionLike {
  type?: string;
  effectiveType?: string;
  downlink?: number;
  saveData?: boolean;
}

/** A coarse network signature (type, effective type, downlink in ×2 buckets), or null when unknown. */
export function networkSignature(c: ConnectionLike | null | undefined): string | null {
  if (!c || (c.type == null && c.effectiveType == null && c.downlink == null)) return null;
  const bucket = c.downlink && c.downlink > 0 ? Math.round(Math.log2(c.downlink)) : "";
  return `${c.type ?? ""}|${c.effectiveType ?? ""}|${bucket}`;
}

export function isCellular(c: ConnectionLike | null | undefined): boolean {
  return c?.type === "cellular";
}

export interface SchedulerDeps {
  now: () => number;
  setTimeout: (f: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  env: () => SchedulerEnv;
  netSig: () => string | null;
  load: () => SchedulerState;
  save: (s: SchedulerState) => void;
  /** Runs one measurement (bits/s or null); must honour the signal. */
  measure: (signal: AbortSignal) => Promise<number | null>;
  /** A finished measurement. */
  onResult: (bps: number, trigger: Trigger) => void;
  /** Running / idle (for the settings row). */
  onChange?: () => void;
}

export interface Scheduler {
  /** App started: first test after SETTLE_MS, then every INTERVAL_MS check. */
  start(): void;
  stop(): void;
  /** navigator.connection change / `online`: debounced test. */
  networkChanged(): void;
  /** The page became visible (after `hiddenForMs` hidden). */
  visible(hiddenForMs: number): void;
  /** Playback began / ended. Beginning aborts a running test at once. */
  setBusy(busy: boolean): void;
  /** «Проверить сейчас». Resolves with the result (null: skipped / failed). */
  runNow(): Promise<{ bps: number | null; reason?: SkipReason | "failed" }>;
  running(): boolean;
}

/** How often the scheduler re-checks whether the regular interval is due. */
export const TICK_MS = 15 * 60_000;

export function createScheduler(d: SchedulerDeps): Scheduler {
  let ctl: AbortController | null = null;
  let tick: unknown = null;
  let pending: unknown = null;
  let started = false;
  let busy = false;
  let missed: Trigger | null = null;

  const env = (): SchedulerEnv => {
    const e = d.env();
    return { ...e, busy: busy || e.busy };
  };

  const run = async (trigger: Trigger): Promise<{ bps: number | null; reason?: SkipReason | "failed" }> => {
    if (ctl) return { bps: null, reason: "recent" };
    const now = d.now();
    const sig = d.netSig();
    const st = d.load();
    const ok = shouldRun(trigger, st, env(), now, sig);
    if (!ok.run) {
      if (ok.reason === "playing" && trigger !== "manual") missed = trigger;
      return { bps: null, reason: ok.reason };
    }
    const c = new AbortController();
    ctl = c;
    d.onChange?.();
    try {
      const bps = await d.measure(c.signal);
      if (c.signal.aborted) return { bps: null, reason: "playing" };
      // Even a failed run counts (no retry storm against a broken server).
      d.save({ lastRunAt: now, netSig: sig });
      if (bps != null && bps > 0) {
        d.onResult(bps, trigger);
        return { bps };
      }
      return { bps: null, reason: "failed" };
    } catch {
      if (c.signal.aborted) {
        if (trigger !== "manual") missed = trigger;
        return { bps: null, reason: "playing" };
      }
      d.save({ lastRunAt: now, netSig: sig });
      return { bps: null, reason: "failed" };
    } finally {
      ctl = null;
      d.onChange?.();
    }
  };

  const later = (trigger: Trigger, ms: number) => {
    if (pending != null) d.clearTimeout(pending);
    pending = d.setTimeout(() => {
      pending = null;
      void run(trigger);
    }, ms);
  };

  const loop = () => {
    tick = d.setTimeout(() => {
      void run("interval");
      loop();
    }, TICK_MS);
  };

  return {
    start() {
      if (started) return;
      started = true;
      later("start", SETTLE_MS);
      loop();
    },
    stop() {
      started = false;
      if (pending != null) d.clearTimeout(pending);
      if (tick != null) d.clearTimeout(tick);
      pending = tick = null;
      ctl?.abort();
    },
    networkChanged() {
      if (started) later("network", NETWORK_DEBOUNCE_MS);
    },
    visible(hiddenForMs) {
      if (started && hiddenForMs >= LONG_HIDDEN_MS) later("visible", NETWORK_DEBOUNCE_MS);
    },
    setBusy(b) {
      if (b === busy) return;
      busy = b;
      if (b) {
        ctl?.abort();
        if (pending != null) {
          d.clearTimeout(pending);
          pending = null;
          missed ??= "network";
        }
      } else if (missed && started) {
        const t = missed;
        missed = null;
        later(t === "start" ? "network" : t, AFTER_PLAYBACK_MS);
      }
    },
    runNow() {
      return run("manual");
    },
    running() {
      return ctl != null;
    },
  };
}

// ---------------------------------------------------------------- release-list hint

/** What the release list needs of a release. */
export interface HintRelease {
  resolution?: string | null;
  size_bytes: number;
  est_bitrate_bps?: number | null;
  is_season_pack?: boolean;
  episodes?: readonly number[];
}

export interface NetworkHint {
  /** The measured speed, Mbit/s (rounded). */
  mbps: number;
  /** The best resolution among releases that fit, or null. */
  resolution: MaxResolution | null;
  /** The largest file that fits (GB, rounded), or null when the runtime is unknown. */
  maxGb: number | null;
}

const RES_ORDER = ["480p", "576p", "720p", "1080p", "2160p"];

/**
 * «Сеть сейчас ~8 Мбит/с — подойдут 1080p до ~4 ГБ»: when the measured speed
 * is too low for some of the releases (null otherwise — the network then
 * limits nothing worth mentioning).
 */
export function networkHint(items: readonly HintRelease[], bps: number | null | undefined): NetworkHint | null {
  if (!bps || bps <= 0) return null;
  const cap = bps * THROUGHPUT_HEADROOM;
  const known = items.filter((r) => r.est_bitrate_bps && r.est_bitrate_bps > 0);
  if (!known.some((r) => r.est_bitrate_bps! > cap)) return null;
  // Runtime from a single-file release: size × 8 / bitrate.
  const single = known.find((r) => !r.is_season_pack && (r.episodes?.length ?? 0) <= 1 && r.size_bytes > 0);
  const runtime = single ? (single.size_bytes * 8) / single.est_bitrate_bps! : null;
  let maxGb: number | null = null;
  if (runtime && runtime > 0) {
    const gb = (cap * runtime) / 8 / 2 ** 30;
    maxGb = gb >= 10 ? Math.round(gb) : Math.max(0.1, Math.round(gb * 10) / 10);
  }
  let res: MaxResolution | null = null;
  for (const r of known) {
    if (r.est_bitrate_bps! > cap || !r.resolution) continue;
    const rank = RES_ORDER.indexOf(r.resolution);
    if (rank >= 2 && (res == null || rank > RES_ORDER.indexOf(res))) res = r.resolution as MaxResolution;
  }
  return { mbps: displayMbps(bps), resolution: res, maxGb };
}

/** The hint is shown for measurements at most this old. */
export const HINT_MAX_AGE_MS = 24 * 3600_000;

/** «2160p» → «4K» for display. */
export function resolutionLabel(r: string): string {
  return r === "2160p" ? "4K" : r;
}

/** The hint as text (words from i18n: tvplay.net.hint / hint_any / hint_slow). */
export function networkHintText(h: NetworkHint, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (h.maxGb == null) return t("tvplay.net.hint_slow", { mbps: h.mbps });
  if (h.resolution) return t("tvplay.net.hint", { mbps: h.mbps, res: resolutionLabel(h.resolution), gb: h.maxGb });
  return t("tvplay.net.hint_any", { mbps: h.mbps, gb: h.maxGb });
}

// ---------------------------------------------------------------- settings text

/** Mbit/s for display: whole numbers from 10, one decimal below. */
export function displayMbps(bps: number): number {
  return bps >= 10e6 ? Math.round(bps / 1e6) : Math.round(bps / 1e5) / 10;
}

/** «5 мин назад» (abbreviated units: no plural forms needed). */
export function agoText(at: number, now: number, t: (k: string, v?: Record<string, string | number>) => string): string {
  const min = Math.floor(Math.max(0, now - at) / 60_000);
  if (min < 1) return t("tvplay.net.ago_now");
  if (min < 60) return t("tvplay.net.ago_min", { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t("tvplay.net.ago_hour", { n: h });
  return t("tvplay.net.ago_day", { n: Math.floor(h / 24) });
}

/** «Скорость до сервера: 42 Мбит/с · 5 мин назад» (or «ещё не измерялась»). */
export function lastSpeedText(s: ThroughputSample | null, now: number, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (!s || s.at <= 0) return t("tvplay.net.never");
  return t("tvplay.net.last", { mbps: displayMbps(s.bps), ago: agoText(s.at, now, t) });
}

/** The status line after «Проверить сейчас». */
export function runResultText(r: { bps: number | null; reason?: string }, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (r.bps) return t("tvplay.net.done", { mbps: displayMbps(r.bps) });
  switch (r.reason) {
    case "playing":
      return t("tvplay.net.busy");
    case "offline":
      return t("tvplay.net.offline");
    default:
      return t("tvplay.net.failed");
  }
}

/**
 * The hint's speed: the current estimate when a measurement (any source)
 * is at most HINT_MAX_AGE_MS old, else null.
 */
export function hintThroughput(list: readonly ThroughputSample[], now: number): number | null {
  const last = latestSample(list);
  if (!last || now - last.at > HINT_MAX_AGE_MS) return null;
  return currentThroughput(list, now);
}
