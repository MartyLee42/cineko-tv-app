// The first-load progress model: the stages of starting a stream combined
// into one monotonic 0→1 value for the loading animations (pure, tested).
//
//   resolving / searching / creating the source   0    → 0.08
//   TorrServer fetching metadata (no stats yet)    0.08 → 0.15
//   preloading (preloaded_bytes vs the goal)       0.15 → 0.9
//   stream ready, video loading → first frame      0.9  → 1
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
  resolving: [0, 0.04],
  searching: [0.02, 0.06],
  creating: [0.05, 0.08],
  metadata: [0.08, 0.15],
  preloading: [0.15, 0.9],
  starting: [0.9, 1],
  done: [1, 1],
};

const MB = 1024 * 1024;

/** Bytes to preload before playback is likely smooth: 2% of the file, 16–32 MB. */
export function preloadTarget(fileBytes: number | null | undefined): number {
  const f = fileBytes && fileBytes > 0 ? fileBytes : 0;
  return Math.min(32 * MB, Math.max(16 * MB, f * 0.02));
}

/**
 * The preload goal the bar and the «N МБ из M» line share: TorrServer's own
 * preload size when it reports one, else preloadTarget (the bar used to
 * measure against one and the text against the other).
 */
export function preloadGoal(torrent: { preload_size?: number | null } | null | undefined, fileBytes: number | null | undefined): number {
  const own = torrent?.preload_size ?? 0;
  return own > 0 ? own : preloadTarget(fileBytes);
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
      const f = Math.min(1, got / preloadGoal(i.source?.torrent, size));
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

type AttemptCtx = { media_id: string; episode_id?: string | null; season?: number | null; episode?: number | null };

/** Same title and episode (an episode id that arrives later doesn't make it another one). */
function sameItem(a: AttemptCtx, b: AttemptCtx): boolean {
  if (a.media_id !== b.media_id) return false;
  if (a.episode_id && b.episode_id) return a.episode_id === b.episode_id;
  if (a.season != null && a.episode != null && b.season != null && b.episode != null) return a.season === b.season && a.episode === b.episode;
  // One side doesn't know its episode yet (a phone's media.play still resolving it).
  return true;
}

/**
 * Whether a flow action starts a new load attempt (its progress from 0): a
 * start from outside a load (Details, the picker, the player chooser) or for
 * another title / episode. A start while one loads or after it failed for the
 * same item (failover, «Другая раздача», a phone re-sending media.play, an
 * internal restart) continues the attempt.
 */
export function newAttempt(prev: { phase: string; ctx?: AttemptCtx }, a: { type: string; ctx?: AttemptCtx }): boolean {
  if (a.type !== "start" || !a.ctx) return false;
  if ((prev.phase !== "preparing" && prev.phase !== "playing" && prev.phase !== "failed") || !prev.ctx) return true;
  return !sameItem(prev.ctx, a.ctx);
}

const STAGE_ORDER: LoadStage[] =["resolving", "searching", "creating", "metadata", "preloading", "starting", "done"];

/** Where a load's progress survives a page restart (weak TVs reload the page mid-load). */
export interface LoadStore {
  get(): string | null;
  set(v: string | null): void;
}

/** A restarted page continues a load saved this recently. */
export const RESUME_MS = 2 * 60_000;
/** The shown value moves at most this often (~4/s; the bars ease between steps with a CSS transition). */
export const SHOW_EVERY_MS = 250;
/** How often the shown value is saved for a page restart. */
const SAVE_EVERY_MS = 1000;

/**
 * One load attempt's progress — the only owner of the number the loading
 * screen (and the phone following it) shows. Monotonic for the whole attempt
 * (`key`, see PlayerController.loadKey: changes only when the user starts
 * another title / episode / release, or leaves): across remounts of the
 * screen (it lives outside React), stage flapping (a poll without torrent
 * stats turns "preloading" back into "metadata": the stage never moves back,
 * so the creep doesn't restart), preload goals that grow, and another source
 * within the attempt (failover, compat restart): that one's progress
 * continues from the value already shown, scaled into what is left. The
 * shown value steps at most every SHOW_EVERY_MS.
 */
export class LoadTracker {
  constructor(private store: LoadStore | null = null) {}
  private savedAt = -Infinity;
  private savedP = -1;
  private key: string | null = null;
  private sourceId: string | null = null;
  private meter = new LoadMeter();
  private stage: LoadStage = "resolving";
  private stageAt = 0;
  /** Value reached when the current source took over (0 for the first). */
  private base = 0;
  /** The value on screen and when it last moved. */
  private shown = 0;
  private shownAt = -Infinity;

  /**
   * The value shown so far for this attempt — a remounted screen starts there,
   * not at 0. For an attempt not seen yet: what a restarted page resumes from
   * (`title`), so the first frame doesn't flash 0 %.
   */
  current(key: string, title?: string, now = Date.now()): number {
    if (key === this.key) return this.shown;
    return title ? this.resumed(title, now) : 0;
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
      this.shown = this.base;
      this.shownAt = -Infinity;
      this.savedP = -1;
      this.savedAt = -Infinity;
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
    // Throttled (reaching 1 shows at once), never below what was shown.
    if (v > this.shown && (v >= 1 || now - this.shownAt >= SHOW_EVERY_MS || now < this.shownAt)) {
      this.shown = v;
      this.shownAt = now;
    }
    if (i.title && this.store && this.shown < 1 && this.shown > this.savedP && now - this.savedAt >= SAVE_EVERY_MS) {
      this.savedP = this.shown;
      this.savedAt = now;
      try {
        this.store.set(JSON.stringify({ title: i.title, p: this.shown, at: now }));
      } catch {
        /* storage full / blocked */
      }
    }
    return this.shown;
  }

  /** The player was left on purpose: the next load starts at 0. */
  forget() {
    this.key = null;
    this.shown = 0;
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
