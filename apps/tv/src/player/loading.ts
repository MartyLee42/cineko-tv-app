// The first-load progress model: the stages of starting a stream combined
// into one monotonic 0→1 value for the loading animations (pure, tested).
//
//   resolving / searching / creating the source   0    → 0.15
//   TorrServer fetching metadata (no stats yet)    0.15 → 0.35
//   preloading (preloaded_bytes vs a target)       0.35 → 0.85
//   stream ready, video loading → first frame      0.85 → 1
//
// Inside a stage with no measurable progress the value creeps towards the
// stage's end (never reaching it), so the animation never looks frozen.
import type { PlaybackSource } from "@martytv/contracts";

export type LoadStage = "resolving" | "searching" | "creating" | "metadata" | "preloading" | "starting" | "done";

export interface LoadInput {
  stage: LoadStage;
  /** Time spent in the current stage. */
  stageMs: number;
  source?: Pick<PlaybackSource, "torrent" | "file" | "release"> | null;
  /** Video: metadata known (duration/size). */
  metadata?: boolean;
}

export const STAGE_RANGE: Record<LoadStage, [number, number]> = {
  resolving: [0, 0.08],
  searching: [0.04, 0.12],
  creating: [0.1, 0.15],
  metadata: [0.15, 0.35],
  preloading: [0.35, 0.85],
  starting: [0.85, 1],
  done: [1, 1],
};

const MB = 1024 * 1024;

/** Bytes to preload before playback is likely smooth: 2% of the file, 16–32 MB. */
export function preloadTarget(fileBytes: number | null | undefined): number {
  const f = fileBytes && fileBytes > 0 ? fileBytes : 0;
  return Math.min(32 * MB, Math.max(16 * MB, f * 0.02));
}

/** 0→1 asymptotically with time (half-way after `half` ms). */
function creep(ms: number, half: number): number {
  return 1 - Math.pow(0.5, Math.max(0, ms) / half);
}

/** Stage of a preparing flow from its step and source. */
export function stageOf(step: "resolving" | "searching" | "preparing", source: Pick<PlaybackSource, "torrent" | "status"> | null): LoadStage {
  if (step === "resolving") return "resolving";
  if (step === "searching") return "searching";
  if (!source) return "creating";
  if (source.status === "ready") return "starting";
  const t = source.torrent;
  if (!t || (t.preloaded_bytes ?? 0) <= 0) return "metadata";
  return "preloading";
}

/** Raw (possibly non-monotonic) progress for the current stage. */
export function rawProgress(i: LoadInput): number {
  const [a, b] = STAGE_RANGE[i.stage];
  const span = b - a;
  switch (i.stage) {
    case "done":
      return 1;
    case "preloading": {
      const size = i.source?.file?.size_bytes ?? i.source?.release?.size_bytes ?? null;
      const got = i.source?.torrent?.preloaded_bytes ?? 0;
      const f = Math.min(1, got / preloadTarget(size));
      return a + span * f;
    }
    case "starting":
      // Metadata arrived: most of the way to the first frame.
      return a + span * (i.metadata ? 0.6 + 0.35 * creep(i.stageMs, 1500) : 0.55 * creep(i.stageMs, 2500));
    default:
      return a + span * 0.92 * creep(i.stageMs, i.stage === "metadata" ? 6000 : 2500);
  }
}

/** Keeps a value monotonic (see LoadTracker for one load's progress). */
export class LoadMeter {
  private value = 0;
  get current(): number {
    return this.value;
  }
  update(raw: number): number {
    if (isFinite(raw)) this.value = Math.min(1, Math.max(this.value, raw));
    return this.value;
  }
  reset() {
    this.value = 0;
  }
}

const STAGE_ORDER: LoadStage[] = ["resolving", "searching", "creating", "metadata", "preloading", "starting", "done"];

/**
 * One load's progress, monotonic for the whole load — across remounts of the
 * loading screen (it lives outside React), stage flapping (a poll without
 * torrent stats turns "preloading" back into "metadata": the stage never
 * moves back, so the creep doesn't restart), preload targets that grow once
 * the file size is known, and another source / release within the load
 * (failover): that one's progress continues from the value already shown,
 * scaled into what is left. Only a new load (`key`) starts again from 0.
 */
/** Where a load's progress survives a page restart (weak TVs reload the page mid-load). */
export interface LoadStore {
  get(): string | null;
  set(v: string | null): void;
}

/** A restarted page continues a load saved this recently. */
export const RESUME_MS = 2 * 60_000;

export class LoadTracker {
  constructor(private store: LoadStore | null = null) {}
  private saved = -1;
  private key: string | null = null;
  private sourceId: string | null = null;
  private meter = new LoadMeter();
  private stage: LoadStage = "resolving";
  private stageAt = 0;
  /** Value reached when the current source took over (0 for the first). */
  private base = 0;

  /** The value shown so far for this load (0 for another one): a remounted screen starts there, not at 0. */
  current(key: string): number {
    return key === this.key ? this.meter.current : 0;
  }

  /**
   * `title`: what is loading (title + episode). A page that restarted while
   * it loaded (the TV ran out of memory) and loads it again continues from
   * the saved value instead of 0.
   */
  update(key: string, i: Omit<LoadInput, "stageMs"> & { sourceId?: string | null; title?: string }, now: number): number {
    const sid = i.sourceId ?? null;
    if (key !== this.key) {
      this.key = key;
      this.sourceId = null;
      this.meter.reset();
      this.base = i.title ? this.resumed(i.title, now) : 0;
      this.meter.update(this.base);
      this.saved = -1;
      this.stage = i.stage;
      this.stageAt = now;
    } else if (sid !== null && this.sourceId !== null && sid !== this.sourceId) {
      // Another source: its stages start over, the bar doesn't.
      this.sourceId = null;
      this.base = this.meter.current;
      this.stage = i.stage;
      this.stageAt = now;
    }
    if (sid !== null) this.sourceId = sid;
    if (STAGE_ORDER.indexOf(i.stage) > STAGE_ORDER.indexOf(this.stage)) {
      this.stage = i.stage;
      this.stageAt = now;
    }
    const raw = rawProgress({ stage: this.stage, stageMs: now - this.stageAt, source: i.source, metadata: i.metadata });
    const v = this.meter.update(this.base + (1 - this.base) * raw);
    if (i.title && this.store && v < 1 && v - this.saved >= 0.01) {
      this.saved = v;
      try {
        this.store.set(JSON.stringify({ title: i.title, p: v, at: now }));
      } catch {
        /* storage full / blocked */
      }
    }
    return v;
  }

  /** The player was left on purpose: the next load starts at 0. */
  forget() {
    this.key = null;
    try {
      this.store?.set(null);
    } catch {
      /* blocked */
    }
  }

  private resumed(title: string, now: number): number {
    try {
      const raw = this.store?.get();
      if (!raw) return 0;
      const s = JSON.parse(raw) as { title?: string; p?: number; at?: number };
      if (s.title !== title || typeof s.p !== "number" || typeof s.at !== "number") return 0;
      if (now - s.at > RESUME_MS || now < s.at) return 0;
      return Math.max(0, Math.min(0.95, s.p));
    } catch {
      return 0;
    }
  }
}

/**
 * The loading screen's torrent numbers, never going back within one source:
 * TorrServer's preloaded bytes drop when the TV opens another read position
 * (the index at the end of the file), and two feeds (the screen's poll and
 * the controller's) alternate. The file size — the «of N MB» target — only
 * grows too (release size first, then the file's).
 */
export class TorrentHold {
  private id: string | null = null;
  private pre = 0;
  private size = 0;

  hold<T extends { preloaded_bytes?: number | null } | null>(
    sourceId: string | null,
    torrent: T,
    fileBytes: number | null,
  ): { torrent: T; fileBytes: number | null } {
    if (sourceId !== this.id) {
      this.id = sourceId;
      this.pre = 0;
      this.size = 0;
    }
    this.pre = Math.max(this.pre, torrent?.preloaded_bytes ?? 0);
    this.size = Math.max(this.size, fileBytes ?? 0);
    const t = torrent && this.pre > (torrent.preloaded_bytes ?? 0) ? { ...torrent, preloaded_bytes: this.pre } : torrent;
    return { torrent: t, fileBytes: this.size > 0 ? this.size : fileBytes };
  }
}

const STORE_KEY = "martytv.loadProgress";

/** The app's one tracker (only one load shows at a time), kept in localStorage across page restarts. */
export const loadTracker = new LoadTracker(
  typeof localStorage === "undefined"
    ? null
    : {
        get: () => localStorage.getItem(STORE_KEY),
        set: (v) => (v === null ? localStorage.removeItem(STORE_KEY) : localStorage.setItem(STORE_KEY, v)),
      },
);
