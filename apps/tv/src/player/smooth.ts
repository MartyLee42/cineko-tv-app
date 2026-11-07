// «Плавность»: canPlayType says whether a TV can decode a file, not whether
// it keeps up. Two signals fill that gap, both per device and remembered:
//   - navigator.mediaCapabilities.decodingInfo (feature-detected; old engines
//     lack it and then everything behaves as before): smooth / powerEfficient
//     for H.264 / HEVC / AV1 × 1080p / 2160p × 8 / 10-bit;
//   - dropped frames during playback (getVideoPlaybackQuality, or WebKit's
//     counters): a sustained high ratio is a «this stutters here» note.
// The release ranking demotes those variants (never hides them), the server
// gets them as PlaybackAuto.rough (devicePrefs.ts), and the player offers a
// lighter release when frames drop (see the stutter detector below).
import { releaseSmoothToken, SMOOTH_TOKENS, type SmoothToken } from "@martytv/media-types";
import { storage } from "../platform";

// ---------------------------------------------------------------- decodingInfo probe

export interface DecodeAnswer {
  supported: boolean;
  smooth: boolean;
  powerEfficient: boolean;
}

export type SmoothMap = Partial<Record<SmoothToken, DecodeAnswer>>;

interface MediaCapabilitiesLike {
  decodingInfo(cfg: unknown): Promise<{ supported: boolean; smooth: boolean; powerEfficient: boolean }>;
}

/** The decodingInfo query for a token (contentType, frame, a typical bitrate; 30 fps). */
export function decodingConfig(token: SmoothToken, type: "file" | "media-source" = "file") {
  const [codec, ...rest] = token.split("_");
  const ten = rest.includes("10bit");
  const uhd = rest.includes("2160p");
  const codecs =
    codec === "h264"
      ? uhd
        ? "avc1.640033"
        : "avc1.640028"
      : codec === "hevc"
        ? `hvc1.${ten ? "2.4" : "1.6"}.L${uhd ? 153 : 120}.90`
        : `av01.0.${uhd ? "12" : "08"}M.${ten ? "10" : "08"}`;
  return {
    type,
    video: {
      contentType: `video/mp4; codecs="${codecs}"`,
      width: uhd ? 3840 : 1920,
      height: uhd ? 2160 : 1080,
      bitrate: (uhd ? 40 : 10) * 1e6,
      framerate: 30,
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const id = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      () => {
        clearTimeout(id);
        resolve(null);
      },
    );
  });
}

/**
 * Asks decodingInfo about every token ("file" playback, else "media-source"
 * when an engine only knows that). null when the API is missing; a token the
 * engine throws on or never answers is left out (unknown).
 */
export async function probeDecoding(mc: MediaCapabilitiesLike | null | undefined, timeoutMs = 3000): Promise<SmoothMap | null> {
  if (!mc || typeof mc.decodingInfo !== "function") return null;
  const out: SmoothMap = {};
  for (const token of SMOOTH_TOKENS) {
    for (const type of ["file", "media-source"] as const) {
      let r: Awaited<ReturnType<MediaCapabilitiesLike["decodingInfo"]>> | null;
      try {
        r = await withTimeout(mc.decodingInfo(decodingConfig(token, type)), timeoutMs);
      } catch {
        r = null;
      }
      if (r && typeof r.supported === "boolean") {
        out[token] = { supported: r.supported, smooth: !!r.smooth, powerEfficient: !!r.powerEfficient };
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- per-device memory

const PROBE_KEY = "martytv.smooth_probe";
const STUTTER_KEY = "martytv.stutter";
const PROBE_VERSION = 1;
/** Re-ask decodingInfo this often (and whenever the engine's UA changes). */
const PROBE_TTL = 30 * 24 * 3600_000;
/** A stutter note fades after this long (a firmware update, another box on the same account…). */
export const STUTTER_TTL = 90 * 24 * 3600_000;

interface ProbeCache {
  v: number;
  ua: string;
  at: number;
  map: SmoothMap;
}

/** token → when it last stuttered and how often. */
export type StutterLog = Partial<Record<SmoothToken, { n: number; at: number }>>;

function readJson<T>(key: string): T | null {
  try {
    return JSON.parse(storage.get(key) ?? "null") as T | null;
  } catch {
    return null;
  }
}

function ua(): string {
  return typeof navigator !== "undefined" ? navigator.userAgent : "";
}

/** The cached decodingInfo answers for this engine (null: never probed, or the API is missing). */
export function probeCache(now = Date.now()): SmoothMap | null {
  const c = readJson<ProbeCache>(PROBE_KEY);
  if (!c || c.v !== PROBE_VERSION || c.ua !== ua() || now - c.at > PROBE_TTL || typeof c.map !== "object") return null;
  return c.map;
}

let probing: Promise<SmoothMap | null> | null = null;

/** The decodingInfo answers: cached, else probed once (quietly null without the API). */
export function ensureSmoothProbe(): Promise<SmoothMap | null> {
  const cached = probeCache();
  if (cached) return Promise.resolve(cached);
  const mc = typeof navigator !== "undefined" ? (navigator as unknown as { mediaCapabilities?: MediaCapabilitiesLike }).mediaCapabilities : undefined;
  if (!mc) return Promise.resolve(null);
  probing ??= probeDecoding(mc)
    .then((map) => {
      if (map) storage.set(PROBE_KEY, JSON.stringify({ v: PROBE_VERSION, ua: ua(), at: Date.now(), map } satisfies ProbeCache));
      return map;
    })
    .catch(() => null)
    .finally(() => {
      probing = null;
    });
  return probing;
}

export function readStutters(): StutterLog {
  const s = readJson<StutterLog>(STUTTER_KEY);
  return s && typeof s === "object" ? s : {};
}

/** Remembers that a token stuttered here (the ranking demotes it from now on). */
export function noteStutter(token: SmoothToken, now = Date.now()) {
  const log = readStutters();
  const prev = log[token];
  storage.set(STUTTER_KEY, JSON.stringify({ ...log, [token]: { n: (prev?.n ?? 0) + 1, at: now } }));
}

/** A long smooth session of a token proves it fine again: the note goes. */
export function clearStutter(token: SmoothToken) {
  const log = readStutters();
  if (!log[token]) return;
  delete log[token];
  storage.set(STUTTER_KEY, JSON.stringify(log));
}

export interface SmoothView {
  /** Decodable but not smooth here (decodingInfo, or a recent stutter). */
  rough: SmoothToken[];
  /** Smooth, but not power-efficient (software decoding): a tie-breaker. */
  costly: SmoothToken[];
}

/** Merges the decodingInfo answers and the stutter log. Unsupported tokens are codecs.ts's business, not listed. */
export function smoothView(map: SmoothMap | null, log: StutterLog, now = Date.now()): SmoothView {
  const rough: SmoothToken[] = [];
  const costly: SmoothToken[] = [];
  for (const t of SMOOTH_TOKENS) {
    const a = map?.[t];
    const s = log[t];
    if ((a?.supported && !a.smooth) || (s && now - s.at < STUTTER_TTL)) rough.push(t);
    else if (a?.supported && a.smooth && !a.powerEfficient) costly.push(t);
  }
  return { rough, costly };
}

/** This device now. */
export function thisSmoothView(): SmoothView {
  return smoothView(probeCache(), readStutters());
}

// ---------------------------------------------------------------- ranking

/** Rough here: a clear demotion (still listed and playable). */
export const ROUGH_FACTOR = 0.6;
/** Smooth but software-decoded: only a tie-breaker. */
export const COSTLY_FACTOR = 0.95;

/** The smoothness factor of a release for this device (1 when not judged). */
export function smoothFactor(r: Parameters<typeof releaseSmoothToken>[0], view: SmoothView | null | undefined): number {
  if (!view) return 1;
  const t = releaseSmoothToken(r);
  if (!t) return 1;
  if (view.rough.includes(t)) return ROUGH_FACTOR;
  if (view.costly.includes(t)) return COSTLY_FACTOR;
  return 1;
}

// ---------------------------------------------------------------- dropped frames

export interface FrameCounters {
  /** Frames the engine got to present (decoded + dropped). */
  total: number;
  dropped: number;
}

/** getVideoPlaybackQuality, else WebKit's counters; null when the engine has neither. */
export function readFrames(v: HTMLVideoElement): FrameCounters | null {
  try {
    const g = (v as unknown as { getVideoPlaybackQuality?: () => { totalVideoFrames: number; droppedVideoFrames: number } }).getVideoPlaybackQuality;
    if (typeof g === "function") {
      const q = g.call(v);
      if (q && typeof q.totalVideoFrames === "number" && typeof q.droppedVideoFrames === "number") return { total: q.totalVideoFrames, dropped: q.droppedVideoFrames };
    }
    const w = v as unknown as { webkitDecodedFrameCount?: number; webkitDroppedFrameCount?: number };
    if (typeof w.webkitDecodedFrameCount === "number" && typeof w.webkitDroppedFrameCount === "number") {
      return { total: w.webkitDecodedFrameCount + w.webkitDroppedFrameCount, dropped: w.webkitDroppedFrameCount };
    }
  } catch {
    // ignore
  }
  return null;
}

export interface FrameSample extends FrameCounters {
  at: number;
  /** Playing normally: not paused / seeking / buffering, past the start-up and after-seek grace. */
  steady: boolean;
}

interface Slice {
  at: number;
  ms: number;
  frames: number;
  dropped: number;
}

export interface StutterState {
  last: FrameSample | null;
  /** Consecutive steady slices (any gap / unsteady sample starts over). */
  slices: Slice[];
  /** Steady playback so far: ms, frames, dropped (stats and the «proven smooth» check). */
  okMs: number;
  okFrames: number;
  okDropped: number;
}

export const STUTTER0: StutterState = { last: null, slices: [], okMs: 0, okFrames: 0, okDropped: 0 };

/**
 * Conservative: ≥ 15 % of the frames dropped over 30 s of steady playback,
 * and in ≥ 75 % of its slices at least 8 % (a single hiccup — a menu, a
 * background task — doesn't count). Normal playback drops well under 1 %.
 */
export const STUTTER = { windowMs: 30_000, ratio: 0.15, sliceRatio: 0.08, share: 0.75, maxGapMs: 8_000, minFps: 5 };

/**
 * One frame-counter sample (every ~2 s). Pure. `stutter`: the window is
 * full and the dropped ratio stayed high all along.
 */
export function stutterStep(s: StutterState, x: FrameSample): { state: StutterState; stutter: boolean; ratio: number | null } {
  const reset = (last: FrameSample | null) => ({ state: { ...s, last, slices: [] }, stutter: false, ratio: null });
  if (!x.steady) return reset(null);
  const l = s.last;
  if (!l) return reset(x);
  const ms = x.at - l.at;
  const frames = x.total - l.total;
  const dropped = x.dropped - l.dropped;
  // A new stream resets the counters; a long gap or no frames (paused
  // pipeline, hidden page, an engine that never counts) says nothing.
  if (ms <= 0 || ms > STUTTER.maxGapMs || frames < 0 || dropped < 0 || dropped > frames || frames < (ms / 1000) * STUTTER.minFps) return reset(x);
  let slices = [...s.slices, { at: x.at, ms, frames, dropped }];
  const covered = (list: Slice[]) => (list.length ? x.at - (list[0]!.at - list[0]!.ms) : 0);
  while (slices.length > 1 && covered(slices.slice(1)) >= STUTTER.windowMs) slices = slices.slice(1);
  const state: StutterState = { last: x, slices, okMs: s.okMs + ms, okFrames: s.okFrames + frames, okDropped: s.okDropped + dropped };
  const f = slices.reduce((n, c) => n + c.frames, 0);
  const d = slices.reduce((n, c) => n + c.dropped, 0);
  const ratio = f > 0 ? d / f : null;
  const bad = slices.filter((c) => c.frames > 0 && c.dropped / c.frames >= STUTTER.sliceRatio).length;
  const stutter = covered(slices) >= STUTTER.windowMs && ratio !== null && ratio >= STUTTER.ratio && bad >= slices.length * STUTTER.share;
  return { state, stutter, ratio };
}

/** Steady playback long and clean enough to clear a stutter note (≥ 10 min, < 2 % dropped). */
export function provenSmooth(s: StutterState): boolean {
  return s.okMs >= 600_000 && s.okFrames > 0 && s.okDropped / s.okFrames < 0.02;
}
