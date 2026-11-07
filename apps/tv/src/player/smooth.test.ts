import { describe, expect, it } from "vitest";
import type { MediaInfo, Release } from "@martytv/contracts";
import { releaseSmoothToken, smoothClass, smoothToken } from "@martytv/media-types";
import { decodeCost, rankForTv, smootherInstead, sourceDecodeCost, sourceSmoothToken } from "./codecs";
import {
  COSTLY_FACTOR,
  decodingConfig,
  probeDecoding,
  provenSmooth,
  ROUGH_FACTOR,
  smoothFactor,
  smoothView,
  STUTTER0,
  STUTTER_TTL,
  stutterStep,
  type FrameSample,
  type StutterState,
} from "./smooth";

function release(p: Partial<Release> = {}): Release {
  return {
    id: "r1",
    title: "Movie.2019.1080p.WEB-DL.x264",
    indexer: "x",
    size_bytes: 8_000_000_000,
    seeders: 40,
    leechers: 2,
    published_at: null,
    info_hash: null,
    resolution: "1080p",
    video_codec: "h264",
    hdr: null,
    audio_codecs: ["aac"],
    languages: ["ru"],
    voiceovers: [],
    release_group: null,
    source_quality: "web-dl",
    year: 2019,
    seasons: [],
    episodes: [],
    is_season_pack: false,
    confidence: 0.95,
    score: 10,
    reasons: [],
    warnings: [],
    ...p,
  };
}

const uhdHdr = release({ id: "uhd", title: "Movie.2019.2160p.WEB-DL.HDR.x265", resolution: "2160p", video_codec: "hevc", hdr: "hdr10", score: 12 });
const uhd8 = release({ id: "uhd8", title: "Movie.2019.2160p.WEB-DL.x265", resolution: "2160p", video_codec: "hevc", score: 11 });
const fhdHevc = release({ id: "fhd-hevc", title: "Movie.2019.1080p.x265.10bit", resolution: "1080p", video_codec: "hevc", score: 10 });
const fhd = release({ id: "fhd", score: 9 });
const hd = release({ id: "hd", title: "Movie.2019.720p.x264", resolution: "720p", score: 8 });

describe("smooth tokens", () => {
  it("maps codec × 10-bit × 1080p / 2160p; lower resolutions and other codecs aren't judged", () => {
    expect(releaseSmoothToken(uhdHdr)).toBe("hevc_10bit_2160p");
    expect(releaseSmoothToken(uhd8)).toBe("hevc_2160p");
    expect(releaseSmoothToken(fhdHevc)).toBe("hevc_10bit_1080p");
    expect(releaseSmoothToken(fhd)).toBe("h264_1080p");
    expect(releaseSmoothToken(hd)).toBeNull();
    expect(releaseSmoothToken(release({ title: "Movie.1080p.Hi10P" }))).toBeNull();
    expect(releaseSmoothToken(release({ video_codec: "xvid" }))).toBeNull();
    expect(smoothToken("av1", true, "2160p")).toBe("av1_10bit_2160p");
    // Scope crop: 1920×800 is 1080p.
    expect(smoothClass(null, 1920, 800)).toBe("1080p");
    expect(smoothClass(null, 3840, 1600)).toBe("2160p");
    expect(smoothClass(null, 1280, 720)).toBeNull();
  });

  it("the playing file: the probed codec / bit depth / frame win over the release title", () => {
    const mi = { container: "matroska", video_codec: "hevc", width: 3840, height: 1600, duration_seconds: 7200, audio: [], subtitles: [], pix_fmt: "yuv420p10le" } as MediaInfo;
    const src = { media_info: mi, release: release({ title: "Movie.2160p", resolution: null, video_codec: null }) };
    expect(sourceSmoothToken(src)).toBe("hevc_10bit_2160p");
    expect(sourceDecodeCost(src)).toBe(32);
    expect(sourceSmoothToken({ media_info: null, release: fhd })).toBe("h264_1080p");
  });

  it("decodingInfo queries name the codec profile, frame and a typical bitrate", () => {
    const c = decodingConfig("hevc_10bit_2160p");
    expect(c.video.contentType).toBe('video/mp4; codecs="hvc1.2.4.L153.90"');
    expect([c.video.width, c.video.height]).toEqual([3840, 2160]);
    expect(decodingConfig("av1_1080p").video.contentType).toContain("av01.0.08M.08");
    expect(decodingConfig("h264_1080p", "media-source").type).toBe("media-source");
  });
});

describe("decodingInfo probe", () => {
  it("is null without the API (old engines behave as before)", async () => {
    expect(await probeDecoding(undefined)).toBeNull();
    expect(await probeDecoding({} as never)).toBeNull();
  });

  it("collects answers; a throwing type falls back to media-source, a hung one is unknown", async () => {
    const mc = {
      decodingInfo(cfg: unknown) {
        const c = cfg as { type: string; video: { contentType: string; height: number } };
        if (c.video.contentType.includes("av01")) return new Promise<never>(() => undefined);
        if (c.type === "file" && c.video.contentType.includes("avc1")) return Promise.reject(new TypeError("file"));
        const uhd = c.video.height > 1500;
        return Promise.resolve({ supported: true, smooth: !uhd, powerEfficient: !c.video.contentType.includes("hvc1.2") });
      },
    };
    const map = (await probeDecoding(mc, 5))!;
    expect(map.h264_1080p).toEqual({ supported: true, smooth: true, powerEfficient: true });
    expect(map.hevc_2160p?.smooth).toBe(false);
    expect(map.hevc_10bit_1080p).toEqual({ supported: true, smooth: true, powerEfficient: false });
    expect(map.av1_1080p).toBeUndefined();
  });
});

describe("smooth view and ranking", () => {
  const now = 1_000_000_000;
  it("rough = supported but not smooth, or a recent stutter; costly = smooth but not power-efficient", () => {
    const v = smoothView(
      {
        hevc_2160p: { supported: true, smooth: false, powerEfficient: false },
        av1_1080p: { supported: true, smooth: true, powerEfficient: false },
        av1_2160p: { supported: false, smooth: false, powerEfficient: false },
      },
      { h264_2160p: { n: 1, at: now - 1000 }, hevc_1080p: { n: 2, at: now - STUTTER_TTL - 1 } },
      now,
    );
    expect(v.rough).toEqual(["h264_2160p", "hevc_2160p"]);
    expect(v.costly).toEqual(["av1_1080p"]);
    // Nothing known: no factor anywhere.
    expect(smoothView(null, {}, now)).toEqual({ rough: [], costly: [] });
  });

  it("smooth releases rank first; nothing is hidden; no info keeps the server order", () => {
    const items = [uhdHdr, uhd8, fhdHevc, fhd];
    const view = { rough: ["hevc_10bit_2160p" as const, "hevc_2160p" as const], costly: [] };
    expect(smoothFactor(uhdHdr, view)).toBe(ROUGH_FACTOR);
    expect(smoothFactor(fhd, view)).toBe(1);
    expect(smoothFactor(fhd, { rough: [], costly: ["h264_1080p"] })).toBe(COSTLY_FACTOR);
    const ranked = rankForTv(items, { smooth: view }).map((r) => r.id);
    expect(ranked).toEqual(["fhd-hevc", "fhd", "uhd", "uhd8"]);
    expect(rankForTv(items, { smooth: { rough: [], costly: [] } }).map((r) => r.id)).toEqual(items.map((r) => r.id));
    expect(rankForTv(items, {}).map((r) => r.id)).toEqual(items.map((r) => r.id));
  });

  it("a lighter release: cheaper to decode and not rough; none → null", () => {
    expect(decodeCost(uhdHdr)).toBeGreaterThan(decodeCost(uhd8)!);
    expect(decodeCost(uhd8)).toBeGreaterThan(decodeCost(fhdHevc)!);
    expect(decodeCost(fhdHevc)).toBeGreaterThan(decodeCost(fhd)!);
    expect(decodeCost(release({ resolution: null }))).toBeNull();
    const items = [uhdHdr, uhd8, fhdHevc, fhd, hd];
    const view = { rough: ["hevc_10bit_1080p" as const], costly: [] };
    // From 4K HDR: the best-ranked lighter one that isn't rough (10-bit 1080p HEVC is).
    expect(smootherInstead(decodeCost(uhdHdr), items, ["uhd"], { smooth: view })?.id).toBe("uhd8");
    expect(smootherInstead(decodeCost(uhdHdr), items, ["uhd", "uhd8"], { smooth: view })?.id).toBe("fhd");
    expect(smootherInstead(decodeCost(hd), items, ["hd"], {})).toBeNull();
    expect(smootherInstead(null, items, [], {})).toBeNull();
  });
});

describe("stutter detector", () => {
  /** Samples every 2 s at 24 fps with `drop` of the frames dropped. */
  function run(n: number, drop: (i: number) => number, steady: (i: number) => boolean = () => true, s0: StutterState = STUTTER0) {
    let s = s0;
    let total = 0;
    let dropped = 0;
    let hit = -1;
    for (let i = 0; i < n; i++) {
      const frames = 48;
      total += frames;
      dropped += Math.round(frames * drop(i));
      const x: FrameSample = { at: i * 2000, total, dropped, steady: steady(i) };
      const r = stutterStep(s, x);
      s = r.state;
      if (r.stutter && hit < 0) hit = i;
    }
    return { s, hit };
  }

  it("fires after 30 s of sustained drops, not before", () => {
    const { hit } = run(40, () => 0.3);
    // 15 slices × 2 s = 30 s after the first sample.
    expect(hit).toBe(15);
  });

  it("clean playback, a single bad burst or a mild ratio never fire", () => {
    expect(run(200, () => 0.005).hit).toBe(-1);
    expect(run(200, (i) => (i >= 50 && i < 54 ? 0.9 : 0)).hit).toBe(-1);
    expect(run(200, () => 0.1).hit).toBe(-1);
  });

  it("unsteady samples (seek, buffering, pause) restart the window", () => {
    // Every 10th sample unsteady: the window never fills 30 s.
    expect(run(200, () => 0.4, (i) => i % 10 !== 0).hit).toBe(-1);
  });

  it("counter resets, long gaps and frame-less engines say nothing", () => {
    let s = stutterStep(STUTTER0, { at: 0, total: 1000, dropped: 500, steady: true }).state;
    // A new stream: counters back to 0.
    const r = stutterStep(s, { at: 2000, total: 40, dropped: 20, steady: true });
    expect(r.state.slices).toEqual([]);
    s = r.state;
    // Gap of 20 s (tab hidden, ticks paused).
    expect(stutterStep(s, { at: 22_000, total: 600, dropped: 300, steady: true }).state.slices).toEqual([]);
    // An engine that never counts frames (hardware overlay): total stays 0.
    expect(run(100, () => 0, () => true).hit).toBe(-1);
    let z = STUTTER0;
    for (let i = 0; i < 50; i++) z = stutterStep(z, { at: i * 2000, total: 0, dropped: 0, steady: true }).state;
    expect(z.okMs).toBe(0);
  });

  it("a long clean session proves the variant smooth again", () => {
    expect(provenSmooth(run(400, () => 0.005).s)).toBe(true);
    expect(provenSmooth(run(100, () => 0.005).s)).toBe(false);
    expect(provenSmooth(run(400, () => 0.05).s)).toBe(false);
  });
});
