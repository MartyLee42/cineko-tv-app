import { describe, expect, it } from "vitest";
import type { MediaInfo } from "@martytv/contracts";
import {
  compatFixes,
  compatFormat,
  compatHlsUrl,
  compatSeek,
  compatSrc,
  compatStatus,
  expectsAudio,
  fetchStreamStart,
  fileDuration,
  hlsLocalRanges,
  inBuffered,
  pickCompatAudio,
  subsSrc,
  textSubtitles,
  wantCompat,
} from "./compat";
import { assessForBrowser, detectBrowser, verdictLabel, withCompat, type BrowserEnv, type Probe } from "../play/browserSupport";

const info: MediaInfo = {
  container: "matroska,webm",
  video_codec: "h264",
  width: 1920,
  height: 1080,
  duration_seconds: 5400,
  audio: [
    { index: 1, codec: "ac3", language: "rus", title: "Дубляж", channels: 6, default: true },
    { index: 2, codec: "ac3", language: "rus", title: "MVO LostFilm", channels: 2, default: false },
    { index: 3, codec: "dts", language: "eng", title: null, channels: 6, default: false },
  ],
  subtitles: [
    { index: 4, codec: "subrip", language: "rus", title: null, default: false },
    { index: 5, codec: "hdmv_pgs_subtitle", language: "eng", title: null, default: false },
    { index: 6, codec: "ass", language: "eng", title: "Signs", default: false },
  ],
};

const chrome: BrowserEnv = { engine: "chromium", apple: false, windows: true, android: false, ios: false };
const safari: BrowserEnv = { engine: "safari", apple: true, windows: false, android: false, ios: true };
/** A browser with H.264/AAC/Opus but no AC3/DTS (Chrome / Firefox on desktop). */
const probe: Probe = {
  canPlayType: (t) => (/hvc1|hev1|ac-3|ec-3|dts|mlpa|av01/.test(t) ? "" : /avc1|mp4a\.40|opus|video\/mp4|webm/.test(t) ? "probably" : ""),
};

describe("compat decision", () => {
  it("fixes undecodable audio and MKV on Safari, not video", () => {
    const ac3 = assessForBrowser({ media_info: info, mime_type: "video/x-matroska" }, probe, chrome);
    expect(ac3.noAudio).toBe(true);
    expect(compatFixes(ac3)).toBe(true);

    const mkvSafari = assessForBrowser({ media_info: { ...info, audio: [{ ...info.audio[0]!, codec: "aac" }] }, mime_type: "video/x-matroska" }, probe, safari);
    expect(mkvSafari.verdict).toBe("unlikely");
    expect(compatFixes(mkvSafari)).toBe(true);

    const hevc = assessForBrowser({ media_info: { ...info, video_codec: "hevc" }, mime_type: "video/x-matroska" }, probe, chrome);
    expect(compatFixes(hevc)).toBe(false); // video is copied: compat can't help

    const fine = assessForBrowser({ media_info: { ...info, audio: [{ ...info.audio[0]!, codec: "aac" }] }, mime_type: "video/mp4" }, probe, chrome);
    expect(compatFixes(fine)).toBe(false); // nothing to fix
  });

  it("wantCompat: URL needed, explicit choice wins, else automatic", () => {
    const ac3 = assessForBrowser({ media_info: info, mime_type: "video/x-matroska" }, probe, chrome);
    const fine = { verdict: "playable" as const, noAudio: false, reasons: [] };
    expect(wantCompat({ compatUrl: null, pref: "on", support: ac3 })).toBe(false);
    expect(wantCompat({ compatUrl: "/c", pref: null, support: ac3 })).toBe(true);
    expect(wantCompat({ compatUrl: "/c", pref: "off", support: ac3 })).toBe(false);
    expect(wantCompat({ compatUrl: "/c", pref: "on", support: fine })).toBe(true);
    expect(wantCompat({ compatUrl: "/c", pref: null, support: fine })).toBe(false);
  });

  it("badges: «may lack sound» becomes «plays (audio converted)» with compat", () => {
    const t = (k: string) => k;
    const ac3 = assessForBrowser({ media_info: info, mime_type: "video/x-matroska" }, probe, chrome);
    expect(verdictLabel(ac3, t as never)).toBe("player.web.badge.no_sound");
    const c = withCompat(ac3, true);
    expect(c.verdict).toBe("playable");
    expect(c.compat).toBe(true);
    expect(verdictLabel(c, t as never)).toBe("player.web.badge.converted");
    expect(withCompat(ac3, false)).toBe(ac3);
  });
});

describe("compat URLs and tracks", () => {
  it("builds stream and subtitle URLs", () => {
    const base = "/api/v1/stream/TOK/compat.mp4";
    expect(compatSrc(base, { audio: null, start: 0 })).toBe(base);
    expect(compatSrc(base, { audio: 2, start: 598.12345 })).toBe(`${base}?audio=2&start=598.123`);
    expect(subsSrc(base, 4, 598.5, 62.2)).toBe("/api/v1/stream/TOK/subs/4.vtt?start=598.5&burst=63");
    expect(subsSrc(base, 6, 0, 0)).toBe("/api/v1/stream/TOK/subs/6.vtt");
  });

  it("lists text subtitles only", () => {
    expect(textSubtitles(info).map((s) => s.index)).toEqual([4, 6]);
    expect(textSubtitles(null)).toEqual([]);
  });

  it("picks the audio track: voice-over, language, default", () => {
    expect(pickCompatAudio(info)).toBe(1);
    expect(pickCompatAudio(info, { voiceovers: ["Кубик в Кубе", "lostfilm"] })).toBe(2);
    expect(pickCompatAudio(info, { languages: ["en"] })).toBe(3);
    expect(pickCompatAudio(info, { voiceovers: ["nobody"], languages: ["de", "ru"] })).toBe(1);
    expect(pickCompatAudio({ ...info, audio: [] })).toBeNull();
  });

  it("reads X-Stream-Start, falls back to the requested time", async () => {
    const ok = (async () => new Response(null, { headers: { "X-Stream-Start": "595.040" } })) as typeof fetch;
    expect(await fetchStreamStart("/x", 600, ok)).toBe(595.04);
    expect(await fetchStreamStart("/x", 0, ok)).toBe(0);
    const bad = (async () => new Response(null, { status: 502 })) as typeof fetch;
    expect(await fetchStreamStart("/x", 600, bad)).toBe(600);
    const down = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect(await fetchStreamStart("/x", 600, down)).toBe(600);
  });
});

describe("compat seeking", () => {
  const buffered: [number, number][] = [[0, 40]];
  it("seeks within the buffer, restarts outside it", () => {
    expect(inBuffered(10, buffered)).toBe(true);
    expect(inBuffered(39.9, buffered)).toBe(false); // too close to the end
    expect(inBuffered(-1, buffered)).toBe(false);
    // Stream starts at 600 (offset): 620 is 20 s into it.
    expect(compatSeek(620, 600, buffered)).toEqual({ kind: "local", at: 20 });
    expect(compatSeek(900, 600, buffered)).toEqual({ kind: "reload", at: 900 });
    expect(compatSeek(590, 600, buffered)).toEqual({ kind: "reload", at: 590 }); // before the stream's start
  });
});

describe("fresh torrent: no ffprobe info yet", () => {
  it("the timeline's length: ffprobe, else the provider's, else the TMDB runtime", () => {
    expect(fileDuration({ media_info: info, duration_seconds: 10 }, 60)).toBe(5400);
    expect(fileDuration({ media_info: null, duration_seconds: 3000 }, 60)).toBe(3000);
    expect(fileDuration({ media_info: null }, 7080)).toBe(7080);
    expect(fileDuration({ media_info: { ...info, duration_seconds: null } }, 7080)).toBe(7080);
    expect(fileDuration({ media_info: null }, null)).toBeNull();
    expect(fileDuration({ media_info: null }, 0)).toBeNull();
  });

  it("seeking a restarted stream keeps absolute time (offset + element time)", () => {
    // Started at the keyframe 1795.5 for start=1800; the element is 12 s in.
    const off = 1795.5;
    expect(off + 12).toBe(1807.5);
    // A seek bar jump to 1:00:00 is far outside the buffer: restart there.
    expect(compatSeek(3600, off, [[0, 30]])).toEqual({ kind: "reload", at: 3600 });
    // A small step back within what's buffered stays local (relative time).
    expect(compatSeek(1800, off, [[0, 30]])).toEqual({ kind: "local", at: 4.5 });
  });

  it("the no-sound detector runs unless ffprobe says there is no audio", () => {
    expect(expectsAudio({ media_info: null })).toBe(true);
    expect(expectsAudio({ media_info: info })).toBe(true);
    expect(expectsAudio({ media_info: { ...info, audio: [] } })).toBe(false);
  });

  it("wantCompat: a preferred voice the browser can't switch to", () => {
    const fine = { verdict: "playable" as const, noAudio: false, reasons: [] };
    expect(wantCompat({ compatUrl: "/c", pref: null, support: fine, audioSwitch: true })).toBe(true);
    expect(wantCompat({ compatUrl: "/c", pref: "off", support: fine, audioSwitch: true })).toBe(false);
    expect(wantCompat({ compatUrl: null, pref: null, support: fine, audioSwitch: true })).toBe(false);
  });

  it("the remembered track is picked for compat", () => {
    expect(pickCompatAudio(info, { languages: ["ru"] }, { language: "eng", title: null })).toBe(3);
  });
});

describe("compat format (iOS / Safari get HLS)", () => {
  const MSX_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  const IPAD_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1";
  const MAC_SAFARI = IPAD_SAFARI;
  const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
  const hlsProbe: Probe = { canPlayType: (t) => (t === "application/vnd.apple.mpegurl" ? "maybe" : "") };
  const noHls: Probe = { canPlayType: () => "" };

  it("iPad (Safari and the MSX web view without «Safari» in its UA) and iPhone browsers: HLS, whatever canPlayType says", () => {
    expect(compatFormat(detectBrowser(MSX_UA, 5, true), noHls)).toBe("hls");
    expect(compatFormat(detectBrowser(IPAD_SAFARI, 5, true), hlsProbe)).toBe("hls");
    expect(compatFormat(detectBrowser(IPHONE_CHROME), noHls)).toBe("hls");
  });

  it("iPad in MSX with an MKV (h264/hevc + AC3): straight to compat, as HLS (never the raw MKV)", () => {
    // iPadOS: AVFoundation decodes H.264/HEVC/AAC/AC3 and HLS, but no Matroska.
    const ipad: Probe = { canPlayType: (t) => (/matroska|mkv|dts|mlpa|webm/.test(t) ? "" : "maybe") };
    const env = detectBrowser(MSX_UA, 5, true);
    expect(env).toMatchObject({ engine: "safari", ios: true });
    for (const video_codec of ["h264", "hevc"]) {
      const support = assessForBrowser({ media_info: { ...info, video_codec }, mime_type: "video/x-matroska" }, ipad, env);
      expect(support.verdict).toBe("unlikely");
      expect(wantCompat({ compatUrl: "/api/v1/stream/t/compat.mp4", pref: null, support })).toBe(true);
    }
    expect(compatFormat(env, ipad)).toBe("hls");
  });

  it("desktop Safari: HLS when it plays HLS natively (it also needs byte ranges for MP4)", () => {
    expect(compatFormat(detectBrowser(MAC_SAFARI), hlsProbe)).toBe("hls");
    expect(compatFormat(detectBrowser(MAC_SAFARI), noHls)).toBe("mp4");
  });

  it("other browsers keep compat.mp4 (even with native HLS)", () => {
    expect(compatFormat(detectBrowser(CHROME), hlsProbe)).toBe("mp4");
    expect(compatFormat(chrome, hlsProbe)).toBe("mp4");
    expect(compatFormat({ engine: "firefox", ios: false }, hlsProbe)).toBe("mp4");
  });

  it("HLS URLs: compat.m3u8 with the same audio/start", () => {
    const u = "/api/v1/stream/tok/compat.mp4";
    expect(compatHlsUrl(u)).toBe("/api/v1/stream/tok/compat.m3u8");
    expect(compatSrc(u, { audio: 2, start: 118.5004, format: "hls" })).toBe("/api/v1/stream/tok/compat.m3u8?audio=2&start=118.5");
    expect(compatSrc(u, { audio: null, start: 0, format: "hls" })).toBe("/api/v1/stream/tok/compat.m3u8");
    expect(compatSrc(u, { audio: 1, start: 5, format: "mp4" })).toBe("/api/v1/stream/tok/compat.mp4?audio=1&start=5");
    // Subtitles stay on the shared endpoint.
    expect(subsSrc(u, 4, 118.5, 0)).toBe("/api/v1/stream/tok/subs/4.vtt?start=118.5");
  });

  it("HLS seeks: within the generated segments (not far behind the player) stay local; else restart", () => {
    const seekable: [number, number][] = [[0, 900]];
    // Player at 800 s into the stream (offset 1000 → absolute 1800).
    const ranges = hlsLocalRanges(seekable, 800);
    expect(ranges).toEqual([[500, 900]]);
    expect(compatSeek(1000 + 850, 1000, ranges)).toEqual({ kind: "local", at: 850 });
    expect(compatSeek(1000 + 600, 1000, ranges)).toEqual({ kind: "local", at: 600 });
    // More than 5 min back: the server may have deleted those segments.
    expect(compatSeek(1000 + 100, 1000, ranges)).toEqual({ kind: "reload", at: 1100 });
    // Past what's generated, or before the stream's start.
    expect(compatSeek(1000 + 950, 1000, ranges)).toEqual({ kind: "reload", at: 1950 });
    expect(compatSeek(900, 1000, ranges)).toEqual({ kind: "reload", at: 900 });
    expect(hlsLocalRanges([], 10)).toEqual([]);
  });

  it("HLS error check uses HEAD (a GET would start another conversion)", async () => {
    const calls: RequestInit[] = [];
    const f = (async (_u: string, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(null, { status: 403 });
    }) as unknown as typeof fetch;
    expect(await compatStatus("/x/compat.m3u8", f, "HEAD")).toBe(403);
    expect(calls[0]!.method).toBe("HEAD");
    await compatStatus("/x/compat.mp4", f);
    expect(calls[1]!.method).toBe("GET");
  });
});
