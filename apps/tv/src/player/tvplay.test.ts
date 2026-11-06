// TV playback fixes: compat audio decision/mapping/timeline, rebuffer and
// bandwidth, TV release ranking, external-player availability (MSX vs
// Chrome on Android), and the shared device playback profile helpers.
import { describe, expect, it, vi } from "vitest";
import type { MediaInfo, Release } from "@martytv/contracts";
import { applyPreset, constraints, constraintsText, effectivePrefs, medianThroughput, PRESETS, pushSample, resolutionForScreen, suggestPreset } from "@martytv/media-types";
import { audioFactor, audioSupported, bitrateFactor, heavyMbps, lighterInstead, nextRelease, playableHere, rankForTv, tooHeavyHere, videoFactor, type Probe, audioProbeAnswers } from "./codecs";
import {
  absTime,
  audioIndexOf,
  audioUndecodable,
  canPlayCompat,
  compatPlan,
  compatSeek,
  compatServer,
  compatSrc,
  compatUrlOf,
  parseStreamStart,
  pickCompatAudio,
  sourceCodecLabel,
  trackIdOf,
  videoConvertNeeded,
  wantCompat,
} from "./compat";
import { assessSource } from "./codecs";
import { BACK_DEDUPE_MS, keyIsEcho, needsBackTrap, popIsNewPress } from "../remote/backTrap";
import {
  bandwidthCheck,
  bufferedAhead,
  estimateRate,
  mbit,
  rebufferDead,
  rebufferDone,
  rebufferPercent,
  rebufferTarget,
  sessionRate,
  SLOW_COOLDOWN_MS,
  SLOW_HINT_MS,
  SLOW_LOG0,
  slowHintAllowed,
  slowHintExpired,
  sessionSample,
  slowHintPref,
  prebufferPref,
  sourceBitrate,
} from "./rebuffer";
import { availablePlayers, externalHiddenInMsx, externalRoute, isWebView } from "../players/select";
import { launchSupported, matchResult } from "../players/msx";
import { deviceModel, detectAuto, sameAuto } from "../settings/devicePrefs";
import { detectedSummary } from "../settings/deviceRows";

vi.mock("../api", () => ({ api: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), PUT: vi.fn() }, realtime: { reconnectNow: () => undefined } }));

/** A Chromium-on-Amlogic-like engine: H.264/HEVC/AAC/MP4 yes, AC3/E-AC3/DTS no, MKV via WebM. */
const AMLOGIC: Probe = {
  canPlayType: (t) =>
    /avc1\.|hvc1\.1\.|hev1\.1\.|codecs="hvc1"|codecs="hev1"|mp4a\.40\.2/.test(t) || ["video/mp4", "video/webm", "audio/mpeg"].includes(t) ? "probably" : "",
};
/** A TV that decodes everything. */
const ALL: Probe = { canPlayType: () => "probably" };

// «Побег из Шоушенка» remux: 33 audio tracks, the first two AC3 rus (Дубляж).
const SHAWSHANK: MediaInfo = {
  container: "matroska,webm",
  video_codec: "h264",
  width: 1920,
  height: 1080,
  duration_seconds: 8553,
  audio: [
    { index: 1, codec: "ac3", language: "rus", title: "Дубляж", channels: 6, default: true },
    { index: 2, codec: "ac3", language: "rus", title: "Дубляж (Blu-ray CEE)", channels: 6 },
    { index: 3, codec: "dts", language: "rus", title: "MVO Гаврилов", channels: 6 },
    ...Array.from({ length: 29 }, (_, i) => ({ index: 4 + i, codec: i % 2 ? "ac3" : "dts", language: i < 10 ? "rus" : i < 20 ? "ukr" : "bel", title: `VO ${i}`, channels: 6 })),
    { index: 33, codec: "eac3", language: "eng", title: "Original", channels: 6 },
  ],
  subtitles: [],
};

describe("compat decision", () => {
  const base = { compatUrl: "/api/v1/stream/t/compat.mp4", canPlay: true, audioBad: false };
  it("auto: only when the audio can't be decoded or there's no sound", () => {
    expect(wantCompat({ ...base, pref: "auto" })).toBe(false);
    expect(wantCompat({ ...base, pref: "auto", audioBad: true })).toBe(true);
    expect(wantCompat({ ...base, pref: "auto", noSound: true })).toBe(true);
  });
  it("on/off win; no URL or no MP4/AAC engine never", () => {
    expect(wantCompat({ ...base, pref: "on" })).toBe(true);
    expect(wantCompat({ ...base, pref: "off", audioBad: true })).toBe(false);
    expect(wantCompat({ ...base, compatUrl: null, pref: "on", audioBad: true })).toBe(false);
    expect(wantCompat({ ...base, canPlay: false, pref: "on", audioBad: true })).toBe(false);
  });
  it("codec support × availability: AC3 on an Amlogic engine needs compat, on a full engine not", () => {
    const src = { mime_type: "video/x-matroska", media_info: SHAWSHANK };
    expect(audioUndecodable(assessSource(src, AMLOGIC))).toBe(true);
    expect(audioUndecodable(assessSource(src, ALL))).toBe(false);
    expect(canPlayCompat(AMLOGIC)).toBe(true);
    expect(canPlayCompat({ canPlayType: () => "" })).toBe(false);
  });
  it("only torrent sources have a compat stream", () => {
    expect(compatUrlOf({ kind: "torrent", compat_url: "/c" })).toBe("/c");
    expect(compatUrlOf({ kind: "online", compat_url: "/c" })).toBeNull();
    expect(compatUrlOf({ compat_url: null })).toBeNull();
  });
});

describe("compat audio index mapping", () => {
  it("maps panel track ids to ffprobe stream indexes and back", () => {
    expect(audioIndexOf(SHAWSHANK, "a0")).toBe(1);
    expect(audioIndexOf(SHAWSHANK, "a32")).toBe(33);
    expect(audioIndexOf(SHAWSHANK, "a99")).toBeNull();
    expect(audioIndexOf(SHAWSHANK, "s0")).toBeNull();
    expect(trackIdOf(SHAWSHANK, 33)).toBe("a32");
    expect(trackIdOf(SHAWSHANK, 0)).toBeNull();
  });
  it("picks the preferred voice-over, then language, then the default", () => {
    expect(pickCompatAudio(SHAWSHANK, { voiceovers: ["Гаврилов"] })).toBe(3);
    expect(pickCompatAudio(SHAWSHANK, { languages: ["en"] })).toBe(33);
    expect(pickCompatAudio(SHAWSHANK, {})).toBe(1);
    expect(pickCompatAudio(null)).toBeNull();
  });
  it("labels the converted codec for «AAC (из AC3)»", () => {
    expect(sourceCodecLabel(SHAWSHANK, 1)).toBe("AC3");
    expect(sourceCodecLabel(SHAWSHANK, 3)).toBe("DTS");
    expect(sourceCodecLabel(SHAWSHANK, 33)).toBe("E-AC3");
  });
});

describe("compat timeline", () => {
  it("builds URLs with audio and start", () => {
    expect(compatSrc("/s/compat.mp4", { audio: 3, start: 0 })).toBe("/s/compat.mp4?audio=3");
    expect(compatSrc("/s/compat.mp4", { audio: 1, start: 1234.5678 })).toBe("/s/compat.mp4?audio=1&start=1234.568");
  });
  it("trusts X-Stream-Start only when sane", () => {
    expect(parseStreamStart("1198.4", 1200)).toBe(1198.4);
    expect(parseStreamStart(null, 1200)).toBe(1200);
    expect(parseStreamStart("abc", 1200)).toBe(1200);
    expect(parseStreamStart("9999", 1200)).toBe(1200);
  });
  it("shown time = offset + currentTime; seeks restart outside the buffer", () => {
    expect(absTime(1198.4, 12)).toBeCloseTo(1210.4);
    expect(absTime(0, NaN)).toBe(0);
    expect(compatSeek(1205, 1198.4, [[0, 20]])).toEqual({ kind: "local", at: expect.closeTo(6.6, 5) });
    expect(compatSeek(3000, 1198.4, [[0, 20]])).toEqual({ kind: "reload", at: 3000 });
    expect(compatSeek(100, 1198.4, [[0, 20]])).toEqual({ kind: "reload", at: 100 });
  });
});

describe("rebuffer", () => {
  it("waits max(20, 3 × last stall) ≤ 60 s, 8 after a seek", () => {
    expect(rebufferTarget(null, false)).toBe(20);
    expect(rebufferTarget(12, false)).toBe(36);
    expect(rebufferTarget(40, false)).toBe(60);
    expect(rebufferTarget(40, true)).toBe(8);
  });
  it("resumes at the threshold, on canplaythrough or at the end", () => {
    const base = { target: 20, canPlayThrough: false, time: 100, duration: 8553 };
    expect(rebufferDone({ ...base, ahead: 10 })).toBeNull();
    expect(rebufferDone({ ...base, ahead: 21 })).toBe("threshold");
    expect(rebufferDone({ ...base, ahead: 1, canPlayThrough: true })).toBe("canplaythrough");
    expect(rebufferDone({ ...base, ahead: 3, time: 8550 })).toBe("end");
    expect(rebufferPercent(10, 20)).toBe(50);
    expect(bufferedAhead([[0, 30]], 12)).toBe(18);
  });
  it("a paused engine that stopped fetching below the target plays what it has (no «99 %» forever)", () => {
    const base = { target: 20, canPlayThrough: false, time: 1570, duration: 8553 };
    expect(rebufferDone({ ...base, ahead: 19.5, stuckMs: 4_900 })).toBeNull();
    // 99 % shown: play.
    expect(rebufferDone({ ...base, ahead: 19.8 })).toBe("threshold");
    expect(rebufferDone({ ...base, ahead: 19.5, stuckMs: 5_000 })).toBe("plateau");
    expect(rebufferDone({ ...base, ahead: 4, stuckMs: 5_000 })).toBe("plateau");
    expect(rebufferDone({ ...base, ahead: 2, stuckMs: 60_000 })).toBeNull();
    // After a seek (target 8) a smaller buffer is enough.
    expect(rebufferDone({ ...base, target: 3, ahead: 3.5, stuckMs: 0 })).toBe("threshold");
  });
  it("a stream that delivers nothing for 25 s is dead (reloaded at the spot); a full one is not", () => {
    expect(rebufferDead(0, 25_000)).toBe(true);
    expect(rebufferDead(0, 24_000)).toBe(false);
    expect(rebufferDead(10, 60_000)).toBe(false);
  });
});

describe("bandwidth", () => {
  // 42.1 GB over 8553 s ≈ 39 Mbit/s.
  const bitrate = sourceBitrate(42.1e9, 8553)!;
  it("estimates the file bitrate and the link rate from buffer growth", () => {
    expect(Math.round(bitrate / 1e6)).toBe(39);
    // 10 s wall, 4 s of media gained → 0.4 × 39.4 ≈ 15.8 Mbit/s (the owner's link).
    const s = [
      { at: 0, end: 100 },
      { at: 5000, end: 102 },
      { at: 10000, end: 104 },
    ];
    expect(mbit(estimateRate(s, bitrate, 10000))).toBe("15.8");
    expect(estimateRate(s.slice(0, 1), bitrate, 10000)).toBeNull();
  });
  it("hints after > 20 s below 1.1 × bitrate or > 3 stalls in 2 min", () => {
    let st = bandwidthCheck({ rate: 15e6, bitrate, lowSince: null, stalls: [], now: 0 });
    expect(st.hint).toBe(false);
    st = bandwidthCheck({ rate: 15e6, bitrate, lowSince: st.lowSince, stalls: [], now: 21_000 });
    expect(st.hint).toBe(true);
    expect(bandwidthCheck({ rate: null, bitrate, lowSince: null, stalls: [1, 2, 3, 4].map((x) => 100_000 + x), now: 110_000 }).hint).toBe(true);
    expect(bandwidthCheck({ rate: 50e6, bitrate, lowSince: 0, stalls: [], now: 30_000 })).toEqual({ lowSince: null, hint: false });
  });
  it("a session's sample is the median of ≥ 3 estimates", () => {
    expect(sessionRate([10e6, 14e6])).toBeNull();
    expect(sessionRate([10e6, 14e6, 30e6])).toBe(14e6);
  });
});

function rel(id: string, p: Partial<Release> & { est_bitrate_bps?: number | null } = {}): Release & { est_bitrate_bps?: number | null } {
  return {
    id,
    title: id,
    indexer: "x",
    size_bytes: 10e9,
    seeders: 50,
    leechers: 0,
    published_at: null,
    info_hash: null,
    resolution: "1080p",
    video_codec: "h264",
    hdr: [],
    audio_codecs: ["ac3"],
    languages: ["ru"],
    voiceovers: [],
    release_group: null,
    source_quality: "web-dl",
    year: 1994,
    seasons: [],
    episodes: [],
    is_season_pack: false,
    confidence: 1,
    score: 0.9,
    reasons: [],
    warnings: [],
    ...p,
  } as Release & { est_bitrate_bps?: number | null };
}

describe("TV release ranking", () => {
  const remux = rel("remux", { size_bytes: 42.1e9, score: 0.95, audio_codecs: ["ac3", "dts"], source_quality: "remux" });
  const webdl = rel("webdl", { size_bytes: 12e9, score: 0.8 });
  const aacOnly = rel("aac", { size_bytes: 8e9, score: 0.6, audio_codecs: ["aac"] });
  const env = { probe: AMLOGIC, rateBps: 15e6, compat: true, runtime: 8553 };

  it("penalises bitrate far above the measured rate", () => {
    expect(bitrateFactor(39e6, 15e6)).toBeLessThan(0.2);
    expect(bitrateFactor(11e6, 15e6)).toBe(1);
    expect(bitrateFactor(15e6, 15e6)).toBe(0.75);
    expect(bitrateFactor(39e6, null)).toBe(1);
  });
  it("penalises undecodable main audio, less with compat", () => {
    expect(audioFactor(webdl, AMLOGIC, true)).toBe(0.85);
    expect(audioFactor(webdl, AMLOGIC, false)).toBe(0.4);
    expect(audioFactor(aacOnly, AMLOGIC, false)).toBe(1);
  });
  it("the 39 Mbit/s remux ranks below a 12 GB WEB-DL on a 15 Mbit/s link", () => {
    expect(rankForTv([remux, webdl, aacOnly], env).map((r) => r.id)).toEqual(["webdl", "aac", "remux"]);
    // Without compat, the AAC release wins over AC3.
    expect(rankForTv([remux, webdl, aacOnly], { ...env, compat: false }).map((r) => r.id)[0]).toBe("aac");
    // Fast link, full decoder: the server's order stands.
    expect(rankForTv([remux, webdl], { probe: ALL, rateBps: 100e6, runtime: 8553 }).map((r) => r.id)).toEqual(["remux", "webdl"]);
  });
  it("uses the server's est_bitrate_bps when present; heavy chip", () => {
    const r = rel("x", { est_bitrate_bps: 39e6 });
    expect(heavyMbps(r, { rateBps: 15e6 })).toBe(39);
    expect(heavyMbps(rel("y", { est_bitrate_bps: 9e6 }), { rateBps: 15e6 })).toBeNull();
    expect(heavyMbps(rel("z", { est_bitrate_bps: 39e6 }), {})).toBe(39);
    expect(heavyMbps(rel("p", { is_season_pack: true }), { runtime: 2700 })).toBeNull();
  });
  it("nextRelease: compat makes AC3 releases playable; auto-pick prefers the light one", () => {
    expect(playableHere(webdl, AMLOGIC, false)).toBe(false);
    expect(playableHere(webdl, AMLOGIC, true)).toBe(true);
    expect(nextRelease([remux, webdl], [], [], AMLOGIC, env)?.id).toBe("webdl");
    expect(nextRelease([remux, webdl], [], ["ac3"], AMLOGIC, env)?.id).toBe("webdl");
    expect(nextRelease([remux, webdl, aacOnly], [], [], AMLOGIC)?.id).toBe("aac");
  });
});

describe("external players", () => {
  const TX3_MSX = "Mozilla/5.0 (Linux; Android 11; TX3 Build/RQ1A.210105.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36";
  const CHROME_ATV = "Mozilla/5.0 (Linux; Android 11; TX3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Safari/537.36";
  it("detects the Android WebView", () => {
    expect(isWebView(TX3_MSX)).toBe(true);
    expect(isWebView(CHROME_ATV)).toBe(false);
  });
  it("availability matrix: MSX vs Chrome on Android TV vs others", () => {
    // MSX on Android, bridge alive, MSX ≥ 0.1.136: launch via the bridge.
    expect(externalRoute({ platform: "android-tv", msxAlive: true, msxLaunch: true, ua: TX3_MSX })).toBe("msx");
    expect(availablePlayers({ platform: "android-tv", msxAlive: true, msxLaunch: true, ua: TX3_MSX })).toEqual(["builtin", "msx", "external"]);
    // MSX without the launch action (old MSX / no bridge info): hidden + hint.
    expect(availablePlayers({ platform: "android-tv", msxAlive: true, msxLaunch: false, ua: TX3_MSX })).toEqual(["builtin", "msx"]);
    expect(externalHiddenInMsx({ platform: "android-tv", msxAlive: true, msxLaunch: false, ua: TX3_MSX })).toBe(true);
    // MSX UA marker without a bridge: hidden too.
    expect(availablePlayers({ platform: "android-tv", msxAlive: false, ua: `${CHROME_ATV} MSX/0.1.160` })).toEqual(["builtin"]);
    // A WebView without MSX: intent:// fails there → hidden (no hint).
    expect(availablePlayers({ platform: "android-tv", msxAlive: false, ua: TX3_MSX })).toEqual(["builtin"]);
    expect(externalHiddenInMsx({ platform: "android-tv", msxAlive: false, ua: TX3_MSX })).toBe(false);
    // Standalone Chrome on Android TV: intent://.
    expect(externalRoute({ platform: "android-tv", msxAlive: false, ua: CHROME_ATV })).toBe("intent");
    // Tizen / webOS / desktop: never.
    // MSX on Tizen: the bridge reports no launch support (Android / Fire TV only).
    expect(availablePlayers({ platform: "tizen", msxAlive: true, msxLaunch: false, ua: "Tizen 6.5" })).toEqual(["builtin", "msx"]);
    expect(availablePlayers({ platform: "tizen", msxAlive: false, ua: "Tizen" })).toEqual(["builtin"]);
    expect(availablePlayers({ platform: "browser", msxAlive: false, ua: "Chrome/120" })).toEqual(["builtin"]);
  });
  it("reads the bridge's launch capability and relays app:result", () => {
    const now = 1_000_000;
    expect(launchSupported(JSON.stringify({ alive_at: now, launch: true }), now)).toBe(true);
    expect(launchSupported(JSON.stringify({ alive_at: now }), now)).toBe(false);
    expect(launchSupported(JSON.stringify({ alive_at: now - 60_000, launch: true }), now)).toBe(false);
    expect(matchResult({ type: "result", id: "a", code: -2 }, "a")).toEqual({ code: -2 });
    expect(matchResult(JSON.stringify({ type: "result", id: "a", code: -1 }), "a")).toEqual({ code: -1 });
    expect(matchResult({ type: "ack", id: "a" }, "a")).toBeNull();
  });
});

describe("device playback profile", () => {
  it("merges auto and manual (manual wins)", () => {
    const auto = { screen_width: 1920, screen_height: 1080, video: ["h264", "hevc"], audio: ["aac", "mp3"], compat: true, throughput_bps: 15e6 };
    const e = effectivePrefs({ auto, manual: {} });
    expect(e.max_resolution).toBe("1080p");
    expect(e.max_bitrate_bps).toBe(13.5e6);
    expect(e.avoid_hdr).toBe(true);
    expect(constraintsText(constraints(e), (k, v) => `${k}${v ? JSON.stringify(v) : ""}`)).toContain("tvplay.c.no_audio");
    const m = effectivePrefs({ auto, manual: { max_resolution: "2160p", max_bitrate_mbps: 0, hdr: "allow" } });
    expect(m.max_resolution).toBe("2160p");
    expect(m.max_bitrate_bps).toBeNull();
    expect(m.avoid_hdr).toBe(false);
    expect(effectivePrefs({ auto, manual: { max_bitrate_mbps: 25 } }).max_bitrate_bps).toBe(25e6);
  });
  it("screens, presets, suggestions, throughput median", () => {
    expect(resolutionForScreen(3840, 2160)).toBe("2160p");
    expect(resolutionForScreen(1280, 720)).toBe("720p");
    expect(resolutionForScreen(390 * 3, 844 * 3)).toBe("1080p");
    expect(PRESETS.map((p) => p.id)).toEqual(["weak", "normal", "power4k", "phone"]);
    expect(applyPreset({ default_player: "msx" }, "weak")).toMatchObject({ default_player: "msx", max_resolution: "720p", max_bitrate_mbps: 8, preset: "weak" });
    expect(suggestPreset({ auto: { throughput_bps: 5e6 }, manual: {} })).toBe("weak");
    expect(suggestPreset({ auto: { throughput_bps: 5e6 }, manual: { max_resolution: "1080p" } })).toBeNull();
    expect(suggestPreset({ auto: { throughput_bps: 50e6, video: ["h264", "hevc"], screen_width: 3840, screen_height: 2160 }, manual: {} })).toBeNull();
    expect(medianThroughput(pushSample([12e6, 19e6], 15e6))).toBe(15e6);
    expect(pushSample([1, 2, 3, 4, 5, 6, 7], 8)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });
  it("detects this device generically (any model)", () => {
    const a = detectAuto(AMLOGIC, { width: 1920, height: 1080, ua: "x", msx: true, platform: "android-tv", compatServer: true, throughput: 15e6 });
    expect(a.video).toEqual(["h264", "hevc"]);
    expect(a.audio).toEqual(["aac", "mp3"]);
    expect(a.compat).toBe(true);
    expect(a.throughput_bps).toBe(15e6);
    expect(sameAuto(a, { ...a, video: ["hevc", "h264"], detected_at: "now" })).toBe(true);
    expect(sameAuto(a, { ...a, throughput_bps: 20e6 })).toBe(false);
    expect(deviceModel("Mozilla/5.0 (Linux; Android 11; TX3 Build/RQ1A; wv) Chrome/120", true)).toBe("TX3 · Android 11 · MSX");
    expect(deviceModel("Mozilla/5.0 (SMART-TV; Linux; Tizen 6.5) Chrome/85", false)).toBe("Samsung Tizen 6.5");
    expect(detectedSummary(a, (k) => k)).toContain("H.264, HEVC");
  });
});

// Prod, Tanix TX3 Plus (Android 11 WebView inside MSX): the first play after
// the update of an all-DTS/AC3 file had no sound — no compat, no transcoder job.
describe("compat on the first play (TX3 regression)", () => {
  const TOR = { kind: "torrent" as const, compat_url: "/api/v1/stream/t/compat.mp4", mime_type: "video/x-matroska" };
  const DTS_AC3: MediaInfo = {
    ...SHAWSHANK,
    audio: ["dts", "dts", "dts", "ac3", "ac3", "ac3", "dts", "ac3"].map((codec, i) => ({ index: i + 1, codec, language: "rus", title: `T${i}`, channels: 6, default: i === 0 })),
  };
  /** TX3's engine as its device report says: aac/mp3/opus/flac, no ac3/eac3/dts. */
  const TX3: Probe = {
    canPlayType: (t) => (/avc1\.|hvc1|hev1|mp4a\.40\.2|codecs="flac"|codecs="opus"/.test(t) || ["video/mp4", "video/webm", "audio/mpeg", "audio/flac"].includes(t) ? "probably" : ""),
  };

  it("flag unset, compat_url, all tracks DTS/AC3, probe says no → compat from the first load", () => {
    expect(compatServer.get()).toBe(false);
    expect(compatPlan({ ...TOR, media_info: DTS_AC3 }, TX3, "auto")).toBe("compat");
  });
  it("no media_info yet (server ffprobe not run) → wait for it instead of playing silent", () => {
    const release = { video_codec: "h264" as const, audio_codecs: [] as string[] };
    expect(compatPlan({ ...TOR, media_info: null, release }, TX3, "auto")).toBe("wait_info");
    // Parsed codecs that are all undecodable decide right away.
    expect(compatPlan({ ...TOR, media_info: null, release: { ...release, audio_codecs: ["dts", "ac3"] } }, TX3, "auto")).toBe("compat");
    // Nothing to wait for without a compat stream, an MP4/AAC engine, or with «off».
    expect(compatPlan({ ...TOR, compat_url: null, media_info: null, release }, TX3, "auto")).toBe("original");
    expect(compatPlan({ ...TOR, media_info: null, release }, { canPlayType: () => "" }, "auto")).toBe("original");
    expect(compatPlan({ ...TOR, media_info: null, release }, TX3, "off")).toBe("original");
    expect(compatPlan({ ...TOR, media_info: null, release }, TX3, "on")).toBe("compat");
  });
  it("decodable audio plays the original", () => {
    expect(compatPlan({ ...TOR, media_info: { ...DTS_AC3, audio: [{ index: 1, codec: "aac", language: "rus", title: null, channels: 2, default: true }] } }, TX3, "auto")).toBe("original");
  });
  it("Android WebView answering «maybe» for AC3/DTS: not trusted (strict probe) → compat", () => {
    const maybe = (strict: boolean): Probe => ({ canPlayType: (t) => (/ac-3|ac3|dts/.test(t) ? "maybe" : TX3.canPlayType(t)), strict });
    expect(audioSupported(maybe(true), "ac3")).toBe(false);
    expect(audioSupported(maybe(true), "dts")).toBe(false);
    expect(audioSupported(maybe(true), "aac")).toBe(true);
    expect(compatPlan({ ...TOR, media_info: DTS_AC3 }, maybe(true), "auto")).toBe("compat");
    // Desktop / Tizen engines keep the lenient reading.
    expect(audioSupported(maybe(false), "ac3")).toBe(true);
    // A firm answer counts in a WebView too.
    expect(audioSupported({ canPlayType: (t) => (t.includes("ac-3") ? "probably" : ""), strict: true }, "ac3")).toBe(true);
    expect(audioSupported({ canPlayType: () => "maybe", isTypeSupported: (t) => t.includes("ac-3"), strict: true }, "ac3")).toBe(true);
  });
  it("XviD in AVI on Tizen (no MPEG-4 Part 2 decoder): server video conversion from the first load", () => {
    // The Last Duel on prod: avi, mpeg4 ASP 720×304, AC3 5.1.
    const XVID: MediaInfo = { ...SHAWSHANK, container: "avi", video_codec: "mpeg4", video_profile: "Advanced Simple Profile", width: 720, height: 304, audio: [{ index: 1, codec: "ac3", language: null, title: null, channels: 6, default: true }] };
    const tizen: Probe = { canPlayType: (t) => (/avc1\.|hvc1|hev1|mp4a\.40\.2|ac-3/.test(t) || t === "video/mp4" ? "probably" : /mp4v|x-msvideo|avi/.test(t) ? "maybe" : "") };
    const src = { ...TOR, mime_type: "video/x-msvideo", media_info: XVID, compat_video: true };
    expect(videoConvertNeeded(src, assessSource(src, tizen))).toBe(true);
    expect(compatPlan(src, tizen, "auto")).toBe("compat");
    // The server can't convert it (e.g. above 1080p): the original is tried.
    expect(compatPlan({ ...src, compat_video: false }, tizen, "auto")).toBe("original");
    expect(compatPlan(src, tizen, "off")).toBe("original");
    // A TV that decodes XviD firmly plays the original.
    const xvidTv: Probe = { canPlayType: (t) => (/mp4v\.20|x-msvideo/.test(t) ? "probably" : tizen.canPlayType(t)) };
    expect(compatPlan(src, xvidTv, "auto")).toBe("original");
    expect(compatSrc("/s/compat.mp4", { audio: 1, start: 30, video: true })).toBe("/s/compat.mp4?audio=1&start=30&video=h264");
    expect(wantCompat({ compatUrl: "/c", canPlay: true, audioBad: false, pref: "auto", videoBad: true })).toBe(true);
    expect(wantCompat({ compatUrl: "/c", canPlay: true, audioBad: false, pref: "off", videoBad: true })).toBe(false);
  });
  it("ranking: with compat an XviD release is playable and only mildly penalised", () => {
    const tizen: Probe = { canPlayType: (t) => (/avc1\.(64|4d|42)|mp4a\.40\.2/.test(t) || t === "video/mp4" ? "probably" : "") };
    const xvid = { title: "Film.2004.DVDRip.XviD.avi", video_codec: "xvid", audio_codecs: ["ac3"] } as unknown as Release;
    expect(playableHere(xvid, tizen, false)).toBe(false);
    expect(playableHere(xvid, tizen, true)).toBe(true);
    const hi10 = { title: "Anime Hi10P", video_codec: "h264", audio_codecs: ["aac"] } as unknown as Release;
    expect(playableHere(hi10, tizen, true)).toBe(false);
    expect(videoFactor(xvid, tizen, true)).toBe(0.7);
    expect(videoFactor(xvid, tizen, false)).toBe(0.3);
    expect(videoFactor(hi10, tizen, true)).toBe(0.3);
  });
  it("the device report lists audio with the same probe", () => {
    const a = detectAuto({ canPlayType: (t) => (/ac-3|ac3/.test(t) ? "maybe" : TX3.canPlayType(t)), strict: true }, { width: 1920, height: 1080, ua: "x", msx: false, platform: "android-tv", compatServer: false, throughput: null });
    expect(a.audio).toEqual(["aac", "mp3", "opus", "flac"]);
    expect(a.compat).toBe(false);
  });
});

describe("slow-link hint schedule", () => {
  it("shows, auto-hides after 15 s, comes back only after 10 min, at most twice", () => {
    expect(slowHintAllowed(SLOW_LOG0, 0)).toBe(true);
    expect(slowHintExpired(0, SLOW_HINT_MS - 1)).toBe(false);
    expect(slowHintExpired(0, SLOW_HINT_MS)).toBe(true);
    const once = { shows: 1, hiddenAt: 100_000, dismissed: false };
    expect(slowHintAllowed(once, 100_000 + 60_000)).toBe(false);
    expect(slowHintAllowed(once, 100_000 + SLOW_COOLDOWN_MS)).toBe(true);
    expect(slowHintAllowed({ ...once, shows: 2 }, 100_000 + 3 * SLOW_COOLDOWN_MS)).toBe(false);
  });
  it("never again in this playback after Back / «Не сейчас»", () => {
    expect(slowHintAllowed({ shows: 1, hiddenAt: 0, dismissed: true }, 10 * SLOW_COOLDOWN_MS)).toBe(false);
  });
});

describe("Back in Android WebViews (MSX)", () => {
  it("one press arriving as keydown + popstate counts once", () => {
    expect(popIsNewPress(1000, 900)).toBe(false);
    expect(popIsNewPress(1000 + BACK_DEDUPE_MS + 1, 1000)).toBe(true);
    expect(popIsNewPress(5000, -Infinity)).toBe(true);
    expect(keyIsEcho(1100, 1000)).toBe(true);
    expect(keyIsEcho(1000 + BACK_DEDUPE_MS, 1000)).toBe(false);
  });
  it("every TV host gets the history trap (MSX on Android and Tizen, webOS); desktop browsers don't", () => {
    expect(needsBackTrap("android-tv")).toBe(true);
    expect(needsBackTrap("msx")).toBe(true);
    expect(needsBackTrap("tizen")).toBe(true);
    expect(needsBackTrap("webos")).toBe(true);
    expect(needsBackTrap("browser")).toBe(false);
  });
});

describe("resume / phone-chosen source too heavy for this TV", () => {
  // Nata's TX3: link ≈ 17 Mbit/s (cap 15 = 16.7 × 0.9), the resumed source a 24.9 Mbit/s remux.
  const env = { probe: AMLOGIC, rateBps: 15e6 / 0.9, compat: true };
  const heavy = rel("remux", { est_bitrate_bps: 24.9e6, audio_codecs: ["dts", "ac3"] });
  const bdrip = rel("bdrip", { est_bitrate_bps: 10.4e6, audio_codecs: ["ac3"] });
  const web = rel("web", { est_bitrate_bps: 6e6, audio_codecs: ["ac3"] });
  const aac = rel("aac", { est_bitrate_bps: 6e6, audio_codecs: ["aac"] });
  it("switches to the best suitable release (server order kept)", () => {
    expect(tooHeavyHere(heavy, env)).toBe(true);
    expect(lighterInstead(heavy, [heavy, bdrip, web], env)?.id).toBe("bdrip");
  });
  it("keeps a source that fits, or when nothing lighter fits", () => {
    expect(lighterInstead(bdrip, [heavy, bdrip, web], env)).toBeNull();
    expect(lighterInstead(heavy, [heavy, rel("other", { est_bitrate_bps: 30e6 })], env)).toBeNull();
  });
  it("undecodable audio counts only without compat", () => {
    const fits = rel("dts", { est_bitrate_bps: 8e6, audio_codecs: ["dts"] });
    expect(tooHeavyHere(fits, env)).toBe(false);
    expect(tooHeavyHere(fits, { ...env, compat: false })).toBe(true);
    expect(lighterInstead(fits, [fits, web, aac], { ...env, compat: false })?.id).toBe("aac");
  });
  it("unmeasured TV: the device profile's cap (unmeasured-TV preset) judges", () => {
    expect(effectivePrefs({ auto: { platform: "android-tv" }, manual: {} }).max_bitrate_bps).toBe(15e6);
    expect(effectivePrefs({ auto: { platform: "browser" }, manual: {} }).max_bitrate_bps).toBeNull();
    expect(effectivePrefs({ auto: { platform: "android-tv", throughput_bps: 40e6 }, manual: {} }).max_bitrate_bps).toBe(36e6);
    expect(tooHeavyHere(heavy, { probe: AMLOGIC, rateBps: 15e6 / 0.9, compat: true })).toBe(true);
  });
});

describe("session rate sample", () => {
  it("never remembers less than a session proved (warm-up dips don't count)", () => {
    expect(sessionSample(1.5e6, 20e6 * 1.2)).toBe(24e6);
    expect(sessionSample(30e6, 24e6)).toBe(30e6);
    expect(sessionSample(null, 24e6)).toBe(24e6);
    expect(sessionSample(7e6, null)).toBe(7e6);
    expect(sessionSample(null, null)).toBeNull();
  });
  it("the slow-connection hint is off until turned on on this TV", () => {
    expect(slowHintPref.get()).toBe(false);
    slowHintPref.set(false);
    expect(slowHintPref.get()).toBe(false);
    slowHintPref.set(true);
    expect(slowHintPref.get()).toBe(true);
  });
  it("«Показывать буфер» is off until turned on on this TV", () => {
    expect(prebufferPref.get()).toBe(false);
    prebufferPref.set(true);
    expect(prebufferPref.get()).toBe(true);
    prebufferPref.set(false);
    expect(prebufferPref.get()).toBe(false);
  });
});

describe("audioProbeAnswers (error reports)", () => {
  it("lists the engine's answers for a codec's types", () => {
    const probe = { canPlayType: (t: string) => (t.includes("dts") ? "maybe" : "") };
    const a = audioProbeAnswers(probe, "dts")!;
    expect(a).toContain("vnd.dts=maybe");
    expect(a).toContain("dts=maybe");
    expect(audioProbeAnswers({ canPlayType: () => "" }, "ac3")).toContain("=no");
    expect(audioProbeAnswers({ canPlayType: () => "" }, "weird")).toBeNull();
  });
});
