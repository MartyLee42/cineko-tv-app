// TV health: reading the browser. Everything is feature-detected and wrapped
// — old TV engines lack most of these APIs and must never throw here.
import { frameStats, lagStats, LAG_TICK_MS, SAMPLE_MS, type Measured, type Quality, type StaticInfo } from "./logic";

type MemoryInfo = { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number };

/** performance.memory (Chromium), navigator.deviceMemory / hardwareConcurrency. */
export function staticInfo(): StaticInfo {
  const out: StaticInfo = {};
  try {
    const mem = (typeof performance !== "undefined" ? (performance as unknown as { memory?: MemoryInfo }).memory : undefined) ?? null;
    if (mem) {
      out.heapUsed = mem.usedJSHeapSize ?? null;
      out.heapTotal = mem.totalJSHeapSize ?? null;
      out.heapLimit = mem.jsHeapSizeLimit ?? null;
    }
  } catch {
    // not exposed
  }
  try {
    const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { deviceMemory?: number }) : null;
    if (nav) {
      out.deviceMemory = typeof nav.deviceMemory === "number" ? nav.deviceMemory : null;
      out.cores = typeof nav.hardwareConcurrency === "number" ? nav.hardwareConcurrency : null;
    }
  } catch {
    // not exposed
  }
  return out;
}

const now = (): number => {
  try {
    if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now();
  } catch {
    // fall through
  }
  return Date.now();
};

/**
 * Frame rate (requestAnimationFrame) and event-loop lag (setTimeout drift)
 * over `ms` (≤ 3 s). Resolves with nulls where an API is missing; stops early
 * (with what it has) if the page gets hidden.
 */
export function measure(ms = SAMPLE_MS): Promise<Measured> {
  return new Promise((resolve) => {
    const span = Math.min(ms, SAMPLE_MS);
    const stamps: number[] = [];
    const drifts: number[] = [];
    let done = false;
    let rafId: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;
    const caf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : null;
    const t0 = now();

    const finish = () => {
      if (done) return;
      done = true;
      try {
        if (rafId !== null && caf) caf(rafId);
        if (timer !== null) clearTimeout(timer);
      } catch {
        // ignore
      }
      const f = raf ? frameStats(stamps) : { fps: null, slowPct: null };
      const l = lagStats(drifts);
      resolve({ fps: f.fps, slowPct: f.slowPct, lag: l.lag, lagMax: l.lagMax });
    };
    const hidden = () => typeof document !== "undefined" && document.hidden === true;

    const frame = (ts: number) => {
      if (done) return;
      stamps.push(typeof ts === "number" && ts > 0 ? ts : now());
      if (now() - t0 >= span || hidden()) return finish();
      rafId = raf!(frame);
    };
    const tick = (expected: number) => {
      timer = setTimeout(() => {
        if (done) return;
        drifts.push(now() - expected);
        if (now() - t0 >= span || hidden()) return finish();
        tick(now() + LAG_TICK_MS);
      }, LAG_TICK_MS);
    };
    try {
      if (raf) rafId = raf(frame);
      tick(now() + LAG_TICK_MS);
    } catch {
      finish();
    }
    // Safety net: a TV that throttles rAF/timers still resolves.
    setTimeout(finish, span + 1500);
  });
}

/** Long tasks (> 50 ms) via PerformanceObserver('longtask'), where supported. */
export class LongTasks {
  private obs: PerformanceObserver | null = null;
  private count = 0;
  private ms = 0;

  static supported(): boolean {
    try {
      const types = typeof PerformanceObserver !== "undefined" ? PerformanceObserver.supportedEntryTypes : undefined;
      return !!types && types.indexOf("longtask") >= 0;
    } catch {
      return false;
    }
  }

  start() {
    if (this.obs || !LongTasks.supported()) return;
    try {
      this.obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          this.count++;
          this.ms += e.duration;
        }
      });
      this.obs.observe({ entryTypes: ["longtask"] });
    } catch {
      this.obs = null;
    }
  }

  stop() {
    try {
      this.obs?.disconnect();
    } catch {
      // ignore
    }
    this.obs = null;
    this.reset();
  }

  /** Counts since the last reset (null when not observing). */
  read(): { count: number; ms: number } | null {
    return this.obs ? { count: this.count, ms: this.ms } : null;
  }

  reset() {
    this.count = 0;
    this.ms = 0;
  }
}

/** video.getVideoPlaybackQuality() (or the old webkit counters), or null. */
export function videoQuality(v: HTMLVideoElement | null): Quality | null {
  if (!v) return null;
  try {
    const g = (v as HTMLVideoElement & { getVideoPlaybackQuality?: () => VideoPlaybackQuality }).getVideoPlaybackQuality;
    if (typeof g === "function") {
      const q = g.call(v);
      return { dropped: q.droppedVideoFrames, total: q.totalVideoFrames };
    }
    const w = v as unknown as { webkitDroppedFrameCount?: number; webkitDecodedFrameCount?: number };
    if (typeof w.webkitDecodedFrameCount === "number") return { dropped: w.webkitDroppedFrameCount ?? 0, total: w.webkitDecodedFrameCount };
  } catch {
    // not exposed
  }
  return null;
}
