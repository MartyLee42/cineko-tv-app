import { describe, expect, it } from "vitest";
import { applyPreset } from "@martytv/media-types";
import { decodableCodecs, detectBrowser, type Probe } from "../play/browserSupport";
import { releaseParams } from "../play/releases";
import { releasesKey } from "../play/queries";
import {
  autoSignature,
  browserAuto,
  capFromConstraints,
  CLIENT_ID_KEY,
  clientId,
  decodeOpt,
  detectedSummary,
  encodeOpt,
  heavyMbps,
  isAllAuto,
  newClientId,
  optionLabel,
  platformModel,
  readSamples,
  recordSample,
  ROWS,
  rowOptions,
  rowsFor,
  SAMPLES_KEY,
  sessionThroughput,
  setRow,
  shouldSync,
  SYNC_EVERY_MS,
  toAuto,
  type KV,
} from "./logic";

function memKV(init: Record<string, string> = {}): KV & { m: Map<string, string> } {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

const t = (k: string, v?: Record<string, string | number>) => (v ? `${k}(${Object.values(v).join(",")})` : k);

describe("client id", () => {
  it("is random base64url of 22 chars", () => {
    const id = newClientId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newClientId()).not.toBe(id);
    expect(newClientId(() => new Uint8Array(16).fill(255))).toBe("_____________________w");
  });

  it("is created once and kept in storage", () => {
    const kv = memKV();
    const a = clientId(kv);
    expect(kv.m.get(CLIENT_ID_KEY)).toBe(a);
    expect(clientId(kv)).toBe(a);
  });

  it("replaces an invalid stored value", () => {
    const kv = memKV({ [CLIENT_ID_KEY]: "bad id!" });
    const a = clientId(kv);
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(kv.m.get(CLIENT_ID_KEY)).toBe(a);
  });

  it("survives storage that throws (stable for the page)", () => {
    const broken: KV = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => undefined,
    };
    const a = clientId(broken);
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(clientId(broken)).toBe(a);
    expect(clientId(null)).toBe(a);
  });
});

describe("platform / model", () => {
  const cases: [string, number, string, string][] = [
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      5,
      "iOS",
      "iPhone · Safari 18",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      0,
      "Windows",
      "Windows · Chrome 141",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
      0,
      "Windows",
      "Windows · Edge 141",
    ],
    ["Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0", 5, "Android", "Android 14 · Firefox 131"],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
      0,
      "macOS",
      "Mac · Safari 17",
    ],
    // iPadOS reports a Mac with touch points.
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      5,
      "iOS",
      "iPad · Safari 18",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1",
      5,
      "iOS",
      "iPhone · Chrome 141",
    ],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0", 0, "Linux", "Linux · Firefox 140"],
  ];
  it.each(cases)("%s", (ua, touch, platform, model) => {
    expect(platformModel(ua, touch)).toEqual({ platform, model });
  });
  it("falls back to «Browser»", () => {
    expect(platformModel("", 0)).toEqual({ platform: "", model: "Browser" });
  });
});

describe("throughput samples", () => {
  it("session sample = median of the estimates, ≥ 3 needed", () => {
    expect(sessionThroughput([])).toBeNull();
    expect(sessionThroughput([5e6, 6e6])).toBeNull();
    expect(sessionThroughput([5e6, 30e6, 6e6, NaN, 0])).toBe(6e6);
  });

  it("keeps the last 12 samples and returns the rolling median of 7", () => {
    const kv = memKV();
    expect(recordSample(10e6, kv)).toBe(10e6);
    expect(recordSample(20e6, kv)).toBe(15e6);
    for (let i = 0; i < 15; i++) recordSample(4e6, kv);
    expect(readSamples(kv)).toHaveLength(12);
    expect(recordSample(50e6, kv)).toBe(4e6);
  });

  it("ignores junk in storage", () => {
    expect(readSamples(memKV({ [SAMPLES_KEY]: "{oops" }))).toEqual([]);
    expect(readSamples(memKV({ [SAMPLES_KEY]: '[1e6,"x",-5,null]' }))).toEqual([1e6]);
  });
});

describe("browser auto", () => {
  const chrome = detectBrowser("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36");
  // A Chromium-like probe: H.264, VP9, AV1, AAC, MP3, Opus, FLAC; MSE for hls.js.
  const yes = ["avc1", "vp9", "vp09", "av01", "mp4a.40.2", "audio/mpeg", "opus", "flac"];
  const probe: Probe = {
    canPlayType: (type) => (yes.some((y) => type.includes(y)) ? "probably" : ""),
    isTypeSupported: (type) => yes.some((y) => type.includes(y)),
  };

  it("lists decodable codecs in contract tokens", () => {
    const d = decodableCodecs(probe, chrome);
    expect(d.video).toEqual(["h264", "vp9", "av1"]);
    expect(d.audio).toEqual(["aac", "mp3", "opus", "flac"]);
    // Chromium demuxes MKV although canPlayType says no.
    expect(d.containers).toEqual(["mkv", "mp4"]);
    expect(d.hls).toBe(true);
    expect(decodableCodecs(probe, chrome, true).video).toContain("hdr10");
  });

  it("reports an iPad opened upright as landscape (1640×2360 → 2360×1640)", () => {
    const a = browserAuto({
      ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
      maxTouchPoints: 5,
      screen: { width: 820, height: 1180, dpr: 2 },
      decodable: { video: ["h264"], audio: ["aac"], containers: ["mp4"], hls: true },
      compat: true,
      throughput: null,
    });
    expect([a.screen_width, a.screen_height]).toEqual([2360, 1640]);
  });

  it("builds PlaybackAuto with physical pixels, landscape (held upright: still long × short)", () => {
    const a = browserAuto({
      ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      maxTouchPoints: 5,
      screen: { width: 390, height: 844, dpr: 3 },
      decodable: { video: ["h264", "hevc"], audio: ["aac", "ac3", "eac3"], containers: ["mp4"], hls: true },
      compat: true,
      throughput: 12_345_678.9,
    });
    expect(a).toEqual({
      screen_width: 2532,
      screen_height: 1170,
      video: ["h264", "hevc"],
      audio: ["aac", "ac3", "eac3"],
      containers: ["mp4"],
      hls: true,
      compat: true,
      throughput_bps: 12_345_679,
      model: "iPhone · Safari 18",
      platform: "iOS",
    });
  });

  it("re-reports only when changed or after 12 h", () => {
    const sig = autoSignature({ throughput_bps: 12.3e6, detected_at: "a" });
    expect(autoSignature({ throughput_bps: 12.1e6, detected_at: "b" })).toBe(sig);
    expect(autoSignature({ throughput_bps: 20e6 })).not.toBe(sig);
    expect(shouldSync(null, sig, 1000)).toBe(true);
    expect(shouldSync({ at: 1000, sig }, sig, 2000)).toBe(false);
    expect(shouldSync({ at: 1000, sig }, sig, 2000, true)).toBe(true);
    expect(shouldSync({ at: 1000, sig }, "other", 2000)).toBe(true);
    expect(shouldSync({ at: 1000, sig }, sig, 1000 + SYNC_EVERY_MS)).toBe(true);
  });

  it("normalizes the API's nullable booleans", () => {
    expect(toAuto({ hls: null, compat: true, video: ["h264"] })).toEqual({ compat: true, video: ["h264"] });
    expect(toAuto(null)).toBeUndefined();
  });
});

describe("settings rows", () => {
  it("browsers have no default-player row", () => {
    expect(rowsFor("browser").map((r) => r.key)).not.toContain("default_player");
    expect(rowsFor("tv").map((r) => r.key)).toContain("default_player");
  });

  it("encodes / decodes select values (numbers stay numbers)", () => {
    const bitrate = ROWS.find((r) => r.key === "max_bitrate_mbps")!;
    expect(encodeOpt(null)).toBe("auto");
    expect(encodeOpt(0)).toBe("0");
    expect(decodeOpt(bitrate, "15")).toBe(15);
    expect(decodeOpt(bitrate, "0")).toBe(0);
    expect(decodeOpt(bitrate, "auto")).toBeNull();
    expect(decodeOpt(bitrate, "999")).toBeNull();
  });

  it("keeps a value set elsewhere selectable", () => {
    const bitrate = ROWS.find((r) => r.key === "max_bitrate_mbps")!;
    expect(rowOptions(bitrate, { max_bitrate_mbps: 12 })).toContain(12);
    expect(rowOptions(bitrate, { max_bitrate_mbps: 15 })).toEqual(bitrate.options);
  });

  it("labels options, «Авто (…)» from what was detected", () => {
    const auto = { screen_width: 1920, screen_height: 1080, throughput_bps: 20e6, video: ["h264"] };
    expect(optionLabel("max_resolution", null, t, auto)).toBe("tvplay.auto_value(1080p)");
    expect(optionLabel("max_resolution", "2160p", t)).toBe("4K");
    expect(optionLabel("max_bitrate_mbps", null, t, auto)).toBe("tvplay.auto_value(tvplay.mbps(18))");
    expect(optionLabel("max_bitrate_mbps", 0, t)).toBe("tvplay.unlimited");
    expect(optionLabel("max_size_gb", 8, t)).toBe("tvplay.gb(8)");
    expect(optionLabel("hdr", null, t, auto)).toBe("tvplay.auto_value(tvplay.hdr.avoid)");
    expect(optionLabel("audio", "always_compat", t)).toBe("tvplay.audio.always_compat");
    expect(optionLabel("default_player", "msx", t)).toBe("tvplay.player.msx");
    expect(optionLabel("video_codec", "hevc", t)).toBe("HEVC");
    expect(optionLabel("video_codec", null, t, {})).toBe("tvplay.auto");
  });

  it("set / reset / preset", () => {
    const m = setRow({}, "max_resolution", "720p");
    expect(m).toEqual({ max_resolution: "720p" });
    expect(isAllAuto(m)).toBe(false);
    expect(isAllAuto(setRow(m, "max_resolution", null))).toBe(true);
    expect(isAllAuto({})).toBe(true);
    const p = applyPreset({ default_player: "msx" }, "weak");
    expect(p).toMatchObject({ preset: "weak", max_resolution: "720p", max_bitrate_mbps: 8, default_player: "msx" });
  });

  it("summarizes what was detected", () => {
    expect(detectedSummary(null, t)).toEqual([]);
    const s = detectedSummary({ model: "iPhone · Safari 18", screen_width: 1170, screen_height: 2532, video: ["h264", "hevc"], audio: ["aac"], compat: true, throughput_bps: 12.34e6 }, t);
    expect(s.map((x) => x.value)).toEqual(["iPhone · Safari 18", "2532×1170 (1080p)", "H.264, HEVC", "AAC · tvplay.device.compat_yes", "tvplay.mbps(12.3)"]);
  });
});

describe("release list", () => {
  it("heavy chip only above the cap", () => {
    const cap = capFromConstraints([{ code: "max_resolution" }, { code: "max_bitrate", mbps: 15 }]);
    expect(cap).toBe(15e6);
    expect(heavyMbps(39.4e6, cap)).toBe(39);
    expect(heavyMbps(12e6, cap)).toBeNull();
    expect(heavyMbps(null, cap)).toBeNull();
    expect(heavyMbps(39e6, capFromConstraints([]))).toBeNull();
  });

  it("passes device_id / client_id / device_prefs=off", () => {
    const tgt = { media_id: "m" };
    expect(releaseParams(tgt, { rank: { device_id: "d1" } })).toEqual({ device_id: "d1" });
    expect(releaseParams(tgt, { rank: { client_id: "c1", all: true } })).toEqual({ client_id: "c1", device_prefs: "off" });
    expect(releaseParams(tgt, { rank: {} })).toEqual({});
  });

  it("caches per ranking target", () => {
    expect(releasesKey({ media_id: "m" }, "p", "ru")).toHaveLength(6);
    expect(releasesKey({ media_id: "m" }, "p", "ru", undefined, { device_id: "d" }).at(-1)).toEqual({ rank: "d", all: false });
    expect(releasesKey({ media_id: "m" }, "p", "ru", undefined, { device_id: "d", all: true }).at(-1)).toEqual({ rank: "d", all: true });
  });
});
