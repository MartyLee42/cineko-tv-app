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
export class LoadTracker {
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

  update(key: string, i: Omit<LoadInput, "stageMs"> & { sourceId?: string | null }, now: number): number {
    const sid = i.sourceId ?? null;
    if (key !== this.key) {
      this.key = key;
      this.sourceId = null;
      this.meter.reset();
      this.base = 0;
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
    return this.meter.update(this.base + (1 - this.base) * raw);
  }
}
