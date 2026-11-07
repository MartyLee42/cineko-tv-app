import { describe, expect, it } from "vitest";
import { LoadMeter, LoadTracker, newAttempt, preloadGoal, preloadTarget, rawProgress, RESUME_MS, SHOW_EVERY_MS, STAGE_RANGE, stageOf, TorrentHold, type LoadStage } from "./loading";

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

  it("preloading follows preloaded bytes from 0.15 to 0.9", () => {
    const src = (n: number) => ({ torrent: tor(n), file: { index: 0, path: "x", size_bytes: 1000 * MB, is_video: true, season: null, episode: null }, release: null } as never);
    expect(rawProgress({ stage: "preloading", stageMs: 0, source: src(0) })).toBeCloseTo(0.15);
    expect(rawProgress({ stage: "preloading", stageMs: 0, source: src(10 * MB) })).toBeCloseTo(0.525);
    expect(rawProgress({ stage: "preloading", stageMs: 0, source: src(40 * MB) })).toBeCloseTo(0.9);
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
    expect(seq[seq.length - 1]!).toBeGreaterThan(0.9);
    // The old per-stage computation went back on that sequence.
    expect(rawProgress({ stage: "preloading", stageMs: 0, source: src("s1", 13 * MB, 40_000 * MB) })).toBeLessThan(
      rawProgress({ stage: "preloading", stageMs: 0, source: src("s1", 12 * MB) }),
    );
  });

  it("survives a remount of the loading screen (same load)", () => {
    const t = new LoadTracker();
    const a = t.update("g1", { stage: "preloading", source: src("s1", 10 * MB, 1000 * MB), sourceId: "s1" }, 1000);
    expect(a).toBeCloseTo(0.525);
    // A remounted screen starts from what was shown, and continues from there.
    expect(t.current("g1")).toBeCloseTo(0.525);
    expect(t.update("g1", { stage: "metadata", source: src("s1", null, 1000 * MB), sourceId: "s1" }, 1400)).toBeCloseTo(0.525);
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

describe("load progress across a page restart", () => {
  const memStore = () => {
    let v: string | null = null;
    return { get: () => v, set: (x: string | null) => void (v = x) };
  };

  it("a restarted page loading the same title continues from the saved value", () => {
    const store = memStore();
    const before = new LoadTracker(store);
    before.update("m1||0", { stage: "metadata", title: "m1|" }, 0);
    const shown = before.update("m1||0", { stage: "metadata", title: "m1|" }, 8000);
    expect(shown).toBeGreaterThan(0.1);
    // The TV reloads the page: a fresh tracker (and controller counter).
    const after = new LoadTracker(store);
    expect(after.update("m1||0", { stage: "resolving", title: "m1|" }, 20_000)).toBeGreaterThanOrEqual(shown);
  });

  it("starts at 0 for another title, after a while, or after leaving the player", () => {
    const store = memStore();
    const t = new LoadTracker(store);
    t.update("m1||0", { stage: "metadata", title: "m1|" }, 0);
    t.update("m1||0", { stage: "metadata", title: "m1|" }, 8000);
    expect(new LoadTracker(store).update("m2||0", { stage: "resolving", title: "m2|" }, 9000)).toBeLessThan(0.05);
    expect(new LoadTracker(store).update("m1||0", { stage: "resolving", title: "m1|" }, 8000 + RESUME_MS + 1)).toBeLessThan(0.05);
    t.forget();
    expect(new LoadTracker(store).update("m1||1", { stage: "resolving", title: "m1|" }, 9000)).toBeLessThan(0.05);
  });
});

describe("torrent numbers on the loading screen (TorrentHold)", () => {
  it("preloaded bytes and the file size never go back within a source", () => {
    const h = new TorrentHold();
    expect(h.hold("s1", { preloaded_bytes: 10 * MB }, 1000 * MB).torrent?.preloaded_bytes).toBe(10 * MB);
    // TorrServer restarted its preload at another position: still 10 MB shown.
    expect(h.hold("s1", { preloaded_bytes: 2 * MB }, 1000 * MB).torrent?.preloaded_bytes).toBe(10 * MB);
    expect(h.hold("s1", { preloaded_bytes: 14 * MB }, 1000 * MB).torrent?.preloaded_bytes).toBe(14 * MB);
    // The other feed has no torrent block yet / a smaller size: held too.
    expect(h.hold("s1", null, 900 * MB).fileBytes).toBe(1000 * MB);
    // Another source: its own numbers.
    expect(h.hold("s2", { preloaded_bytes: 1 * MB }, 500 * MB)).toEqual({ torrent: { preloaded_bytes: 1 * MB }, fileBytes: 500 * MB });
  });
});

describe("one number for one load attempt", () => {
  const monotonic = (xs: number[]) => xs.every((x, i) => i === 0 || x >= xs[i - 1]!);
  const file = { index: 0, path: "x", size_bytes: 4000 * MB, is_video: true, season: null, episode: null };
  const src = (id: string, pre: number, preloadSize = 0, status: "preparing" | "ready" = "preparing") =>
    ({ id, status, torrent: { ...tor(pre), preload_size: preloadSize }, file, release: null }) as never;

  it("mixed producers (controller poll, live poll, stage flaps, failover, first frame) never move it back", () => {
    const t = new LoadTracker();
    // A seeded pseudo-random interleaving of what the screen gets fed.
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const out: number[] = [];
    let now = 0;
    let pre = 0;
    for (let i = 0; i < 400; i++) {
      now += 50 + Math.floor(rnd() * 400);
      pre += Math.floor(rnd() * 2 * MB);
      const r = rnd();
      const sid = i > 250 ? "s2" : "s1";
      const stage: LoadStage = r < 0.1 ? "metadata" : r < 0.2 ? "creating" : i > 330 ? "starting" : "preloading";
      // The other feed: TorrServer restarted its preload elsewhere, or reports its own (bigger) goal.
      const bytes = rnd() < 0.3 ? Math.floor(pre * rnd()) : pre;
      out.push(t.update("load|1", { stage, source: src(sid, bytes, rnd() < 0.5 ? 64 * MB : 0), sourceId: sid, metadata: rnd() < 0.5, title: "m|" }, now));
    }
    expect(monotonic(out)).toBe(true);
    expect(out[out.length - 1]!).toBeGreaterThan(0.9);
    expect(out[out.length - 1]!).toBeLessThan(1);
  });

  it("steps at most every SHOW_EVERY_MS; reaching 1 shows at once", () => {
    const t = new LoadTracker();
    const a = t.update("k", { stage: "preloading", source: src("s", 4 * MB), sourceId: "s" }, 1000);
    expect(t.update("k", { stage: "preloading", source: src("s", 8 * MB), sourceId: "s" }, 1000 + SHOW_EVERY_MS - 10)).toBe(a);
    const b = t.update("k", { stage: "preloading", source: src("s", 8 * MB), sourceId: "s" }, 1000 + SHOW_EVERY_MS);
    expect(b).toBeGreaterThan(a);
    expect(t.update("k", { stage: "done" }, 1000 + SHOW_EVERY_MS + 1)).toBe(1);
  });

  it("phases share one scale: preload up to 0.9, the first frame the rest", () => {
    expect(rawProgress({ stage: "preloading", stageMs: 0, source: src("s", 64 * MB) })).toBeCloseTo(0.9);
    expect(rawProgress({ stage: "starting", stageMs: 0 })).toBeGreaterThanOrEqual(0.9);
    expect(rawProgress({ stage: "starting", stageMs: 600_000, metadata: true })).toBeLessThan(1);
  });

  it("the bar and the «N МБ из M» text use the same goal", () => {
    expect(preloadGoal({ preload_size: 50 * MB }, 1000 * MB)).toBe(50 * MB);
    expect(preloadGoal({ preload_size: 0 }, 1000 * MB)).toBe(preloadTarget(1000 * MB));
    expect(preloadGoal(null, null)).toBe(16 * MB);
  });

  it("a new attempt only when the user starts something else", () => {
    const ctx = (media_id: string, episode_id: string | null = null, season: number | null = null, episode: number | null = null) => ({ media_id, episode_id, season, episode });
    const start = (c: ReturnType<typeof ctx>) => ({ type: "start", ctx: c });
    // From Details / the picker / the chooser: new.
    expect(newAttempt({ phase: "idle" }, start(ctx("m")))).toBe(true);
    expect(newAttempt({ phase: "picker", ctx: ctx("m") }, start(ctx("m")))).toBe(true);
    expect(newAttempt({ phase: "choose", ctx: ctx("m") }, start(ctx("m")))).toBe(true);
    // Failover / «Другая раздача» / a phone re-sending the same title: same attempt.
    expect(newAttempt({ phase: "failed", ctx: ctx("m") }, start(ctx("m")))).toBe(false);
    expect(newAttempt({ phase: "preparing", ctx: ctx("m") }, start(ctx("m")))).toBe(false);
    expect(newAttempt({ phase: "playing", ctx: ctx("s", "e1", 1, 1) }, start(ctx("s", null, 1, 1)))).toBe(false);
    // Another title / episode: new.
    expect(newAttempt({ phase: "preparing", ctx: ctx("m") }, start(ctx("n")))).toBe(true);
    expect(newAttempt({ phase: "playing", ctx: ctx("s", "e1", 1, 1) }, start(ctx("s", null, 1, 2)))).toBe(true);
    expect(newAttempt({ phase: "playing", ctx: ctx("s", "e1") }, start(ctx("s", "e2")))).toBe(true);
    // The episode id arriving later is a "ctx" patch, never a new attempt.
    expect(newAttempt({ phase: "preparing", ctx: ctx("s") }, { type: "ctx" })).toBe(false);
  });

  it("a remounted / restarted screen's first frame starts at the resumed value, not 0", () => {
    let v: string | null = null;
    const store = { get: () => v, set: (x: string | null) => void (v = x) };
    const a = new LoadTracker(store);
    a.update("load|1", { stage: "metadata", title: "m|" }, 0);
    const shown = a.update("load|1", { stage: "metadata", title: "m|" }, 9000);
    expect(new LoadTracker(store).current("load|1", "m|", 10_000)).toBe(shown);
    expect(new LoadTracker(store).current("load|1", "other|", 10_000)).toBe(0);
  });
});
