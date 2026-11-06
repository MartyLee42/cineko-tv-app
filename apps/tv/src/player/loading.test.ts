import { describe, expect, it } from "vitest";
import { LoadMeter, LoadTracker, preloadTarget, rawProgress, STAGE_RANGE, stageOf, type LoadStage } from "./loading";

const MB = 1024 * 1024;
const tor = (preloaded: number, peers = 5) => ({ peers, seeders: 3, download_speed_bps: 1, preloaded_bytes: preloaded });

describe("loading progress model", () => {
  it("maps flow steps and source state to stages", () => {
    expect(stageOf("resolving", null)).toBe("resolving");
    expect(stageOf("searching", null)).toBe("searching");
    expect(stageOf("preparing", null)).toBe("creating");
    expect(stageOf("preparing", { status: "preparing", torrent: null })).toBe("metadata");
    expect(stageOf("preparing", { status: "preparing", torrent: tor(0) })).toBe("metadata");
    expect(stageOf("preparing", { status: "preparing", torrent: tor(MB) })).toBe("preloading");
    expect(stageOf("preparing", { status: "ready", torrent: tor(MB) })).toBe("starting");
  });

  it("preload target: 2% of the file within 16–32 MB", () => {
    expect(preloadTarget(null)).toBe(16 * MB);
    expect(preloadTarget(1000 * MB)).toBe(20 * MB);
    expect(preloadTarget(50_000 * MB)).toBe(32 * MB);
  });

  it("each stage stays inside its range and creeps with time", () => {
    for (const stage of ["resolving", "searching", "creating", "metadata", "starting"] as LoadStage[]) {
      const [a, b] = STAGE_RANGE[stage];
      const early = rawProgress({ stage, stageMs: 100 });
      const late = rawProgress({ stage, stageMs: 600_000 });
      expect(early).toBeGreaterThanOrEqual(a);
      expect(late).toBeLessThanOrEqual(b);
      expect(late).toBeGreaterThan(early);
    }
  });

  it("preloading follows preloaded bytes from 0.35 to 0.85", () => {
    const src = (n: number) => ({ torrent: tor(n), file: { index: 0, path: "x", size_bytes: 1000 * MB, is_video: true, season: null, episode: null }, release: null } as never);
    expect(rawProgress({ stage: "preloading", stageMs: 0, source: src(0) })).toBeCloseTo(0.35);
    expect(rawProgress({ stage: "preloading", stageMs: 0, source: src(10 * MB) })).toBeCloseTo(0.6);
    expect(rawProgress({ stage: "preloading", stageMs: 0, source: src(40 * MB) })).toBeCloseTo(0.85);
  });

  it("metadata moves 'starting' forward; done is 1", () => {
    expect(rawProgress({ stage: "starting", stageMs: 0, metadata: true })).toBeGreaterThan(rawProgress({ stage: "starting", stageMs: 0 }));
    expect(rawProgress({ stage: "done", stageMs: 0 })).toBe(1);
  });

  it("the meter never goes backwards and caps at 1", () => {
    const m = new LoadMeter();
    expect(m.update(0.4)).toBe(0.4);
    expect(m.update(0.2)).toBe(0.4);
    expect(m.update(NaN)).toBe(0.4);
    expect(m.update(3)).toBe(1);
    // A whole sequence of stages is monotonic.
    const m2 = new LoadMeter();
    const seq = (["resolving", "searching", "creating", "metadata", "preloading", "starting", "done"] as LoadStage[]).map((stage) => m2.update(rawProgress({ stage, stageMs: 1000 })));
    for (let i = 1; i < seq.length; i++) expect(seq[i]!).toBeGreaterThanOrEqual(seq[i - 1]!);
    expect(seq[seq.length - 1]).toBe(1);
  });
});

describe("one load's progress (LoadTracker)", () => {
  const file = (size: number | null) => (size === null ? null : { index: 0, path: "x", size_bytes: size, is_video: true, season: null, episode: null });
  const src = (id: string, preloaded: number | null, size: number | null = null, releaseSize: number | null = null) =>
    ({ id, torrent: preloaded === null ? null : tor(preloaded), file: file(size), release: releaseSize === null ? null : ({ size_bytes: releaseSize } as never) }) as never;
  const monotonic = (xs: number[]) => xs.every((x, i) => i === 0 || x >= xs[i - 1]!);

  it("never goes back within a load, whatever the polls say", () => {
    const t = new LoadTracker();
    const seq: number[] = [];
    let now = 0;
    const step = (stage: LoadStage, source: unknown = null, metadata = false) => {
      now += 400;
      seq.push(t.update("g1", { stage, source: source as never, sourceId: (source as { id?: string } | null)?.id ?? null, metadata }, now));
    };
    step("resolving");
    step("searching");
    step("creating");
    for (let i = 0; i < 10; i++) step("metadata", src("s1", null));
    // Release size unknown (16 MB target): 12 MB looks like 75 % of the stage…
    step("preloading", src("s1", 12 * MB, null, null));
    // …then the file size arrives (40 GB → 32 MB target): raw would drop to ~0.54.
    step("preloading", src("s1", 13 * MB, 40_000 * MB));
    // A poll without torrent stats: stageOf says "metadata" again.
    step("metadata", src("s1", null, 40_000 * MB));
    step("preloading", src("s1", 0, 40_000 * MB));
    step("preloading", src("s1", 30 * MB, 40_000 * MB));
    step("starting", src("s1", 32 * MB, 40_000 * MB));
    step("starting", src("s1", 32 * MB, 40_000 * MB), true);
    expect(monotonic(seq)).toBe(true);
    expect(seq[seq.length - 1]!).toBeGreaterThan(0.85);
    // The old per-stage computation went back on that sequence.
    expect(rawProgress({ stage: "preloading", stageMs: 0, source: src("s1", 13 * MB, 40_000 * MB) })).toBeLessThan(
      rawProgress({ stage: "preloading", stageMs: 0, source: src("s1", 12 * MB) }),
    );
  });

  it("survives a remount of the loading screen (same load)", () => {
    const t = new LoadTracker();
    const a = t.update("g1", { stage: "preloading", source: src("s1", 10 * MB, 1000 * MB), sourceId: "s1" }, 1000);
    expect(a).toBeCloseTo(0.6);
    // A remounted screen starts from what was shown, and continues from there.
    expect(t.current("g1")).toBeCloseTo(0.6);
    expect(t.update("g1", { stage: "metadata", source: src("s1", null, 1000 * MB), sourceId: "s1" }, 1400)).toBeCloseTo(0.6);
    expect(t.current("g2")).toBe(0);
  });

  it("never goes back for another source within the load; starts over only for a new load", () => {
    const t = new LoadTracker();
    t.update("g1", { stage: "creating" }, 0);
    const first = t.update("g1", { stage: "creating" }, 5000);
    // The source appears (null → s1): same load.
    expect(t.update("g1", { stage: "metadata", source: src("s1", null), sourceId: "s1" }, 5400)).toBeGreaterThanOrEqual(first);
    const shown = t.update("g1", { stage: "preloading", source: src("s1", 20 * MB), sourceId: "s1" }, 6000);
    expect(shown).toBeGreaterThan(0.8);
    // Failover to another source: continues from what was shown…
    const s2 = t.update("g1", { stage: "metadata", source: src("s2", null), sourceId: "s2" }, 6400);
    expect(s2).toBeGreaterThanOrEqual(shown);
    // …and keeps growing with that source's stages, below 1 until it plays.
    const s2b = t.update("g1", { stage: "preloading", source: src("s2", 10 * MB, 1000 * MB), sourceId: "s2" }, 7000);
    expect(s2b).toBeGreaterThan(s2);
    expect(s2b).toBeLessThan(1);
    // A new load: from 0.
    expect(t.update("g2", { stage: "resolving" }, 7400)).toBeLessThan(0.1);
  });
});
