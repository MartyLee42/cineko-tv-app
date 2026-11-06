// Per-device playback profiles («Это устройство»), shared by the TV app and
// the PWA. Structural types mirroring the contract's PlaybackPrefs (no
// dependency on the generated contracts). The server merges `auto` and
// `manual` the same way for release ranking (internal/devices/playbackprefs.go).
//
// - auto: what the device detected itself (codecs, screen, throughput…);
// - manual: the user's overrides (missing / null field = automatic);
// - effective: manual wins over auto.
// Nothing here is device-specific: a TV, a phone and a laptop browser all
// use the same model, and presets are just bundles of manual values.

export type MaxResolution = "720p" | "1080p" | "2160p";
export type VideoCodecPref = "h264" | "hevc";
export type AudioPref = "prefer_aac_ac3" | "avoid_dts_truehd" | "always_compat";
export type DefaultPlayer = "builtin" | "msx" | "external";

/** Detected by the device itself (PATCHed on start and after playback). */
export interface PlaybackAuto {
  /** Physical screen pixels (CSS × DPR). */
  screen_width?: number | null;
  screen_height?: number | null;
  /** Decodable video: h264, hevc, vp9, av1, hdr10, dv. */
  video?: string[];
  /** Decodable audio: aac, ac3, eac3, dts, truehd. */
  audio?: string[];
  /** Playable containers: mkv, mp4, ts. */
  containers?: string[];
  hls?: boolean;
  /** The server offers compat streams (AAC transcode). */
  compat?: boolean;
  /** Rolling estimate (median of recent sessions), bits/s. */
  throughput_bps?: number | null;
  /** «TX3 · Android 11 · MSX», «iPhone · Safari 18». */
  model?: string | null;
  platform?: string | null;
  detected_at?: string | null;
}

/** The user's overrides; null / missing = automatic. */
export interface PlaybackManual {
  /** The preset last applied (informational). */
  preset?: string | null;
  max_resolution?: MaxResolution | null;
  /** null = auto (from measured throughput), 0 = unlimited, else Mbit/s. */
  max_bitrate_mbps?: number | null;
  max_size_gb?: number | null;
  video_codec?: VideoCodecPref | null;
  hdr?: "allow" | "avoid" | null;
  audio?: AudioPref | null;
  default_player?: DefaultPlayer | null;
  prefer_smaller?: boolean | null;
}

export interface PlaybackPrefsLike {
  auto: PlaybackAuto;
  manual: PlaybackManual;
}

/** What ranking uses. Null limits = none. */
export interface EffectivePrefs {
  max_resolution: MaxResolution | null;
  max_bitrate_bps: number | null;
  max_size_gb: number | null;
  video_codec: VideoCodecPref | null;
  avoid_hdr: boolean;
  audio: AudioPref | null;
  prefer_smaller: boolean;
  /** Decodable codecs (null = unknown: don't judge). */
  video: string[] | null;
  audio_codecs: string[] | null;
  compat: boolean;
  default_player: DefaultPlayer | null;
}

/** Share of the measured throughput a release may use (headroom for seeks / dips). */
export const THROUGHPUT_HEADROOM = 0.9;

/**
 * TV-class devices (boxes, smart-TV engines, MSX) that never measured their
 * link: the «normal» preset's bitrate limit until a session does (first
 * plays otherwise picked 25+ Mbit/s remuxes on 15 Mbit/s links). Mirrors
 * devices.UnmeasuredTVBitrateMbps on the server.
 */
export const TV_PLATFORMS = ["android-tv", "tizen", "webos", "msx"];
export const UNMEASURED_TV_PRESET = "normal";

/** The unmeasured-TV cap (bits/s) for this auto profile, or null when it doesn't apply. */
export function unmeasuredCapBps(a: PlaybackAuto, m: PlaybackManual = {}): number | null {
  if (m.max_bitrate_mbps != null || (a.throughput_bps && a.throughput_bps > 0)) return null;
  if (!a.platform || !TV_PLATFORMS.includes(a.platform)) return null;
  const mbps = PRESETS.find((p) => p.id === UNMEASURED_TV_PRESET)?.manual.max_bitrate_mbps;
  return mbps ? mbps * 1e6 : null;
}

/** Screen → highest useful resolution (4K panels report 3840 or 1920 × DPR 2). */
/**
 * A screen size as landscape (long × short): tablets and phones report the
 * orientation they were held in («2360×1640», not «1640×2360»); video plays landscape.
 */
export function landscapeSize(w: number | null | undefined, h: number | null | undefined): { width: number | null; height: number | null } {
  if (!w || !h) return { width: w || null, height: h || null };
  return { width: Math.max(w, h), height: Math.min(w, h) };
}

export function resolutionForScreen(w: number | null | undefined, h: number | null | undefined): MaxResolution | null {
  if (!w || !h) return null;
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  if (long >= 3200 || short >= 1800) return "2160p";
  if (long >= 1800 || short >= 1000) return "1080p";
  return "720p";
}

/** auto + manual → effective (manual wins). */
export function effectivePrefs(p: PlaybackPrefsLike | null | undefined): EffectivePrefs {
  const a = p?.auto ?? {};
  const m = p?.manual ?? {};
  let bitrate: number | null;
  if (m.max_bitrate_mbps === 0) bitrate = null;
  else if (m.max_bitrate_mbps != null && m.max_bitrate_mbps > 0) bitrate = m.max_bitrate_mbps * 1e6;
  else if (a.throughput_bps && a.throughput_bps > 0) bitrate = Math.round(a.throughput_bps * THROUGHPUT_HEADROOM);
  else bitrate = unmeasuredCapBps(a, m);
  return {
    max_resolution: m.max_resolution ?? resolutionForScreen(a.screen_width, a.screen_height),
    max_bitrate_bps: bitrate,
    max_size_gb: m.max_size_gb && m.max_size_gb > 0 ? m.max_size_gb : null,
    video_codec: m.video_codec ?? null,
    avoid_hdr: m.hdr === "avoid" || (m.hdr == null && !!a.video && !a.video.includes("hdr10") && !a.video.includes("dv")),
    audio: m.audio ?? null,
    prefer_smaller: !!m.prefer_smaller,
    video: a.video && a.video.length > 0 ? a.video : null,
    audio_codecs: a.audio && a.audio.length > 0 ? a.audio : null,
    compat: !!a.compat,
    default_player: m.default_player ?? null,
  };
}

// ---------------------------------------------------------------- presets

export interface Preset {
  id: string;
  /** i18n key suffix: tvplay.preset.<id> / tvplay.preset.<id>_desc. */
  manual: PlaybackManual;
}

/**
 * One-tap bundles of manual values (then tweakable). Add new ones here; the
 * UIs list this table and the i18n keys tvplay.preset.<id>[_desc].
 */
export const PRESETS: readonly Preset[] = [
  { id: "weak", manual: { max_resolution: "720p", max_bitrate_mbps: 8, video_codec: "h264", hdr: "avoid", audio: "always_compat", prefer_smaller: true } },
  { id: "normal", manual: { max_resolution: "1080p", max_bitrate_mbps: 15, video_codec: null, hdr: "avoid", audio: null, prefer_smaller: false } },
  { id: "power4k", manual: { max_resolution: "2160p", max_bitrate_mbps: 0, video_codec: "hevc", hdr: "allow", audio: null, prefer_smaller: false } },
  { id: "phone", manual: { max_resolution: "720p", max_bitrate_mbps: null, max_size_gb: 4, video_codec: null, hdr: "avoid", audio: null, prefer_smaller: true } },
];

/** Applies a preset over the current manual values (keeps the default player). */
export function applyPreset(cur: PlaybackManual, id: string): PlaybackManual {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return cur;
  return { ...cur, ...p.manual, preset: id };
}

/**
 * First-run suggestion: a preset id when the detected device looks weak or
 * the connection slow (no manual values yet), else null.
 */
export function suggestPreset(p: PlaybackPrefsLike | null | undefined): string | null {
  if (!p) return null;
  const m = p.manual ?? {};
  if (Object.values(m).some((v) => v !== null && v !== undefined)) return null;
  const a = p.auto ?? {};
  const slow = !!a.throughput_bps && a.throughput_bps < 8e6;
  const small = resolutionForScreen(a.screen_width, a.screen_height) === "720p";
  const noHevc = !!a.video && a.video.length > 0 && !a.video.includes("hevc");
  if (slow || (small && noHevc)) return "weak";
  return null;
}

// ---------------------------------------------------------------- summary

/** One applied constraint, for «подобрано для этого ТВ: до 1080p, ≤ 15 Мбит/с, без DTS». */
export type Constraint =
  | { code: "max_resolution"; value: MaxResolution }
  | { code: "max_bitrate"; mbps: number }
  | { code: "max_size"; gb: number }
  | { code: "codec"; value: VideoCodecPref }
  | { code: "no_hdr" }
  | { code: "no_audio"; codecs: string[] }
  | { code: "compat_audio" }
  | { code: "smaller" };

const HEAVY_AUDIO = ["ac3", "eac3", "dts", "truehd"];

export function constraints(e: EffectivePrefs): Constraint[] {
  const out: Constraint[] = [];
  if (e.max_resolution && e.max_resolution !== "2160p") out.push({ code: "max_resolution", value: e.max_resolution });
  if (e.max_bitrate_bps) out.push({ code: "max_bitrate", mbps: Math.round(e.max_bitrate_bps / 1e6) });
  if (e.max_size_gb) out.push({ code: "max_size", gb: e.max_size_gb });
  if (e.video_codec) out.push({ code: "codec", value: e.video_codec });
  if (e.avoid_hdr) out.push({ code: "no_hdr" });
  if (e.audio === "always_compat") out.push({ code: "compat_audio" });
  else {
    const missing =
      e.audio === "avoid_dts_truehd"
        ? ["dts", "truehd"]
        : e.audio === "prefer_aac_ac3"
          ? ["eac3", "dts", "truehd"]
          : e.audio_codecs
            ? HEAVY_AUDIO.filter((c) => !e.audio_codecs!.includes(c))
            : [];
    if (missing.length > 0) out.push({ code: "no_audio", codecs: missing });
  }
  if (e.prefer_smaller) out.push({ code: "smaller" });
  return out;
}

const AUDIO_LABEL: Record<string, string> = { ac3: "AC3", eac3: "E-AC3", dts: "DTS", truehd: "TrueHD" };

/** A constraint as the API sends it (ReleaseList.device.constraints, PlaybackPrefs.constraints). */
export interface ConstraintLike {
  code: string;
  value?: string | null;
  mbps?: number;
  gb?: number;
  codecs?: string[];
}

/** Short human text of one constraint (numbers/codecs; words come from i18n). Unknown codes → "". */
export function constraintText(c: ConstraintLike, t: (k: string, v?: Record<string, string | number>) => string): string {
  switch (c.code) {
    case "max_resolution":
      return t("tvplay.c.max_resolution", { value: c.value === "2160p" ? "4K" : (c.value ?? "") });
    case "max_bitrate":
      return t("tvplay.c.max_bitrate", { mbps: c.mbps ?? 0 });
    case "max_size":
      return t("tvplay.c.max_size", { gb: c.gb ?? 0 });
    case "codec":
      return t("tvplay.c.codec", { codec: c.value === "hevc" ? "HEVC" : "H.264" });
    case "no_hdr":
      return t("tvplay.c.no_hdr");
    case "no_audio":
      return t("tvplay.c.no_audio", { codecs: (c.codecs ?? []).map((x) => AUDIO_LABEL[x] ?? x.toUpperCase()).join("/") });
    case "compat_audio":
      return t("tvplay.c.compat_audio");
    case "smaller":
      return t("tvplay.c.smaller");
    default:
      return "";
  }
}

/** «до 1080p, ≤ 15 Мбит/с, без DTS» (empty constraints → ""). */
export function constraintsText(list: readonly ConstraintLike[] | null | undefined, t: (k: string, v?: Record<string, string | number>) => string): string {
  return (list ?? [])
    .map((c) => constraintText(c, t))
    .filter(Boolean)
    .join(", ");
}

// ---------------------------------------------------------------- throughput

/** Median of recent throughput samples (bits/s), or null. */
export function medianThroughput(samples: readonly number[]): number | null {
  const s = samples.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** Keeps the last `n` session samples (newest last). */
export function pushSample(samples: readonly number[], bps: number, n = 7): number[] {
  if (!Number.isFinite(bps) || bps <= 0) return [...samples];
  return [...samples, Math.round(bps)].slice(-n);
}

/** Average bitrate of a release/file (bits/s): size × 8 / duration. */
export function releaseBitrate(sizeBytes: number | null | undefined, durationSeconds: number | null | undefined): number | null {
  if (!sizeBytes || !durationSeconds || sizeBytes <= 0 || durationSeconds <= 0) return null;
  return (sizeBytes * 8) / durationSeconds;
}
