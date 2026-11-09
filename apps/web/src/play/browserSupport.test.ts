import { describe, expect, it } from "vitest";
import type { MediaInfo, Release } from "@martytv/contracts";
import { translate, type MessageKey } from "@martytv/ui";
import {
  assessForBrowser,
  assessRelease,
  bestForBrowser,
  codecKey,
  containerFromTitle,
  containerKey,
  detectBrowser,
  rankForBrowser,
  reasonTexts,
  verdictLabel,
  type BrowserEnv,
  type Probe,
} from "./browserSupport";

const t = (k: MessageKey, v?: Record<string, string | number>) => translate("en", k, v);

/**
 * A probe like canPlayType: with codecs, every codec must be known (`yes`
 * entries are prefixes, e.g. "avc1"); without, the bare type must be listed.
 */
function probe(yes: string[]): Probe {
  return {
    canPlayType: (type) => {
      const m = /codecs="([^"]+)"/.exec(type);
      if (!m) return yes.some((y) => type.split(";")[0]!.trim().includes(y)) ? "maybe" : "";
      const codecs = m[1]!.split(",").map((c) => c.trim());
      return codecs.every((c) => yes.some((y) => c.startsWith(y))) ? "probably" : "";
    },
  };
}

// What the engines typically answer (no hardware HEVC on the Chrome box).
const CHROME = probe(["avc1", "vp8", "vp9", "vp09", "av01", "opus", "mp4a.40.2", "mp4a.69", "audio/mpeg", "flac", "vorbis", "video/webm", "video/mp4"]);
const CHROME_HEVC = probe(["avc1", "hvc1", "hev1", "vp9", "opus", "mp4a.40.2", "video/webm", "video/mp4"]);
const EDGE_WIN = probe(["avc1", "hvc1", "vp9", "opus", "mp4a.40.2", "ec-3", "video/webm", "video/mp4"]);
const SAFARI = probe(["avc1", "hvc1", "hev1", "mp4a.40.2", "ac-3", "ec-3", "audio/mpeg", "flac", "opus", "video/mp4", "video/webm", "vp09", "vp9"]);
const FIREFOX_OLD = probe(["avc1", "vp8", "vp9", "av01", "opus", "mp4a.40.2", "audio/mpeg", "flac", "video/webm", "video/mp4"]);
const FIREFOX_NEW = probe(["avc1", "vp8", "vp9", "av01", "opus", "mp4a.40.2", "audio/mpeg", "flac", "video/webm", "video/mp4", "video/x-matroska"]);

const env = (o: Partial<BrowserEnv>): BrowserEnv => ({ engine: "chromium", apple: false, windows: false, android: false, ios: false, ...o });
const chrome = env({ engine: "chromium" });
const edgeWin = env({ engine: "chromium", windows: true });
const safari = env({ engine: "safari", apple: true });
const iphone = env({ engine: "safari", apple: true, ios: true });
const firefox = env({ engine: "firefox" });

const info = (o: Partial<MediaInfo>): MediaInfo => ({
  container: "matroska,webm",
  video_codec: "h264",
  width: 1920,
  height: 1080,
  duration_seconds: 7200,
  audio: [{ index: 1, codec: "aac", language: "ru", title: null, channels: 2, default: true }],
  subtitles: [],
  ...o,
});
const audio = (...codecs: string[]) => codecs.map((codec, i) => ({ index: i + 1, codec, language: "ru", title: null, channels: 6, default: i === 0 }));

const rel = (o: Partial<Release> = {}): Release => ({
  id: "r",
  title: "Movie (2024) WEB-DL 1080p",
  indexer: "X",
  size_bytes: 1,
  seeders: 10,
  leechers: 0,
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
  year: 2024,
  seasons: [],
  episodes: [],
  is_season_pack: false,
  confidence: 1,
  score: 1,
  reasons: [],
  warnings: [],
  ...o,
});

describe("detectBrowser", () => {
  it("tells engines and platforms apart", () => {
    expect(detectBrowser("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")).toMatchObject({
      engine: "chromium",
      windows: true,
      apple: false,
    });
    expect(detectBrowser("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0").engine).toBe("chromium");
    expect(detectBrowser("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15")).toMatchObject({
      engine: "safari",
      apple: true,
      ios: false,
    });
    // Chrome on iPhone is WebKit.
    expect(detectBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/130.0 Mobile/15E148 Safari/604.1")).toMatchObject({
      engine: "safari",
      ios: true,
    });
    // iPadOS desktop UA with touch.
    expect(detectBrowser("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", 5).ios).toBe(true);
    expect(detectBrowser("Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0")).toMatchObject({ engine: "firefox", android: true });
    // The iPad's Media Station X web view: Mac UA without "Safari" (seen on prod).
    const msx = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
    expect(detectBrowser(msx, 5)).toMatchObject({ engine: "safari", ios: true });
    expect(detectBrowser(msx, 0, true)).toMatchObject({ engine: "safari", ios: true });
    expect(detectBrowser(msx, 0)).toMatchObject({ engine: "safari", ios: false });
  });
});

describe("codec & container keys", () => {
  it("normalizes names from ffprobe and the release parser", () => {
    expect(codecKey("H.264")).toBe("h264");
    expect(codecKey("x265")).toBe("hevc");
    expect(codecKey("E-AC-3")).toBe("eac3");
    expect(codecKey("dts-hd")).toBe("dts");
    expect(codecKey("DD+")).toBe("eac3");
    expect(codecKey(null)).toBeNull();
    expect(containerKey("matroska,webm", "video/webm")).toBe("webm");
    expect(containerKey("matroska,webm", "video/x-matroska")).toBe("matroska");
    expect(containerKey("mov,mp4,m4a,3gp,3g2,mj2", null)).toBe("mp4");
    expect(containerKey(null, "video/x-msvideo")).toBe("avi");
    expect(containerKey(null, "video/mp2t")).toBe("mpegts");
    expect(containerFromTitle("Film.2010.DVDRip.XviD.avi")).toBe("avi");
    expect(containerFromTitle("Сериал [WEB-DL 1080p] MKV")).toBe("matroska");
    expect(containerFromTitle("Movie.2024.1080p.WEB-DL.mp4")).toBe("mp4");
    expect(containerFromTitle("Movie 2024 WEB-DL 1080p")).toBeNull();
  });
});

describe("assessForBrowser — decision table", () => {
  it("Chrome: MP4/MKV with H.264 + AAC/Opus plays", () => {
    expect(assessForBrowser({ mime_type: "video/mp4", media_info: info({ container: "mov,mp4" }) }, CHROME, chrome).verdict).toBe("playable");
    expect(assessForBrowser({ mime_type: "video/x-matroska", media_info: info({}) }, CHROME, chrome).verdict).toBe("playable");
    expect(
      assessForBrowser({ mime_type: "video/webm", media_info: info({ video_codec: "vp8", audio: audio("opus") }) }, CHROME, chrome).verdict,
    ).toBe("playable");
  });

  it("Chrome: AC3 / E-AC3 / DTS / TrueHD main track → may lack sound", () => {
    for (const c of ["ac3", "eac3", "dts", "truehd"]) {
      const s = assessForBrowser({ mime_type: "video/x-matroska", media_info: info({ audio: audio(c) }) }, CHROME, chrome);
      expect(s.verdict, c).toBe("maybe");
      expect(s.noAudio, c).toBe(true);
      expect(s.reasons[0]).toMatchObject({ code: "no_audio", severity: "maybe" });
    }
    expect(assessForBrowser({ mime_type: "video/x-matroska", media_info: info({ audio: audio("ac3") }) }, CHROME, chrome).avoid).toEqual(["ac3"]);
  });

  it("Edge on Windows decodes E-AC3 (probe says so)", () => {
    expect(assessForBrowser({ mime_type: "video/mp4", media_info: info({ container: "mp4", audio: audio("eac3") }) }, EDGE_WIN, edgeWin).verdict).toBe("playable");
  });

  it("…but not inside MKV: the probe's yes is the platform's MP4 path (played silent)", () => {
    const mkv = assessForBrowser({ mime_type: "video/x-matroska", media_info: info({ audio: audio("eac3") }) }, EDGE_WIN, edgeWin);
    expect(mkv).toMatchObject({ verdict: "maybe", noAudio: true });
    expect(mkv.reasons[0]).toMatchObject({ code: "no_audio", label: "E-AC3" });
    // Before ffprobe: the container from the title, the codec from the release.
    expect(assessRelease(rel({ title: "Film.2024.1080p.mkv", audio_codecs: ["eac3"] }), EDGE_WIN, edgeWin).noAudio).toBe(true);
    // Safari decodes Dolby itself (it can't open MKV anyway: compat).
    const safariMp4 = assessForBrowser({ mime_type: "video/mp4", media_info: info({ container: "mp4", audio: audio("ac3") }) }, SAFARI, detectBrowser("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"));
    expect(safariMp4.noAudio).toBe(false);
  });

  it("HEVC: only with decoder support", () => {
    const hevc = { mime_type: "video/mp4", media_info: info({ container: "mp4", video_codec: "hevc" }) };
    const noHw = assessForBrowser(hevc, CHROME, chrome);
    expect(noHw.verdict).toBe("unlikely");
    expect(noHw.reasons[0]).toMatchObject({ code: "video", label: "HEVC" });
    expect(noHw.avoid).toContain("hevc");
    expect(assessForBrowser(hevc, CHROME_HEVC, chrome).verdict).toBe("playable");
    expect(assessForBrowser(hevc, SAFARI, safari).verdict).toBe("playable");
  });

  it("Safari: no MKV, but MP4 with HEVC + AC3/E-AC3 plays on Apple devices", () => {
    const mkv = assessForBrowser({ mime_type: "video/x-matroska", media_info: info({}) }, SAFARI, safari);
    expect(mkv.verdict).toBe("unlikely");
    expect(mkv.reasons[0]).toMatchObject({ code: "container", label: "MKV" });
    const mp4 = assessForBrowser({ mime_type: "video/mp4", media_info: info({ container: "mp4", video_codec: "hevc", audio: audio("eac3", "ac3") }) }, SAFARI, iphone);
    expect(mp4.verdict).toBe("playable");
    expect(mp4.reasons).toEqual([]);
  });

  it("Firefox: MKV only on recent versions", () => {
    const input = { mime_type: "video/x-matroska", media_info: info({}) };
    expect(assessForBrowser(input, FIREFOX_OLD, firefox)).toMatchObject({ verdict: "maybe", reasons: [expect.objectContaining({ code: "container_maybe" })] });
    expect(assessForBrowser(input, FIREFOX_NEW, firefox).verdict).toBe("playable");
  });

  it("AVI, raw MPEG-TS and unknown MIME types don't play", () => {
    expect(assessForBrowser({ mime_type: "video/x-msvideo", media_info: null }, CHROME, chrome).verdict).toBe("unlikely");
    expect(assessForBrowser({ mime_type: "video/mp2t", media_info: null }, CHROME, chrome).verdict).toBe("unlikely");
    const odd = assessForBrowser({ mime_type: "video/x-unknown", media_info: null }, CHROME, chrome);
    expect(odd).toMatchObject({ verdict: "unlikely", reasons: [expect.objectContaining({ code: "mime", label: "video/x-unknown" })] });
    expect(assessForBrowser({ mime_type: null, media_info: null, release: rel({ video_codec: "xvid", title: "Old.Film.DVDRip.XviD.avi" }) }, CHROME, chrome).verdict).toBe(
      "unlikely",
    );
  });

  it("other audio tracks that won't play are noted without lowering the verdict", () => {
    const s = assessForBrowser({ mime_type: "video/x-matroska", media_info: info({ audio: audio("aac", "dts", "ac3") }) }, CHROME, chrome);
    expect(s.verdict).toBe("playable");
    expect(s.reasons).toEqual([{ code: "some_audio", severity: "info", label: "DTS, AC3" }]);
  });

  it("default track decides, not the first one", () => {
    const tracks = audio("aac", "ac3");
    tracks[0]!.default = false;
    tracks[1]!.default = true;
    expect(assessForBrowser({ mime_type: "video/x-matroska", media_info: info({ audio: tracks }) }, CHROME, chrome).noAudio).toBe(true);
  });
});

describe("assessRelease — before preparing", () => {
  it("uses parsed codecs, title hints and warnings", () => {
    expect(assessRelease(rel(), CHROME, chrome).verdict).toBe("playable");
    expect(assessRelease(rel({ audio_codecs: ["ac3", "dts"] }), CHROME, chrome)).toMatchObject({ verdict: "maybe", noAudio: true });
    // Main (first listed) track bad → may lack sound; a later one bad → note only.
    expect(assessRelease(rel({ audio_codecs: ["ac3", "aac"] }), CHROME, chrome)).toMatchObject({ verdict: "maybe", noAudio: true });
    expect(assessRelease(rel({ audio_codecs: ["aac", "ac3"] }), CHROME, chrome)).toMatchObject({ verdict: "playable", noAudio: false });
    expect(assessRelease(rel({ video_codec: "hevc" }), CHROME, chrome).verdict).toBe("unlikely");
    expect(assessRelease(rel({ warnings: ["disc_image"] }), CHROME, chrome).verdict).toBe("unlikely");
    expect(assessRelease(rel({ video_codec: null }), CHROME, chrome)).toMatchObject({ verdict: "maybe", reasons: [expect.objectContaining({ code: "video_unknown" })] });
  });

  it("Safari: a release without a container hint is probably MKV", () => {
    expect(assessRelease(rel(), SAFARI, safari)).toMatchObject({ verdict: "maybe", reasons: [expect.objectContaining({ code: "container_maybe" })] });
    expect(assessRelease(rel({ title: "Movie.2024.1080p.WEB-DL.mp4" }), SAFARI, safari).verdict).toBe("playable");
    expect(assessRelease(rel({ title: "Movie.2024.1080p.mkv" }), SAFARI, safari).verdict).toBe("unlikely");
  });

  it("Dolby Vision is an info note outside Apple / Windows", () => {
    const s = assessRelease(rel({ hdr: "dolby_vision" }), CHROME, chrome);
    expect(s.verdict).toBe("playable");
    expect(s.reasons.map((r) => r.code)).toEqual(["hdr"]);
    expect(assessRelease(rel({ hdr: "dolby_vision", title: "x.mp4" }), SAFARI, safari).reasons).toEqual([]);
  });
});

describe("ranking for this browser", () => {
  const items = [
    rel({ id: "hevc", video_codec: "hevc" }),
    rel({ id: "ac3", audio_codecs: ["ac3"] }),
    rel({ id: "ok-1", audio_codecs: ["aac"] }),
    rel({ id: "ok-2", audio_codecs: ["aac"] }),
  ];
  const assess = (r: Release) => assessRelease(r, CHROME, chrome);

  it("puts playable first, keeping the server order inside a verdict", () => {
    expect(rankForBrowser(items, assess).map((x) => [x.release.id, x.support.verdict])).toEqual([
      ["ok-1", "playable"],
      ["ok-2", "playable"],
      ["ac3", "maybe"],
      ["hevc", "unlikely"],
    ]);
  });

  it("best = top playable, else maybe; skips tried releases and failing codecs", () => {
    expect(bestForBrowser(items, assess)?.id).toBe("ok-1");
    expect(bestForBrowser(items, assess, { tried: ["ok-1"] })?.id).toBe("ok-2");
    expect(bestForBrowser(items, assess, { tried: ["ok-1", "ok-2"] })?.id).toBe("ac3");
    expect(bestForBrowser(items, assess, { tried: ["ok-1", "ok-2"], avoid: ["ac3"] })).toBeNull();
    expect(bestForBrowser([items[0]!], assess)).toBeNull();
  });
});

describe("texts", () => {
  it("badges and reasons read well", () => {
    const silent = assessRelease(rel({ audio_codecs: ["dts"] }), CHROME, chrome);
    expect(verdictLabel(silent, t)).toBe("May lack sound");
    expect(reasonTexts(silent, t)).toEqual(["DTS audio isn't supported here — the video may play without sound."]);
    expect(verdictLabel(assessRelease(rel(), CHROME, chrome), t)).toBe("Plays in this browser");
    const hevc = assessRelease(rel({ video_codec: "hevc", audio_codecs: ["ac3"] }), CHROME, chrome);
    expect(verdictLabel(hevc, t)).toBe("Won't play here");
    expect(reasonTexts(hevc, t)[0]).toBe("HEVC video can't be decoded by this browser.");
    expect(translate("ru", "player.web.badge.no_sound")).toBe("Может быть без звука");
  });
});
