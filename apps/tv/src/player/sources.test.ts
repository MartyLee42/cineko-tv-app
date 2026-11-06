import { describe, expect, it, vi } from "vitest";
import type { PlaybackSource, Release } from "@martytv/contracts";
import { variantRelease } from "@martytv/media-types";
import { assessSource, type Probe } from "./codecs";
import { pickerScroll, PITCH } from "./pickerLayout";
import { hlsConfig, reloadUrl, streamMode } from "./stream";

const MOVIE = "11111111-2222-4333-8444-555555555555";

const variant = {
  id: "oabc",
  provider: { id: "anilibria", name: "AniLiberty", kind: "anime" as const },
  voice: "AniLibria",
  voiceover: { kind: "mvo" as const, studio: "AniLibria", language: "ru" },
  title: "Episode 3",
  max_quality: 1080,
  qualities: [1080, 720, 480],
  format: "hls" as const,
  subtitle_langs: [],
  season: 1,
  episode: 3,
  episodes: [],
  preferred: true,
  score: 1,
};

function online(p: Partial<PlaybackSource> = {}): PlaybackSource {
  return {
    id: "s-online",
    media_id: MOVIE,
    episode_id: null,
    release: variantRelease(variant) as Release,
    status: "ready",
    error: null,
    file: null,
    stream_url: "/api/v1/stream/tok1/index.m3u8",
    stream_expires_at: null,
    mime_type: "application/vnd.apple.mpegurl",
    media_info: null,
    torrent: null,
    created_at: "2026-01-01T00:00:00Z",
    kind: "online",
    format: "hls",
    quality: 1080,
    qualities: [1080, 720, 480],
    subtitles: [],
    duration_seconds: 1420,
    ...p,
  };
}

const nativeHls: Probe = { canPlayType: (t) => (t.includes("mpegurl") || t.includes("mpegURL") ? "maybe" : "") };
const mseOnly: Probe = { canPlayType: () => "", isTypeSupported: () => true };
const nothing: Probe = { canPlayType: () => "" };

describe("online HLS on TV engines", () => {
  it("prefers the engine's native HLS, else hls.js with MSE, else none", () => {
    expect(streamMode(online(), nativeHls, true)).toBe("native");
    expect(streamMode(online(), nothing, true)).toBe("hlsjs");
    expect(streamMode(online(), nothing, false)).toBe("none");
    // Torrent / MP4 sources never go through hls.js.
    expect(streamMode({ format: null, mime_type: "video/mp4" }, nothing, true)).toBe("native");
    expect(streamMode({ format: "mp4", mime_type: "video/mp4" }, nothing, true)).toBe("native");
  });

  it("doesn't warn about the HLS MIME type where HLS can play", () => {
    expect(assessSource(online(), nativeHls).verdict).toBe("ok");
    expect(assessSource(online(), mseOnly).verdict).toBe("ok");
    const none = assessSource(online(), nothing);
    expect(none.verdict).toBe("unlikely");
    expect(none.unsupported).toEqual(["HLS"]);
    expect(none.avoid).toEqual([]);
  });

  it("forces a reload when a quality switch returns the same URL", () => {
    expect(reloadUrl("/s/b/index.m3u8", "/s/a/index.m3u8", 720)).toBe("/s/b/index.m3u8");
    expect(reloadUrl("/s/a/index.m3u8", "/s/a/index.m3u8", 720)).toBe("/s/a/index.m3u8?q=720");
  });

  it("maps a variant to a playable release (id = variant id)", () => {
    const r = variantRelease(variant);
    expect(r.id).toBe("oabc");
    expect(r.resolution).toBe("1080p");
    expect(r.voiceovers[0]!.studio).toBe("AniLibria");
    expect(r.episodes).toEqual([3]);
    expect(r.provider.kind).toBe("anime");
  });
});

describe("picker scroll", () => {
  it("keeps the torrent-only behaviour without online rows", () => {
    expect(pickerScroll({ kind: "rel", i: 0 }, 0, 10, false)).toBe(0);
    expect(pickerScroll({ kind: "rel", i: 3 }, 0, 10, false)).toBe(2 * PITCH);
  });

  it("scrolls past the online group to a torrent row", () => {
    expect(pickerScroll({ kind: "onl", i: 0 }, 2, 10, false)).toBe(0);
    const t5 = pickerScroll({ kind: "rel", i: 5 }, 2, 10, false);
    expect(t5).toBeGreaterThan(pickerScroll({ kind: "rel", i: 0 }, 2, 10, false));
  });
});

// ---------------------------------------------------------------- controller: quality switch

const mocks = vi.hoisted(() => ({ quality: 480 }));
vi.mock("../api", () => ({ api: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), PUT: vi.fn() }, realtime: { reconnectNow: () => undefined } }));
vi.mock("./data", async (orig) => {
  const real = await orig<typeof import("./data")>();
  return {
    ...real,
    createSource: vi.fn(async () => online()),
    getSource: vi.fn(async () => online()),
    patchQuality: vi.fn(async () => online({ quality: mocks.quality, stream_url: "/api/v1/stream/tok2/index.m3u8" })),
  };
});

class FakeVideo extends EventTarget {
  currentTime = 0;
  duration = 1420;
  paused = true;
  ended = false;
  seeking = false;
  readyState = 4;
  volume = 1;
  error = null;
  src = "";
  textTracks = { length: 0 };
  canPlayType(t: string) {
    return t.includes("mpegurl") ? "maybe" : "";
  }
  load() {}
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute(n: string) {
    if (n === "src") this.src = "";
  }
}

describe("controller quality switch", () => {
  it("loads the new URL and continues at the same position", async () => {
    const { PlayerController } = await import("./controller");
    const transport = { start: async () => ({ id: "sess", resume_position_seconds: null, progress: null, report_token: null }), report: async () => null, beacon: () => undefined };
    const c = new PlayerController(Date.now, transport as never);
    const v = new FakeVideo();
    c.attach(v as unknown as HTMLVideoElement);
    const ctx = { media_id: MOVIE, kind: "movie" as const, title: "T", poster_path: null, backdrop_path: null, season: null, episode: null, episode_id: null, episode_name: null, profile_id: "p", lang: "en" as const, player: "builtin" as const, app: null };
    c.playRelease(ctx, variantRelease(variant) as Release);
    await vi.waitFor(() => expect(c.flow.phase).toBe("playing"));
    expect(v.src).toBe("/api/v1/stream/tok1/index.m3u8");
    expect(c.qualities()).toEqual({ list: [1080, 720, 480], current: 1080 });
    // Watched a while, playing.
    v.dispatchEvent(new Event("loadedmetadata"));
    v.currentTime = 600;
    v.dispatchEvent(new Event("timeupdate"));
    expect(await c.setQuality(480)).toBe(true);
    expect(v.src).toBe("/api/v1/stream/tok2/index.m3u8");
    expect(c.qualities()?.current).toBe(480);
    // The new stream seeks back to 600 s once its metadata is known.
    expect(c.position()).toBe(600);
    v.currentTime = 0;
    v.dispatchEvent(new Event("loadedmetadata"));
    expect(v.currentTime).toBe(600);
    expect(v.paused).toBe(false);
    // Online sources: the provider's duration stands in for ffprobe's.
    v.duration = NaN;
    expect(c.duration()).toBe(1420);
    c.close();
  });
});

describe("progress session vs a late <video>", () => {
  it("playing before the player view mounts (lazy chunk, fast media.play) still reports", async () => {
    const { PlayerController } = await import("./controller");
    const reports: { state: string; position_seconds: number }[] = [];
    let starts = 0;
    const transport = {
      start: async () => (starts++, { id: "sess", resume_position_seconds: null, progress: null, report_token: null }),
      report: async (_id: string, b: { state: string; position_seconds: number }) => (reports.push(b), { accepted: true }),
      beacon: () => undefined,
    };
    const c = new PlayerController(Date.now, transport as never);
    const ctx = { media_id: MOVIE, kind: "movie" as const, title: "T", poster_path: null, backdrop_path: null, season: null, episode: null, episode_id: null, episode_name: null, profile_id: "p", lang: "en" as const, player: "builtin" as const, app: null };
    c.playRelease(ctx, variantRelease(variant) as Release);
    // The source is ready (session opened) while no <video> exists yet.
    await vi.waitFor(() => expect(c.flow.phase).toBe("playing"));
    await vi.waitFor(() => expect(starts).toBe(1));
    const v = new FakeVideo();
    c.attach(v as unknown as HTMLVideoElement);
    expect(v.src).toBe("/api/v1/stream/tok1/index.m3u8");
    v.dispatchEvent(new Event("loadedmetadata"));
    v.currentTime = 50;
    v.paused = false;
    v.dispatchEvent(new Event("playing"));
    v.paused = true;
    v.dispatchEvent(new Event("pause"));
    await vi.waitFor(() => expect(reports.map((r) => r.state)).toEqual(["playing", "paused"]));
    expect(reports[1]!.position_seconds).toBe(50);
    expect(starts).toBe(1);

    // A new view of the same playback (the old <video> detached): a new session, reports go on.
    c.detach();
    const v2 = new FakeVideo();
    c.attach(v2 as unknown as HTMLVideoElement);
    await vi.waitFor(() => expect(starts).toBe(2));
    v2.dispatchEvent(new Event("loadedmetadata"));
    v2.paused = false;
    v2.dispatchEvent(new Event("playing"));
    await vi.waitFor(() => expect(reports.at(-1)?.state).toBe("playing"));
    c.close();
  });
});

// ---------------------------------------------------------------- controller: seeks that land late / get dropped

describe("controller seeks", () => {
  const ctx = { media_id: MOVIE, kind: "movie" as const, title: "T", poster_path: null, backdrop_path: null, season: null, episode: null, episode_id: null, episode_name: null, profile_id: "p", lang: "en" as const, player: "builtin" as const, app: null };
  const transport = { start: async () => ({ id: "sess", resume_position_seconds: null, progress: null, report_token: null }), report: async () => null, beacon: () => undefined };

  it("a slow forward seek (lands after 8 s) stays where the user chose — no bounce back to the old spot", async () => {
    const { PlayerController } = await import("./controller");
    const c = new PlayerController(Date.now, transport as never);
    const v = new FakeVideo();
    v.duration = 9133;
    c.attach(v as unknown as HTMLVideoElement);
    c.playRelease(ctx, variantRelease(variant) as Release);
    await vi.waitFor(() => expect(c.flow.phase).toBe("playing"));
    const src = v.src;
    v.dispatchEvent(new Event("loadedmetadata"));
    v.paused = false;
    v.dispatchEvent(new Event("playing"));
    for (let t = 0; t <= 4796; t += 2) {
      v.currentTime = t;
      v.dispatchEvent(new Event("timeupdate"));
    }
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0 + 20_000);
    try {
      expect(c.seekTo(6000)).toBe(true);
      expect(v.currentTime).toBe(6000);
      // The engine takes 12 s to fetch the new segments.
      v.seeking = true;
      now.mockReturnValue(t0 + 32_000);
      v.seeking = false;
      v.dispatchEvent(new Event("seeked"));
      v.dispatchEvent(new Event("timeupdate"));
      expect(c.recovering()).toBe(false);
      expect(c.position()).toBe(6000);
      expect(c.trustedPosition()).toBe(6000);
      expect(v.src).toBe(src);
      // A real unexplained skip from the new spot is still caught.
      now.mockReturnValue(t0 + 60_000);
      v.currentTime = 6200;
      v.dispatchEvent(new Event("timeupdate"));
      expect(c.recovering()).toBe(true);
      expect(c.trustedPosition()).toBe(6000);
    } finally {
      now.mockRestore();
      c.close();
    }
  });

  it("a backward seek moves the trusted spot back (a later recovery doesn't jump forward)", async () => {
    const { PlayerController } = await import("./controller");
    const c = new PlayerController(Date.now, transport as never);
    const v = new FakeVideo();
    c.attach(v as unknown as HTMLVideoElement);
    c.playRelease(ctx, variantRelease(variant) as Release);
    await vi.waitFor(() => expect(c.flow.phase).toBe("playing"));
    v.dispatchEvent(new Event("loadedmetadata"));
    for (let t = 0; t <= 900; t += 2) {
      v.currentTime = t;
      v.dispatchEvent(new Event("timeupdate"));
    }
    c.seekTo(100);
    v.dispatchEvent(new Event("timeupdate"));
    // The stream breaks right away ("ended" far before the end): continue at 100, not 900.
    v.dispatchEvent(new Event("ended"));
    expect(c.recovering()).toBe(true);
    expect(c.trustedPosition()).toBe(100);
    c.close();
  });

  it("the start position waits for a known duration, and is re-applied once if the engine dropped it", async () => {
    const { PlayerController } = await import("./controller");
    const c = new PlayerController(Date.now, transport as never);
    const v = new FakeVideo();
    c.attach(v as unknown as HTMLVideoElement);
    c.playRelease(ctx, variantRelease(variant) as Release);
    await vi.waitFor(() => expect(c.flow.phase).toBe("playing"));
    v.dispatchEvent(new Event("loadedmetadata"));
    v.currentTime = 600;
    v.dispatchEvent(new Event("timeupdate"));
    expect(await c.setQuality(480)).toBe(true);
    // The new stream: no duration yet at loadedmetadata (NaN) — the seek waits.
    v.currentTime = 0;
    v.duration = NaN;
    v.dispatchEvent(new Event("loadedmetadata"));
    expect(v.currentTime).toBe(0);
    expect(c.position()).toBe(600);
    v.duration = 1420;
    v.dispatchEvent(new Event("durationchange"));
    expect(v.currentTime).toBe(600);
    // The engine ignored it and started at 0: once more when it plays.
    v.currentTime = 0;
    v.dispatchEvent(new Event("playing"));
    expect(v.currentTime).toBe(600);
    // Only once (no fight with an engine that can't seek).
    v.currentTime = 0;
    v.dispatchEvent(new Event("timeupdate"));
    expect(v.currentTime).toBe(0);
    c.close();
  });
});

describe("online HLS on Android", () => {
  it("prefers hls.js over Android's native HLS when MSE exists", () => {
    expect(streamMode(online(), nativeHls, true, true)).toBe("hlsjs");
    expect(streamMode(online(), nativeHls, false, true)).toBe("native");
    expect(streamMode({ format: "mp4", mime_type: "video/mp4" }, nativeHls, true, true)).toBe("native");
  });

  it("hls.js starts at the resume position with capped buffers", () => {
    expect(hlsConfig(4796)).toMatchObject({ startPosition: 4796, maxBufferLength: 30, backBufferLength: 30 });
    expect(hlsConfig(0).startPosition).toBe(-1);
    expect(hlsConfig(0).maxBufferSize).toBeLessThanOrEqual(30_000_000);
  });
});

describe("dead torrent", () => {
  it("gives up on a release with no connected peer and no data for 30 s", async () => {
    const { PlayerController, DEAD_TORRENT_MS } = await import("./controller");
    const transport = { start: async () => ({ id: "sess", resume_position_seconds: null, progress: null, report_token: null }), report: async () => null, beacon: () => undefined };
    const c = new PlayerController(Date.now, transport as never);
    const ctx = { media_id: MOVIE, kind: "movie" as const, title: "T", poster_path: null, backdrop_path: null, season: null, episode: null, episode_id: null, episode_name: null, profile_id: "p", lang: "en" as const, player: "builtin" as const, app: null };
    c.playRelease(ctx, variantRelease(variant) as Release);
    await vi.waitFor(() => expect(c.flow.phase).toBe("playing"));
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now");
    const dead = { peers: 0, seeders: 0, download_speed_bps: 0, preloaded_bytes: 0 } as PlaybackSource["torrent"];
    const live = { ...dead, peers: 2 } as PlaybackSource["torrent"];
    try {
      now.mockReturnValue(t0);
      c.reportLoad("k", 0, dead);
      // A peer shows up meanwhile: the clock restarts.
      now.mockReturnValue(t0 + DEAD_TORRENT_MS - 1000);
      c.reportLoad("k", 0, live);
      now.mockReturnValue(t0 + DEAD_TORRENT_MS + 5000);
      c.reportLoad("k", 0, dead);
      expect(c.flow.phase).toBe("playing");
      now.mockReturnValue(t0 + 2 * DEAD_TORRENT_MS + 6000);
      c.reportLoad("k", 0, dead);
      // No cached release list here: falls back to the picker, the dead release marked as tried.
      expect(c.flow.phase).not.toBe("playing");
      expect("tried" in c.flow && c.flow.tried).toContain((variantRelease(variant) as Release).id);
    } finally {
      now.mockRestore();
      c.close();
    }
  });
});

describe("first load stuck before a frame", () => {
  it("reopens the stream with a fresh URL, waiting longer each time, never failing", async () => {
    const data = await import("./data");
    let n = 0;
    const torrent = () =>
      online({ id: "s-tor", kind: "torrent", format: undefined, mime_type: "video/mp4", stream_url: `/api/v1/stream/t${++n}`, qualities: [], quality: null });
    vi.mocked(data.createSource).mockImplementation(async () => torrent());
    vi.mocked(data.getSource).mockImplementation(async () => torrent());
    const { PlayerController, FIRST_LOAD_STUCK_MS } = await import("./controller");
    const transport = { start: async () => ({ id: "sess", resume_position_seconds: null, progress: null, report_token: null }), report: async () => null, beacon: () => undefined };
    const c = new PlayerController(Date.now, transport as never);
    const v = new FakeVideo();
    v.canPlayType = () => "maybe";
    v.readyState = 1;
    c.attach(v as unknown as HTMLVideoElement);
    const ctx = { media_id: MOVIE, kind: "movie" as const, title: "T", poster_path: null, backdrop_path: null, season: null, episode: null, episode_id: null, episode_name: null, profile_id: "p", lang: "en" as const, player: "builtin" as const, app: null };
    c.playRelease(ctx, variantRelease(variant) as Release);
    await vi.waitFor(() => expect(c.flow.phase).toBe("playing"));
    await vi.waitFor(() => expect(v.src).toMatch(/\/api\/v1\/stream\/t\d+$/));
    const first = v.src;
    const tick = () => (c as unknown as { tick(): void }).tick();
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(t0);
      tick();
      now.mockReturnValue(t0 + FIRST_LOAD_STUCK_MS - 1000);
      tick();
      expect(v.src).toBe(first);
      now.mockReturnValue(t0 + FIRST_LOAD_STUCK_MS + 1000);
      tick();
      await vi.waitFor(() => expect(v.src).not.toBe(first));
      const second = v.src;
      // The next try waits twice as long; still playing (no failure screen).
      const t1 = t0 + FIRST_LOAD_STUCK_MS + 1000;
      now.mockReturnValue(t1);
      tick();
      now.mockReturnValue(t1 + FIRST_LOAD_STUCK_MS + 1000);
      tick();
      expect(v.src).toBe(second);
      now.mockReturnValue(t1 + 2 * FIRST_LOAD_STUCK_MS + 1000);
      tick();
      await vi.waitFor(() => expect(v.src).not.toBe(second));
      expect(c.flow.phase).toBe("playing");
      // Signs of life (data buffered) restart the clock.
      v.readyState = 2;
      const t2 = t1 + 2 * FIRST_LOAD_STUCK_MS + 1000;
      now.mockReturnValue(t2);
      tick();
      const third = v.src;
      now.mockReturnValue(t2 + 3 * FIRST_LOAD_STUCK_MS - 1000);
      tick();
      expect(v.src).toBe(third);
    } finally {
      now.mockRestore();
      vi.mocked(data.createSource).mockImplementation(async () => online());
      vi.mocked(data.getSource).mockImplementation(async () => online());
      c.close();
    }
  });
});
