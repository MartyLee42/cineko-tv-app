// Playback quality telemetry: running totals for one playback, measured from
// events the <video> fires anyway. No timers and no polling; frame counters
// are read only when a report goes out (every few minutes and at the end).

export interface PlaybackQualitySample {
  app: "tv" | "web";
  engine: string;
  startup_ms: number | null;
  watched_s: number;
  stalls: number;
  stall_ms: number;
  longest_stall_ms: number;
  seeks: number;
  seek_wait_ms: number;
  dropped_frames: number;
  total_frames: number;
  width: number | null;
  height: number | null;
  errors: number;
}

/** Progress reports fire every 15 s: every 20th periodic one carries totals (5 min). */
export const QUALITY_EVERY_REPORTS = 20;
/** Shorter waits are engine noise, not a stall anyone sees. */
const MIN_STALL_MS = 250;
/** A wait this long is a sleeping device or a lost connection: counted, but capped. */
const MAX_STALL_MS = 30 * 60_000;
/** A wait right after a seek belongs to the seek. */
const AFTER_SEEK_MS = 4000;

type FrameCounts = { dropped: number; total: number };

function readFrames(v: HTMLVideoElement): FrameCounts | null {
  try {
    const g = v as HTMLVideoElement & {
      webkitDroppedFrameCount?: number;
      webkitDecodedFrameCount?: number;
    };
    if (typeof g.getVideoPlaybackQuality === "function") {
      const q = g.getVideoPlaybackQuality();
      return { dropped: q.droppedVideoFrames, total: q.totalVideoFrames };
    }
    if (typeof g.webkitDecodedFrameCount === "number") {
      return { dropped: g.webkitDroppedFrameCount ?? 0, total: g.webkitDecodedFrameCount };
    }
  } catch {
    // Old engines: no counters.
  }
  return null;
}

export class PlaybackQualityMeter {
  private v: HTMLVideoElement | null = null;
  private readonly began: number;
  private startup: number | null = null;
  private playMs = 0;
  private playingSince: number | null = null;
  private stallSince: number | null = null;
  private stallAfterSeek = false;
  private stalls = 0;
  private stallMs = 0;
  private longest = 0;
  private seeks = 0;
  private seekWait = 0;
  private seekSince: number | null = null;
  private seekedAt: number | null = null;
  private errors = 0;
  private dropped = 0;
  private total = 0;
  private lastFrames: FrameCounts | null = null;
  private width: number | null = null;
  private height: number | null = null;

  constructor(
    private readonly app: "tv" | "web",
    private readonly engine: () => string,
    /** The player paused itself to rebuffer: that pause is still the stall. */
    private readonly selfPaused: () => boolean = () => false,
    private readonly now: () => number = Date.now,
  ) {
    this.began = now();
  }

  private readonly on: Record<string, () => void> = {
    playing: () => {
      const t = this.now();
      if (this.startup === null) this.startup = t - this.began;
      this.closeSeek(t);
      this.closeStall(t);
      this.playingSince ??= t;
    },
    waiting: () => {
      if (this.startup === null || this.v?.seeking || this.stallSince !== null) return;
      const t = this.now();
      this.stopClock(t);
      this.stallSince = t;
      this.stallAfterSeek = this.seekedAt !== null && t - this.seekedAt < AFTER_SEEK_MS;
    },
    pause: () => {
      if (this.selfPaused()) return;
      const t = this.now();
      this.stopClock(t);
      this.closeStall(t);
    },
    seeking: () => {
      const t = this.now();
      this.stopClock(t);
      this.stallSince = null;
      this.seeks++;
      this.seekSince ??= t;
    },
    seeked: () => {
      const t = this.now();
      this.closeSeek(t);
      this.seekedAt = t;
      if (this.v && !this.v.paused) this.playingSince ??= t;
    },
    ended: () => {
      const t = this.now();
      this.stopClock(t);
      this.closeStall(t);
    },
    error: () => {
      this.errors++;
    },
  };

  private stopClock(t: number) {
    if (this.playingSince !== null) this.playMs += Math.max(0, t - this.playingSince);
    this.playingSince = null;
  }

  private closeSeek(t: number) {
    if (this.seekSince !== null) this.seekWait += Math.min(MAX_STALL_MS, Math.max(0, t - this.seekSince));
    this.seekSince = null;
  }

  private closeStall(t: number) {
    if (this.stallSince === null) return;
    const d = Math.min(MAX_STALL_MS, Math.max(0, t - this.stallSince));
    this.stallSince = null;
    if (this.stallAfterSeek) this.seekWait += d;
    else if (d >= MIN_STALL_MS) {
      this.stalls++;
      this.stallMs += d;
      this.longest = Math.max(this.longest, d);
    }
  }

  private sampleVideo() {
    const v = this.v;
    if (!v) return;
    if (v.videoWidth > 0 && v.videoHeight > 0) {
      this.width = v.videoWidth;
      this.height = v.videoHeight;
    }
    const f = readFrames(v);
    if (!f || !Number.isFinite(f.total) || !Number.isFinite(f.dropped)) return;
    // Engines restart the counters on a new source.
    const last = this.lastFrames && f.total >= this.lastFrames.total ? this.lastFrames : { dropped: 0, total: 0 };
    this.dropped += Math.max(0, f.dropped - last.dropped);
    this.total += Math.max(0, f.total - last.total);
    this.lastFrames = f;
  }

  /** Follows this element (the previous one, if any, is let go). */
  attach(v: HTMLVideoElement) {
    if (this.v === v) return;
    this.detach();
    this.v = v;
    this.lastFrames = readFrames(v);
    for (const [k, fn] of Object.entries(this.on)) v.addEventListener(k, fn, { passive: true });
  }

  detach() {
    const v = this.v;
    if (!v) return;
    this.sampleVideo();
    const t = this.now();
    this.stopClock(t);
    this.closeStall(t);
    this.closeSeek(t);
    for (const [k, fn] of Object.entries(this.on)) v.removeEventListener(k, fn);
    this.v = null;
    this.lastFrames = null;
  }

  /** The totals so far, including whatever is in progress. */
  snapshot(): PlaybackQualitySample {
    this.sampleVideo();
    const t = this.now();
    const playing = this.playingSince === null ? 0 : Math.max(0, t - this.playingSince);
    const open = this.stallSince === null ? 0 : Math.min(MAX_STALL_MS, Math.max(0, t - this.stallSince));
    const openStall = !this.stallAfterSeek && open >= MIN_STALL_MS ? open : 0;
    return {
      app: this.app,
      engine: this.engine(),
      startup_ms: this.startup === null ? null : Math.round(this.startup),
      watched_s: Math.round((this.playMs + playing) / 1000),
      stalls: this.stalls + (openStall ? 1 : 0),
      stall_ms: Math.round(this.stallMs + openStall),
      longest_stall_ms: Math.round(Math.max(this.longest, openStall)),
      seeks: this.seeks,
      seek_wait_ms: Math.round(this.seekWait),
      dropped_frames: this.dropped,
      total_frames: this.total,
      width: this.width,
      height: this.height,
      errors: this.errors,
    };
  }
}
