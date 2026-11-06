import { describe, expect, it, vi } from "vitest";
import type { Release } from "@martytv/contracts";
import {
  bufferedSegments,
  classifyTap,
  CONTROLS_INIT,
  controlsReducer,
  decideStart,
  HIDE_AFTER,
  keyCommand,
  lateResume,
  LoadMeter,
  LoadTracker,
  mediaErrorKind,
  nextEpisode,
  packCovers,
  parseT,
  preloadTarget,
  rawProgress,
  seekBy,
  silentPlayback,
  stageOf,
  streamExpired,
  tapZone,
  watchUrl,
  type ControlsState,
} from "./logic";
import { ProgressReporter, REPORT_EVERY, SEEK_DEBOUNCE, type Clock, type ReportBody, type SessionStart, type Snapshot, type Transport } from "./reporter";

// ---------------------------------------------------------------- reporter

/** Manual clock: timers fire on advance(). */
function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  const clock: Clock = {
    setInterval: (fn, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn, every: ms });
      return id;
    },
    clearInterval: (h) => void timers.delete(h as number),
    setTimeout: (fn, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h) => void timers.delete(h as number),
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, t] = due;
      now = t.at;
      if (t.every) t.at += t.every;
      else timers.delete(id);
      t.fn();
    }
    now = end;
  };
  return { clock, advance };
}

function setup(opts: { start?: () => Promise<SessionStart>; result?: unknown } = {}) {
  const reports: ReportBody[] = [];
  const beacons: { body: ReportBody; token: string | null }[] = [];
  let resolveStart: (s: SessionStart) => void = () => undefined;
  const transport: Transport = {
    start: vi.fn(
      opts.start ??
        (() =>
          new Promise<SessionStart>((r) => {
            resolveStart = r;
          })),
    ),
    report: vi.fn(async (_id: string, body: ReportBody) => {
      reports.push(body);
      return (opts.result as never) ?? { accepted: true };
    }),
    beacon: vi.fn((_id: string, body: ReportBody, token: string | null) => void beacons.push({ body, token })),
  };
  const { clock, advance } = fakeClock();
  const rep = new ProgressReporter(transport, clock);
  const snap: Snapshot = { position: 100, duration: 3600, paused: false };
  const open = async () => {
    const p = rep.begin({ profile_id: "p", media_id: "m", source_id: "s" }, () => ({ ...snap }));
    resolveStart({ id: "sess", resume_position_seconds: null, progress: null, report_token: "tok" });
    await p;
  };
  return { rep, transport, reports, beacons, advance, snap, open, start: () => resolveStart };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ProgressReporter", () => {
  it("reports every 15 s while playing with increasing seq, not while paused", async () => {
    const h = setup();
    await h.open();
    h.advance(REPORT_EVERY);
    h.snap.position = 115;
    h.advance(REPORT_EVERY);
    h.snap.paused = true;
    h.advance(REPORT_EVERY * 2);
    await flush();
    expect(h.reports.map((r) => [r.seq, r.state, r.position_seconds])).toEqual([
      [1, "playing", 100],
      [2, "playing", 115],
    ]);
    expect(h.reports[0]!.duration_seconds).toBe(3600);
  });

  it("reports pause/play right away and debounces seeks into one report", async () => {
    const h = setup();
    await h.open();
    h.rep.report("playing");
    h.rep.report("playing"); // resumed after buffering: not news
    h.snap.paused = true;
    h.rep.report("paused");
    h.rep.seeked();
    h.snap.position = 500;
    h.rep.seeked();
    h.advance(SEEK_DEBOUNCE);
    await flush();
    expect(h.reports.map((r) => [r.seq, r.state, r.position_seconds])).toEqual([
      [1, "playing", 100],
      [2, "paused", 100],
      [3, "seeking", 500],
    ]);
  });

  it("keeps the latest report until the session is open", async () => {
    const h = setup();
    const p = h.rep.begin({ profile_id: "p", media_id: "m" }, () => ({ ...h.snap }));
    h.rep.report("playing");
    h.snap.paused = true;
    h.rep.report("paused");
    expect(h.transport.report).not.toHaveBeenCalled();
    h.start()({ id: "sess", resume_position_seconds: null, progress: null, report_token: "tok" });
    await p;
    await flush();
    expect(h.reports).toEqual([expect.objectContaining({ seq: 2, state: "paused" })]);
  });

  it("sends a beacon with the report token when the page is hidden", async () => {
    const h = setup();
    await h.open();
    h.rep.report("playing");
    h.rep.hidden();
    expect(h.beacons).toEqual([{ body: expect.objectContaining({ seq: 2, state: "paused", position_seconds: 100 }), token: "tok" }]);
  });

  it("ends with a final stopped report, skipped right after ended", async () => {
    const h = setup();
    await h.open();
    h.rep.report("playing");
    h.rep.end();
    await flush();
    expect(h.reports.at(-1)).toMatchObject({ seq: 2, state: "stopped" });
    expect(h.rep.active).toBe(false);

    const g = setup();
    await g.open();
    g.rep.report("ended");
    g.rep.report("paused"); // the element pauses itself at the end
    g.rep.end();
    await flush();
    expect(g.reports.map((r) => r.state)).toEqual(["ended"]);
  });

  it("stops for good on stale_session (another device took over)", async () => {
    const h = setup({ result: { accepted: false, reason: "stale_session", progress: null } });
    const onStale = vi.fn();
    h.rep.onStale = onStale;
    await h.open();
    h.rep.report("playing");
    await flush();
    h.advance(REPORT_EVERY * 3);
    h.rep.report("paused");
    h.rep.hidden();
    h.rep.end();
    await flush();
    expect(h.reports).toHaveLength(1);
    expect(h.beacons).toHaveLength(0);
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it("other refusals (stale_sequence, too_early) keep reporting", async () => {
    const h = setup({ result: { accepted: false, reason: "too_early", progress: null } });
    await h.open();
    h.rep.report("playing");
    await flush();
    h.advance(REPORT_EVERY);
    await flush();
    expect(h.reports.map((r) => r.seq)).toEqual([1, 2]);
  });

  it("never reports when the session can't be opened", async () => {
    const h = setup({ start: () => Promise.reject(new Error("404")) });
    await h.rep.begin({ profile_id: "p", media_id: "m" }, () => ({ ...h.snap }));
    h.rep.report("playing");
    h.advance(REPORT_EVERY);
    h.rep.end();
    await flush();
    expect(h.transport.report).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- resume

describe("where to start", () => {
  const p = (position_seconds: number, o: { completed?: boolean; duration_seconds?: number | null } = {}) => ({
    position_seconds,
    duration_seconds: o.duration_seconds ?? 7200,
    completed: o.completed ?? false,
  });

  it("t from the URL wins", () => {
    expect(decideStart(0, p(2530))).toEqual({ kind: "start", at: 0 });
    expect(decideStart(2530, null)).toEqual({ kind: "start", at: 2530 });
  });

  it("asks for an unfinished item ≥ 30 s in", () => {
    expect(decideStart(null, p(2530))).toEqual({ kind: "ask", at: 2530 });
    expect(decideStart(null, p(12))).toEqual({ kind: "start", at: 0 });
    expect(decideStart(null, p(7198))).toEqual({ kind: "start", at: 0 });
    expect(decideStart(null, p(4000, { completed: true }))).toEqual({ kind: "start", at: 0 });
    expect(decideStart(null, null)).toEqual({ kind: "start", at: 0 });
  });

  it("applies the session's resume point only when progress was unknown and near the start", () => {
    expect(lateResume(false, 600, 2)).toBe(600);
    expect(lateResume(true, 600, 2)).toBeNull();
    expect(lateResume(false, 600, 300)).toBeNull();
    expect(lateResume(false, 10, 0)).toBeNull();
    expect(lateResume(false, null, 0)).toBeNull();
  });

  it("parses t", () => {
    expect(parseT("42")).toBe(42);
    expect(parseT("0")).toBe(0);
    expect(parseT("-3")).toBeNull();
    expect(parseT("x")).toBeNull();
    expect(parseT(null)).toBeNull();
  });
});

// ---------------------------------------------------------------- controls

describe("controls", () => {
  const tick = (s: ControlsState, now: number, o: { playing?: boolean; busy?: boolean } = {}) =>
    controlsReducer(s, { type: "tick", now, playing: o.playing ?? true, busy: o.busy ?? false });

  it("hide 3 s after the last activity while playing", () => {
    let s = controlsReducer(CONTROLS_INIT, { type: "activity", now: 1000 });
    s = tick(s, 1000 + HIDE_AFTER - 1);
    expect(s.visible).toBe(true);
    s = tick(s, 1000 + HIDE_AFTER);
    expect(s.visible).toBe(false);
    s = controlsReducer(s, { type: "activity", now: 9000 });
    expect(s.visible).toBe(true);
  });

  it("stay while paused, scrubbing or with a menu open", () => {
    const s = controlsReducer(CONTROLS_INIT, { type: "activity", now: 0 });
    expect(tick(s, 10_000, { playing: false }).visible).toBe(true);
    expect(tick(s, 10_000, { busy: true }).visible).toBe(true);
    const m = controlsReducer(s, { type: "menu", menu: "speed", now: 0 });
    expect(m.menu).toBe("speed");
    expect(tick(m, 10_000).visible).toBe(true);
    expect(controlsReducer(m, { type: "menu", menu: "speed", now: 1 }).menu).toBeNull();
  });

  it("toggle hides and closes menus, shows again", () => {
    const m = controlsReducer(CONTROLS_INIT, { type: "menu", menu: "audio", now: 0 });
    const hidden = controlsReducer(m, { type: "toggle", now: 5 });
    expect(hidden).toMatchObject({ visible: false, menu: null });
    expect(controlsReducer(hidden, { type: "toggle", now: 6 }).visible).toBe(true);
  });

  it("maps keyboard shortcuts", () => {
    expect(keyCommand(" ")).toEqual({ type: "toggle" });
    expect(keyCommand("k")).toEqual({ type: "toggle" });
    expect(keyCommand("ArrowLeft")).toEqual({ type: "seek", delta: -10 });
    expect(keyCommand("ArrowRight")).toEqual({ type: "seek", delta: 30 });
    expect(keyCommand("f")).toEqual({ type: "fullscreen" });
    expect(keyCommand("M")).toEqual({ type: "mute" });
    expect(keyCommand("ArrowUp")).toEqual({ type: "volume", delta: 0.1 });
    expect(keyCommand("x")).toBeNull();
  });

  it("double tap on a side seeks, center taps are single", () => {
    expect(tapZone(10, 300)).toBe("left");
    expect(tapZone(150, 300)).toBe("center");
    expect(tapZone(290, 300)).toBe("right");
    expect(classifyTap(null, { t: 0, zone: "left" })).toBe("single");
    expect(classifyTap({ t: 0, zone: "left" }, { t: 200, zone: "left" })).toBe("double");
    expect(classifyTap({ t: 0, zone: "left" }, { t: 500, zone: "left" })).toBe("single");
    expect(classifyTap({ t: 0, zone: "left" }, { t: 100, zone: "right" })).toBe("single");
    expect(classifyTap({ t: 0, zone: "center" }, { t: 100, zone: "center" })).toBe("single");
  });

  it("seeks within the file and draws buffered ranges", () => {
    expect(seekBy(5, -10, 100)).toBe(0);
    expect(seekBy(95, 30, 100)).toBe(100);
    expect(seekBy(95, 30, NaN)).toBe(125);
    expect(bufferedSegments([[0, 25], [50, 200]], 100)).toEqual([
      { left: 0, width: 25 },
      { left: 50, width: 50 },
    ]);
    expect(bufferedSegments([[0, 10]], 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------- errors & sound

describe("errors and silent playback", () => {
  it("classifies media errors", () => {
    expect(mediaErrorKind(4)).toBe("unsupported");
    expect(mediaErrorKind(3)).toBe("decode");
    expect(mediaErrorKind(2)).toBe("network");
    expect(mediaErrorKind(1)).toBe("aborted");
  });

  it("detects video without decoded audio where the engine tells", () => {
    expect(silentPlayback({ webkitAudioDecodedByteCount: 0 })).toBe(true);
    expect(silentPlayback({ webkitAudioDecodedByteCount: 4096 })).toBe(false);
    expect(silentPlayback({ mozHasAudio: false })).toBe(true);
    expect(silentPlayback({ audioTracks: 0 })).toBe(true);
    expect(silentPlayback({ audioTracks: 2 })).toBe(false);
    expect(silentPlayback({})).toBeNull();
  });

  it("knows when a stream token expires", () => {
    const now = Date.parse("2026-10-29T12:00:00Z");
    expect(streamExpired("2026-10-29T12:00:30Z", now)).toBe(true);
    expect(streamExpired("2026-10-29T13:00:00Z", now)).toBe(false);
    expect(streamExpired(null, now)).toBe(false);
  });
});

// ---------------------------------------------------------------- loading

describe("first-load progress", () => {
  it("follows the stages and never goes backwards", () => {
    expect(stageOf("resolving", null)).toBe("resolving");
    expect(stageOf("source", null)).toBe("creating");
    expect(stageOf("source", { status: "preparing", torrent: null })).toBe("metadata");
    expect(stageOf("source", { status: "preparing", torrent: { peers: 3, seeders: 1, download_speed_bps: 1, preloaded_bytes: 1 } })).toBe("preloading");
    expect(stageOf("source", { status: "ready", torrent: null })).toBe("starting");
    const half = rawProgress({
      stage: "preloading",
      stageMs: 0,
      source: { torrent: { peers: 1, seeders: 1, download_speed_bps: 1, preloaded_bytes: preloadTarget(null) / 2 }, file: null, release: { size_bytes: 0 } as Release },
    });
    expect(half).toBeCloseTo(0.6, 5);
    expect(rawProgress({ stage: "metadata", stageMs: 60_000 })).toBeLessThan(0.35);
    expect(rawProgress({ stage: "starting", stageMs: 0, metadata: true })).toBeGreaterThan(0.9);
    const m = new LoadMeter();
    expect(m.update(0.5)).toBe(0.5);
    expect(m.update(0.2)).toBe(0.5);
    expect(m.update(2)).toBe(1);
  });

  it("LoadTracker: monotonic through stage flapping and a growing preload target; another source starts over", () => {
    const MB = 1024 * 1024;
    const tor = (n: number) => ({ peers: 1, seeders: 1, download_speed_bps: 1, preloaded_bytes: n });
    const src = (id: string, n: number | null, size: number | null) =>
      ({ id, torrent: n === null ? null : tor(n), file: size === null ? null : { index: 0, path: "x", size_bytes: size, is_video: true, season: null, episode: null }, release: { size_bytes: 0 } as Release }) as never;
    const t = new LoadTracker();
    const seq: number[] = [];
    let now = 0;
    const step = (stage: Parameters<typeof rawProgress>[0]["stage"], s: unknown = null, metadata = false) =>
      seq.push(t.update({ stage, source: s as never, sourceId: (s as { id?: string } | null)?.id ?? null, metadata }, (now += 400)));
    step("resolving");
    step("creating");
    step("metadata", src("s1", null, null));
    step("preloading", src("s1", 12 * MB, null));
    step("preloading", src("s1", 13 * MB, 40_000 * MB)); // target 16 → 32 MB
    step("metadata", src("s1", null, 40_000 * MB)); // a poll without stats
    step("preloading", src("s1", 31 * MB, 40_000 * MB));
    step("starting", src("s1", 32 * MB, 40_000 * MB), true);
    expect(seq.every((x, i) => i === 0 || x >= seq[i - 1]!)).toBe(true);
    expect(seq[seq.length - 1]!).toBeGreaterThan(0.9);
    expect(t.update({ stage: "metadata", source: src("s2", null, null), sourceId: "s2" }, (now += 400))).toBeLessThan(0.2);
  });
});

// ---------------------------------------------------------------- next episode & URLs

describe("next episode", () => {
  const eps = [1, 2, 3].map((n) => ({ id: `e${n}`, season_number: 1, episode_number: n, name: `Ep ${n}`, air_date: "2020-01-01" }));
  const seasons = [{ season_number: 1 }, { season_number: 2, air_date: "2021-01-01" }];

  it("goes to the next aired episode, then the next season", () => {
    expect(nextEpisode({ season: 1, episode: 1 }, eps, seasons, undefined, "2026-01-01")).toEqual({ season: 1, episode: 2, id: "e2", name: "Ep 2" });
    expect(nextEpisode({ season: 1, episode: 3 }, eps, seasons, undefined, "2026-01-01")).toEqual({ season: 2, episode: 1 });
    const s2 = [{ id: "s2e1", season_number: 2, episode_number: 1, air_date: "2021-01-01" }];
    expect(nextEpisode({ season: 1, episode: 3 }, eps, seasons, s2, "2026-01-01")).toMatchObject({ season: 2, episode: 1, id: "s2e1" });
    const unaired = [...eps.slice(0, 2), { ...eps[2]!, air_date: "2030-01-01" }];
    expect(nextEpisode({ season: 1, episode: 2 }, unaired, seasons, undefined, "2026-01-01")).toBeNull();
    expect(nextEpisode({ season: 0, episode: 9 }, [], seasons)).toBeNull();
  });

  it("reuses a season pack that covers the next episode", () => {
    expect(packCovers({ is_season_pack: true, seasons: [1], episodes: [] }, 1, 4)).toBe(true);
    expect(packCovers({ is_season_pack: true, seasons: [1], episodes: [] }, 2, 1)).toBe(false);
    expect(packCovers({ is_season_pack: false, seasons: [1], episodes: [3] }, 1, 3)).toBe(false);
  });

  it("builds player URLs", () => {
    expect(watchUrl({ media_id: "m" })).toBe("/watch/new?media=m");
    expect(watchUrl({ media_id: "m", episode_id: "e", season_number: 1, episode_number: 2 }, { sourceId: "src", t: 42.7, release: "r", attempt: 2 })).toBe(
      "/watch/src?media=m&episode=e&s=1&e=2&release=r&t=42&try=2",
    );
  });
});
