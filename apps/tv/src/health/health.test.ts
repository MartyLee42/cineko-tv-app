import { describe, expect, it } from "vitest";
import { buildSample, frameStats, healthEnabled, healthGate, lagStats, median, MIN_GAP_MS, QualityTracker } from "./logic";

describe("health gate", () => {
  const base = { enabled: true, hidden: false, now: 1_000_000, lastPostAt: null };
  it("is on by default and off only for an explicit 0", () => {
    expect(healthEnabled(null)).toBe(true);
    expect(healthEnabled(undefined)).toBe(true);
    expect(healthEnabled("1")).toBe(true);
    expect(healthEnabled("0")).toBe(false);
  });
  it("off wins over everything: no sampling, no posts", () => {
    expect(healthGate({ ...base, enabled: false })).toBe("off");
    expect(healthGate({ ...base, enabled: false, hidden: true })).toBe("off");
  });
  it("skips while hidden and respects the server's 1/min", () => {
    expect(healthGate(base)).toBe("ok");
    expect(healthGate({ ...base, hidden: true })).toBe("hidden");
    expect(healthGate({ ...base, lastPostAt: base.now - 10_000 })).toBe("too_soon");
    expect(healthGate({ ...base, lastPostAt: base.now - MIN_GAP_MS })).toBe("ok");
  });
});

describe("health measurements", () => {
  it("median", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
  it("frame stats from rAF stamps", () => {
    const stamps = Array.from({ length: 61 }, (_, i) => i * 16.67);
    const s = frameStats(stamps);
    expect(Math.round(s.fps!)).toBe(60);
    expect(s.slowPct).toBe(0);
    // A stuttering TV: every other frame 80 ms.
    const slow = [0];
    for (let i = 1; i <= 20; i++) slow.push(slow[i - 1]! + (i % 2 ? 80 : 33));
    const t = frameStats(slow);
    expect(t.slowPct).toBe(50);
    expect(t.fps!).toBeLessThan(30);
    expect(frameStats([0, 16])).toEqual({ fps: null, slowPct: null });
  });
  it("lag stats clamp negatives", () => {
    expect(lagStats([])).toEqual({ lag: null, lagMax: null });
    expect(lagStats([-2, 4, 10, 200])).toEqual({ lag: 7, lagMax: 200 });
  });
  it("tracks dropped frames across source changes", () => {
    const q = new QualityTracker();
    const v1 = {};
    q.note({ dropped: 2, total: 100 }, v1); // first reading = baseline
    q.note({ dropped: 5, total: 1100 }, v1);
    q.note({ dropped: 1, total: 400 }, v1); // reset (new source): counted from zero
    q.note(null, v1);
    expect(q.active).toBe(true);
    expect(q.finish()).toEqual({ dropped: 4, total: 1400 });
    expect(q.active).toBe(false);
    expect(q.finish()).toEqual({ dropped: 0, total: 0 });
  });
});

describe("health sample body", () => {
  it("keeps it small and leaves unknowns out", () => {
    const body = buildSample({
      reason: "periodic",
      uptimeMs: 125_400,
      screen: "home",
      playing: false,
      model: "TX3 · Android 11",
      info: { heapUsed: 182.44 * 1024 * 1024, heapTotal: null, heapLimit: 1024 * 1024 * 1024, deviceMemory: 2, cores: 4 },
      measured: { fps: 58.33, slowPct: 1.234, lag: 12, lagMax: 40 },
      longTasks: { count: 3, ms: 410.04 },
      quality: null,
    });
    expect(body).toEqual({
      reason: "periodic",
      uptime_s: 125,
      playing: false,
      screen: "home",
      model: "TX3 · Android 11",
      heap_used_mb: 182.4,
      heap_limit_mb: 1024,
      device_memory_gb: 2,
      cores: 4,
      fps: 58.3,
      slow_frames_pct: 1.2,
      lag_ms: 12,
      lag_max_ms: 40,
      long_tasks: 3,
      long_task_ms: 410,
    });
    expect(JSON.stringify(body).length).toBeLessThan(400);
  });
  it("an old engine reports almost nothing", () => {
    const body = buildSample({ reason: "playback", uptimeMs: 1000, screen: "Weird!", playing: true, model: null, info: {}, measured: null, longTasks: null, quality: { dropped: 9, total: 3 } });
    expect(body).toEqual({ reason: "playback", uptime_s: 1, playing: true, total_frames: 3, dropped_frames: 3 });
  });
});
