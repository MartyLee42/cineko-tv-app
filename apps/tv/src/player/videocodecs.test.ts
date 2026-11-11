import { describe, expect, it } from "vitest";
import type { MediaInfo, PlaybackSource, Release } from "@martytv/contracts";
import { assessRelease, assessSource, decodeFailure, errorRetries, nextRelease, rankForTv, releaseVideoKey, usesCodec, videoKey, videoUndecodable, type Probe } from "./codecs";

function release(p: Partial<Release> = {}): Release {
  return {
    id: "r1",
    title: "Movie.2019.1080p.BDRip.x264",
    indexer: "x",
    size_bytes: 8_000_000_000,
    seeders: 40,
    leechers: 2,
    published_at: null,
    info_hash: null,
    resolution: "1080p",
    video_codec: "h264",
    hdr: null,
    audio_codecs: ["ac3"],
    languages: ["ru"],
    voiceovers: [],
    release_group: null,
    source_quality: "bdrip",
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

function info(video: string, p: Partial<MediaInfo> = {}): MediaInfo {
  return {
    container: "matroska,webm",
    video_codec: video,
    width: 1920,
    height: 1080,
    duration_seconds: 7200,
    audio: [{ index: 1, codec: "ac3", language: "rus", title: null, channels: 6, default: true }],
    subtitles: [],
    ...p,
  };
}

const src = (mi: MediaInfo, p: Partial<PlaybackSource> = {}) => ({ mime_type: "video/x-matroska", media_info: mi, release: release(), ...p });

/**
 * A Tizen 5.5-like engine (the «Living Room» TV): H.264 8-bit, HEVC Main / Main 10
 * firmly; "maybe" for bare AVI/MPEG types; nothing for High 10, MPEG-4 Part 2.
 */
const tizen: Probe = {
  canPlayType(t) {
    if (/avc1\.(64|4d|42)/i.test(t) || /hvc1\.[12]\.|hev1\.[12]\./.test(t)) return "probably";
    if (t === "video/mp4" || t.startsWith("video/x-matroska") || t.startsWith("audio/mp4; codecs=\"mp4a") || t.includes("ac-3")) return "maybe";
    if (t === "video/x-msvideo" || t === "video/avi" || t.startsWith("video/mpeg")) return "maybe";
    return "";
  },
};
/** An engine without HEVC Main 10 (8-bit HEVC only). */
const old: Probe = {
  canPlayType: (t) => (/avc1\.(64|4d|42)/i.test(t) || /hvc1\.1\.|hev1\.1\./.test(t) ? "probably" : t === "video/mp4" || t.startsWith("video/x-matroska") ? "maybe" : ""),
};
/** A sloppy engine that says "maybe" to everything (WebView): firm-only codecs still fail. */
const sloppy: Probe = { canPlayType: () => "maybe" };
/** A desktop browser decoding High 10 in software. */
const desktop: Probe = { canPlayType: (t) => (t.includes("avc1") ? "probably" : t === "video/mp4" || t.startsWith("video/webm") || t.includes("mp4a") ? "maybe" : "") };

describe("video profile keys", () => {
  it("refines H.264 / HEVC by profile, bit depth and chroma", () => {
    expect(videoKey(info("h264", { video_profile: "High", pix_fmt: "yuv420p", bit_depth: 8 }))).toBe("h264");
    expect(videoKey(info("h264", { video_profile: "High 10", pix_fmt: "yuv420p10le", bit_depth: 10 }))).toBe("h264_10bit");
    expect(videoKey(info("h264", { pix_fmt: "yuv420p10le" }))).toBe("h264_10bit");
    expect(videoKey(info("h264", { video_profile: "High 10" }))).toBe("h264_10bit");
    expect(videoKey(info("h264", { video_profile: "High 4:2:2", pix_fmt: "yuv422p10le" }))).toBe("h264_422");
    expect(videoKey(info("h264", { video_profile: "High 4:4:4 Predictive", pix_fmt: "yuv444p" }))).toBe("h264_444");
    expect(videoKey(info("hevc", { video_profile: "Main", pix_fmt: "yuv420p" }))).toBe("hevc");
    expect(videoKey(info("hevc", { video_profile: "Main 10", pix_fmt: "yuv420p10le", bit_depth: 10 }))).toBe("hevc_10bit");
    expect(videoKey(info("hevc", { pix_fmt: "yuv420p12le" }))).toBe("hevc_rext");
    expect(videoKey(info("hevc", { pix_fmt: "nv12" }))).toBe("hevc");
    // Old rows (no profile fields): the plain codec.
    expect(videoKey(info("h264"))).toBe("h264");
    expect(videoKey(info("mpeg4", { video_profile: "Advanced Simple Profile" }))).toBe("mpeg4");
  });

  it("reads release title hints", () => {
    expect(releaseVideoKey(release({ title: "[Group] Anime - 01 (1080p Hi10P)", video_codec: null }))).toBe("h264_10bit");
    expect(releaseVideoKey(release({ title: "Movie.2019.1080p.BluRay.10bit.x264", video_codec: "h264" }))).toBe("h264_10bit");
    expect(releaseVideoKey(release({ title: "Movie.2019.2160p.x265.10bit", video_codec: "hevc" }))).toBe("hevc_10bit");
    expect(releaseVideoKey(release({ title: "Movie.2019.2160p.HDR.x265", video_codec: "hevc", hdr: "hdr10" }))).toBe("hevc_10bit");
    expect(releaseVideoKey(release({ title: "Movie.2019.DVDRip.XviD.avi", video_codec: "xvid" }))).toBe("mpeg4");
    expect(releaseVideoKey(release({ title: "Movie (2019) DivX", video_codec: null }))).toBe("mpeg4");
    expect(releaseVideoKey(release({ title: "Movie.2019.1080p.x264" }))).toBe("h264");
    // «10bit» without a codec: not judged.
    expect(releaseVideoKey(release({ title: "Movie.2019.1080p.10bit", video_codec: null }))).toBeNull();
  });
});

describe("video decision table", () => {
  it("10-bit H.264 is unsupported unless the engine firmly says so", () => {
    const hi10 = info("h264", { video_profile: "High 10", pix_fmt: "yuv420p10le", bit_depth: 10 });
    for (const p of [tizen, old, sloppy]) {
      const s = assessSource(src(hi10), p);
      expect(s.unsupported).toContain("10-bit H.264");
      expect(s.avoid).toContain("h264_10bit");
      expect(videoUndecodable(s)).toBe(true);
    }
    expect(videoUndecodable(assessSource(src(hi10), desktop))).toBe(false);
    // 8-bit High plays on the TV.
    expect(videoUndecodable(assessSource(src(info("h264", { video_profile: "High", bit_depth: 8 })), tizen))).toBe(false);
  });

  it("ffprobe's own codec string is tried first", () => {
    const exact: Probe = { canPlayType: (t) => (t === 'video/mp4; codecs="avc1.6e0028"' ? "probably" : "") };
    expect(videoUndecodable(assessSource(src(info("h264", { video_profile: "High 10", video_codec_string: "avc1.6e0028" })), exact))).toBe(false);
  });

  it("HEVC Main 10 is probed, not assumed", () => {
    const m10 = info("hevc", { video_profile: "Main 10", pix_fmt: "yuv420p10le" });
    expect(videoUndecodable(assessSource(src(m10), tizen))).toBe(false);
    expect(assessSource(src(m10), old).unsupported[0]).toBe("HEVC 10-bit");
    expect(assessSource(src(m10), old).avoid).toContain("hevc_10bit");
  });

  it("MPEG-4 Part 2, VC-1 and MPEG-2 need a firm answer", () => {
    for (const c of ["mpeg4", "vc1", "mpeg2video"]) {
      expect(videoUndecodable(assessSource(src(info(c), { mime_type: "video/x-msvideo" }), sloppy))).toBe(true);
      expect(videoUndecodable(assessSource(src(info(c)), tizen))).toBe(true);
    }
    expect(assessRelease(release({ title: "Movie.2019.DVDRip.XviD.AVI", video_codec: "xvid" }), tizen).unsupported).toContain("MPEG-4 (XviD)");
  });

  it("the picker warning comes from title hints", () => {
    expect(assessRelease(release({ title: "Hellboy.2019.1080p.BluRay.10bit.x264" }), tizen).unsupported).toEqual(["10-bit H.264"]);
    expect(assessRelease(release({ title: "Hellboy.2019.1080p.BluRay.x264" }), tizen).unsupported).toEqual([]);
  });
});

describe("ranking prefers playable video", () => {
  it("rankForTv / nextRelease push 10-bit H.264 and XviD down on the TV", () => {
    const hi10 = release({ id: "hi10", title: "Hellboy.2019.1080p.Hi10P.x264", score: 12 });
    const xvid = release({ id: "xvid", title: "Hellboy.2019.DVDRip.XviD.avi", video_codec: "xvid", score: 11 });
    const plain = release({ id: "plain", title: "Hellboy.2019.1080p.BDRip.x264", score: 9 });
    expect(rankForTv([hi10, xvid, plain], { probe: tizen }).map((r) => r.id)[0]).toBe("plain");
    expect(nextRelease([hi10, xvid, plain], [], [], tizen, { probe: tizen })?.id).toBe("plain");
    // Without a probe: the server order.
    expect(rankForTv([hi10, xvid, plain], {}).map((r) => r.id)).toEqual(["hi10", "xvid", "plain"]);
  });

  it("an avoided video variant spares plain H.264; plain avoids the variants", () => {
    const hi10 = release({ id: "hi10", title: "Movie.10bit.x264" });
    const plain = release({ id: "plain", title: "Movie.x264" });
    expect(usesCodec(hi10, ["h264_10bit"])).toBe(true);
    expect(usesCodec(plain, ["h264_10bit"])).toBe(false);
    expect(usesCodec(hi10, ["h264"])).toBe(true);
    expect(nextRelease([hi10, plain], ["x"], ["h264_10bit"])?.id).toBe("plain");
    // Compat drops only audio keys from the avoid list, never the video's.
    expect(nextRelease([hi10, plain], ["x"], ["h264_10bit", "ac3"], tizen, { probe: tizen, compat: true })?.id).toBe("plain");
  });
});

describe("decode-error fallback", () => {
  const hi10 = info("h264", { video_profile: "High 10", pix_fmt: "yuv420p10le", bit_depth: 10, audio: [{ index: 1, codec: "dts", language: "rus", title: null, channels: 6, default: true }] });

  it("compat (video copied, audio AAC): the video is the reason and is avoided", () => {
    const s = assessSource(src(hi10), tizen);
    expect(s.unsupported).toEqual(["10-bit H.264", "DTS"]);
    expect(decodeFailure(s, true, "video/x-matroska")).toEqual({ reason: "10-bit H.264", avoid: ["h264_10bit"] });
    // The next pick skips 10-bit H.264 but not plain H.264 (DTS is fine with compat).
    const items = [release({ id: "a", title: "Hellboy.Hi10P.mkv" }), release({ id: "b", title: "Hellboy.x264", audio_codecs: ["dts"] })];
    expect(nextRelease(items, ["cur"], ["h264_10bit"], tizen, { probe: tizen, compat: true })?.id).toBe("b");
  });

  it("compat with an old row (no profile): «H.264», nothing avoided beyond the release", () => {
    const s = assessSource(src(info("h264", { audio: hi10.audio })), tizen);
    expect(decodeFailure(s, true, "video/x-matroska")).toEqual({ reason: "H.264", avoid: [] });
    // A HEVC stream failing in compat: avoid HEVC.
    expect(decodeFailure(assessSource(src(info("hevc")), tizen), true, null)).toEqual({ reason: "HEVC", avoid: ["hevc"] });
  });

  it("original mode keeps every unsupported component", () => {
    const s = assessSource(src(hi10), tizen);
    expect(decodeFailure(s, false, "video/x-matroska")).toEqual({ reason: "10-bit H.264, DTS", avoid: ["h264_10bit", "dts"] });
    expect(decodeFailure(null, false, "video/x-matroska; x=1")).toEqual({ reason: "video/x-matroska", avoid: [] });
  });
});

describe("errorRetries", () => {
  it("restarts a broken compat stream on a decode error, never an original file", () => {
    expect(errorRetries(3, true)).toBe(2);
    expect(errorRetries(3, false)).toBe(0);
  });
  it("keeps the network and SRC_NOT_SUPPORTED limits", () => {
    expect(errorRetries(2, false)).toBe(3);
    expect(errorRetries(2, true)).toBe(3);
    expect(errorRetries(4, false)).toBe(1);
    expect(errorRetries(4, true)).toBe(2);
    expect(errorRetries(1, true)).toBe(0);
  });
});
