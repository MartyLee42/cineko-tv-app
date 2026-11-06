// Per-device playback profiles on the PWA («Это устройство»): this browser's
// stable id, what it detects about itself (PlaybackAuto), measured throughput
// samples and the settings rows. Pure (storage / probe injected) so it is
// unit-tested; the shared model lives in @martytv/media-types/playbackPrefs.
import {
  addThroughputSample,
  currentThroughput,
  effectivePrefs,
  landscapeSize,
  medianThroughput,
  parseSamples,
  resolutionForScreen,
  type PlaybackAuto,
  type PlaybackManual,
  type SampleSource,
  type ThroughputSample,
} from "@martytv/media-types";
import type { MessageKey } from "@martytv/ui";
import { detectBrowser, type Decodable } from "../play/browserSupport";

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** localStorage-like (tests pass a Map-backed fake). */
export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

function get(kv: KV | null, k: string): string | null {
  try {
    return kv?.getItem(k) ?? null;
  } catch {
    return null;
  }
}

function set(kv: KV | null, k: string, v: string | null): void {
  try {
    if (v == null) kv?.removeItem(k);
    else kv?.setItem(k, v);
  } catch {
    // private mode / quota
  }
}

/** window.localStorage, or null where it throws (blocked storage). */
export function storage(): KV | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** The API's auto record (nullable booleans) → the shared model's. */
export function toAuto<A extends Omit<PlaybackAuto, "hls" | "compat"> & { hls?: boolean | null; compat?: boolean | null }>(
  a: A | null | undefined,
): PlaybackAuto | undefined {
  if (!a) return undefined;
  const { hls, compat, ...rest } = a;
  return { ...rest, ...(hls != null && { hls }), ...(compat != null && { compat }) };
}

/** The app's typed `t` for the shared helpers that take plain string keys (constraintText). */
export function looseT(t: T): (k: string, v?: Record<string, string | number>) => string {
  return (k, v) => t(k as MessageKey, v);
}

// ---------------------------------------------------------------- client id

export const CLIENT_ID_KEY = "martytv.client_id";
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Random base64url id (22 chars from 16 random bytes). */
export function newClientId(rand: (n: number) => Uint8Array = randomBytes): string {
  const b = rand(16);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(b);
  else for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
  return b;
}

let memoryId: string | null = null;

/**
 * This browser's stable id (`martytv.client_id`), created on first use. With
 * storage blocked it lives for the page only (the record is then per visit).
 */
export function clientId(kv: KV | null = storage(), rand?: (n: number) => Uint8Array): string {
  const cur = get(kv, CLIENT_ID_KEY);
  if (cur && ID_RE.test(cur)) return cur;
  const id = newClientId(rand);
  set(kv, CLIENT_ID_KEY, id);
  if (get(kv, CLIENT_ID_KEY) === id) return id;
  return (memoryId ??= id);
}

// ---------------------------------------------------------------- platform / model

const major = (ua: string, re: RegExp) => ua.match(re)?.[1] ?? null;

/**
 * «iPhone · Safari 18», «Windows · Chrome 141», «Android 14 · Firefox 131»
 * from the user agent; platform is the OS family (iOS, Android, Windows,
 * macOS, ChromeOS, Linux).
 */
export function platformModel(ua: string, maxTouchPoints = 0): { platform: string; model: string } {
  const env = detectBrowser(ua, maxTouchPoints);
  let platform = "";
  let deviceLabel = "";
  if (env.ios) {
    platform = "iOS";
    deviceLabel = /ipad/i.test(ua) || /macintosh/i.test(ua) ? "iPad" : /ipod/i.test(ua) ? "iPod" : "iPhone";
  } else if (env.android) {
    platform = "Android";
    const v = major(ua, /Android (\d+)/i);
    deviceLabel = v ? `Android ${v}` : "Android";
  } else if (env.windows) {
    platform = deviceLabel = "Windows";
  } else if (/CrOS/.test(ua)) {
    platform = deviceLabel = "ChromeOS";
  } else if (env.apple) {
    platform = "macOS";
    deviceLabel = "Mac";
  } else if (/linux/i.test(ua)) {
    platform = deviceLabel = "Linux";
  }

  let browser = "";
  const pick = (name: string, re: RegExp) => {
    const v = major(ua, re);
    browser = v ? `${name} ${v}` : name;
  };
  if (/Edg(e|A|iOS)?\//.test(ua)) pick("Edge", /Edg(?:e|A|iOS)?\/(\d+)/);
  else if (/OPR\/|Opera/.test(ua)) pick("Opera", /OPR\/(\d+)/);
  else if (/YaBrowser\//.test(ua)) pick("Yandex", /YaBrowser\/(\d+)/);
  else if (/SamsungBrowser\//.test(ua)) pick("Samsung Internet", /SamsungBrowser\/(\d+)/);
  else if (/Firefox\/|FxiOS\//.test(ua)) pick("Firefox", /(?:Firefox|FxiOS)\/(\d+)/);
  else if (/CriOS\//.test(ua)) pick("Chrome", /CriOS\/(\d+)/);
  else if (/Chrome\//.test(ua)) pick("Chrome", /Chrome\/(\d+)/);
  else if (/Safari\//.test(ua) && env.apple) pick("Safari", /Version\/(\d+)/);
  const model = [deviceLabel, browser].filter(Boolean).join(" · ") || "Browser";
  return { platform, model };
}

// ---------------------------------------------------------------- throughput samples

export const SAMPLES_KEY = "martytv.throughput";

/** This browser's throughput samples (playback sessions + speed tests; legacy number arrays accepted). */
export function readSampleList(kv: KV | null = storage()): ThroughputSample[] {
  try {
    return parseSamples(JSON.parse(get(kv, SAMPLES_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

/** The samples' speeds (bits/s), oldest first. */
export function readSamples(kv: KV | null = storage()): number[] {
  return readSampleList(kv).map((s) => s.bps);
}

/** The current estimate (bits/s): the newest speed test weighs most. */
export function currentEstimate(kv: KV | null = storage(), now = Date.now()): number | null {
  return currentThroughput(readSampleList(kv), now);
}

/**
 * One playback session's throughput: the median of the rate estimates taken
 * while the buffer was filling (null under 3 estimates — too short to tell).
 */
export function sessionThroughput(estimates: readonly number[]): number | null {
  const ok = estimates.filter((x) => Number.isFinite(x) && x > 0);
  return ok.length >= 3 ? medianThroughput(ok) : null;
}

/** Stores a sample (a playback session or a speed test); returns the new estimate (bits/s). */
export function recordSample(bps: number, kv: KV | null = storage(), src: SampleSource = "playback", now = Date.now()): number | null {
  const next = addThroughputSample(readSampleList(kv), { bps, at: now, src });
  set(kv, SAMPLES_KEY, JSON.stringify(next));
  return currentThroughput(next, now);
}

// ---------------------------------------------------------------- auto (what this browser detects)

export interface BrowserFacts {
  ua: string;
  maxTouchPoints: number;
  /** CSS pixels and devicePixelRatio. */
  screen: { width: number; height: number; dpr: number } | null;
  decodable: Decodable;
  compat: boolean;
  throughput: number | null;
}

/** This browser's PlaybackAuto (detected_at left to the caller). */
export function browserAuto(f: BrowserFacts): PlaybackAuto {
  const { platform, model } = platformModel(f.ua, f.maxTouchPoints);
  const dpr = f.screen?.dpr && f.screen.dpr > 0 ? f.screen.dpr : 1;
  const px = (n: number | undefined) => (n && n > 0 ? Math.min(16384, Math.round(n * dpr)) : null);
  const size = landscapeSize(px(f.screen?.width), px(f.screen?.height));
  return {
    screen_width: size.width,
    screen_height: size.height,
    video: f.decodable.video,
    audio: f.decodable.audio,
    containers: f.decodable.containers,
    hls: f.decodable.hls,
    compat: f.compat,
    throughput_bps: f.throughput != null && f.throughput > 0 ? Math.round(f.throughput) : null,
    model,
    platform,
  };
}

/** Stable signature of an auto record (ignores detected_at) for change detection. */
export function autoSignature(a: { detected_at?: string | null; throughput_bps?: number | null }): string {
  // Throughput moves a little every session: compare it in whole Mbit/s.
  return JSON.stringify({ ...a, detected_at: undefined, throughput_bps: a.throughput_bps ? Math.round(a.throughput_bps / 1e6) : null });
}

export const SYNC_EVERY_MS = 12 * 3600_000;

/** Re-report when forced, never reported, changed, or older than 12 h. */
export function shouldSync(last: { at: number; sig: string } | null, sig: string, now: number, force = false): boolean {
  return force || !last || last.sig !== sig || now - last.at >= SYNC_EVERY_MS || now < last.at;
}

export function syncKey(userId: string): string {
  return `martytv.client_sync.${userId}`;
}

export function readLastSync(userId: string, kv: KV | null = storage()): { at: number; sig: string } | null {
  try {
    const v = JSON.parse(get(kv, syncKey(userId)) ?? "null") as { at?: unknown; sig?: unknown } | null;
    return v && typeof v.at === "number" && typeof v.sig === "string" ? { at: v.at, sig: v.sig } : null;
  } catch {
    return null;
  }
}

export function writeLastSync(userId: string, v: { at: number; sig: string }, kv: KV | null = storage()): void {
  set(kv, syncKey(userId), JSON.stringify(v));
}

// ---------------------------------------------------------------- first-run suggestion

export const SUGGEST_DISMISSED_KEY = "martytv.devprefs.suggest_dismissed";

export function suggestDismissed(kv: KV | null = storage()): boolean {
  return get(kv, SUGGEST_DISMISSED_KEY) === "1";
}

export function dismissSuggest(kv: KV | null = storage()): void {
  set(kv, SUGGEST_DISMISSED_KEY, "1");
}

// ---------------------------------------------------------------- settings rows

export type RowKey = "max_resolution" | "max_bitrate_mbps" | "max_size_gb" | "video_codec" | "hdr" | "audio" | "default_player";
export type OptValue = string | number | null;

export interface RowSpec {
  key: RowKey;
  label: MessageKey;
  /** null first = «Авто». */
  options: readonly OptValue[];
  /** Only for TVs (default player). */
  tvOnly?: boolean;
}

export const ROWS: readonly RowSpec[] = [
  { key: "max_resolution", label: "tvplay.row.max_resolution", options: [null, "720p", "1080p", "2160p"] },
  { key: "max_bitrate_mbps", label: "tvplay.row.max_bitrate", options: [null, 8, 15, 25, 40, 0] },
  { key: "max_size_gb", label: "tvplay.row.max_size", options: [null, 2, 4, 8, 15, 30, 60] },
  { key: "video_codec", label: "tvplay.row.video_codec", options: [null, "h264", "hevc"] },
  { key: "hdr", label: "tvplay.row.hdr", options: [null, "allow", "avoid"] },
  { key: "audio", label: "tvplay.row.audio", options: [null, "prefer_aac_ac3", "avoid_dts_truehd", "always_compat"] },
  { key: "default_player", label: "tvplay.row.default_player", options: [null, "builtin", "msx", "external"], tvOnly: true },
];

/** Rows for a TV (with the default player) or a browser. */
export function rowsFor(kind: "tv" | "browser"): RowSpec[] {
  return ROWS.filter((r) => kind === "tv" || !r.tvOnly);
}

/** <select> value of an option. */
export function encodeOpt(v: OptValue | undefined): string {
  return v == null ? "auto" : String(v);
}

/** <select> value → option (numbers for the numeric rows; unknown → auto). */
export function decodeOpt(row: RowSpec, s: string): OptValue {
  return row.options.find((o) => encodeOpt(o) === s) ?? null;
}

/** The manual value shown in a row (a value outside the options list stays selectable). */
export function rowValue(m: PlaybackManual, key: RowKey): OptValue {
  const v = m[key];
  return v == null ? null : (v as OptValue);
}

/** Options for a row, including a current value not in the preset list (e.g. 12 Mbit/s set on the TV). */
export function rowOptions(row: RowSpec, m: PlaybackManual): OptValue[] {
  const cur = rowValue(m, row.key);
  return cur != null && !row.options.includes(cur) ? [...row.options, cur] : [...row.options];
}

/** Manual values with one row changed (null = back to auto). */
export function setRow(m: PlaybackManual, key: RowKey, v: OptValue): PlaybackManual {
  return { ...m, [key]: v };
}

/** No manual value set (all automatic). */
export function isAllAuto(m: PlaybackManual | null | undefined): boolean {
  return !m || Object.values(m).every((v) => v === null || v === undefined);
}

const RES_LABEL: Record<string, string> = { "720p": "720p", "1080p": "1080p", "2160p": "4K" };

/** What «Авто» means right now for a row, from the detected values (null = no limit / unknown). */
export function autoValue(auto: PlaybackAuto, key: RowKey, t: T): string | null {
  const e = effectivePrefs({ auto, manual: {} });
  switch (key) {
    case "max_resolution":
      return e.max_resolution ? RES_LABEL[e.max_resolution]! : null;
    case "max_bitrate_mbps":
      return e.max_bitrate_bps ? t("tvplay.mbps", { n: Math.round(e.max_bitrate_bps / 1e6) }) : null;
    case "hdr":
      return auto.video?.length ? t(e.avoid_hdr ? "tvplay.hdr.avoid" : "tvplay.hdr.allow") : null;
    default:
      return null;
  }
}

/** Label of one option. */
export function optionLabel(key: RowKey, v: OptValue, t: T, auto?: PlaybackAuto): string {
  if (v == null) {
    const a = auto ? autoValue(auto, key, t) : null;
    return a ? t("tvplay.auto_value", { value: a }) : t("tvplay.auto");
  }
  switch (key) {
    case "max_resolution":
      return RES_LABEL[String(v)] ?? String(v);
    case "max_bitrate_mbps":
      return v === 0 ? t("tvplay.unlimited") : t("tvplay.mbps", { n: v });
    case "max_size_gb":
      return v === 0 ? t("tvplay.unlimited") : t("tvplay.gb", { n: v });
    case "video_codec":
      return v === "hevc" ? "HEVC" : v === "h264" ? "H.264" : String(v);
    case "hdr":
      return t(`tvplay.hdr.${v}` as MessageKey);
    case "audio":
      return t(`tvplay.audio.${v}` as MessageKey);
    case "default_player":
      return t(`tvplay.player.${v}` as MessageKey);
  }
}

// ---------------------------------------------------------------- detected summary

const CODEC_LABEL: Record<string, string> = {
  h264: "H.264",
  hevc: "HEVC",
  vp9: "VP9",
  av1: "AV1",
  hdr10: "HDR10",
  dv: "Dolby Vision",
  aac: "AAC",
  ac3: "AC3",
  eac3: "E-AC3",
  dts: "DTS",
  truehd: "TrueHD",
  mp3: "MP3",
  opus: "Opus",
  flac: "FLAC",
};

/** «Экран 2532×1170 (1080p) · Видео H.264, HEVC · …» as label/value pairs; empty when nothing is known. */
export function detectedSummary(a: PlaybackAuto | null | undefined, t: T): { label: string; value: string }[] {
  if (!a) return [];
  const out: { label: string; value: string }[] = [];
  if (a.model) out.push({ label: t("tvplay.device.model"), value: a.model });
  if (a.screen_width && a.screen_height) {
    const r = resolutionForScreen(a.screen_width, a.screen_height);
    const s = landscapeSize(a.screen_width, a.screen_height); // saved before sizes were normalized
    out.push({ label: t("tvplay.device.screen"), value: `${s.width}×${s.height}${r ? ` (${RES_LABEL[r]})` : ""}` });
  }
  if (a.video?.length) out.push({ label: t("tvplay.device.video"), value: a.video.map((c) => CODEC_LABEL[c] ?? c.toUpperCase()).join(", ") });
  if (a.audio?.length || a.compat) {
    const list = (a.audio ?? []).map((c) => CODEC_LABEL[c] ?? c.toUpperCase()).join(", ");
    out.push({ label: t("tvplay.device.audio"), value: [list, a.compat ? t("tvplay.device.compat_yes") : ""].filter(Boolean).join(" · ") });
  }
  if (a.throughput_bps) out.push({ label: t("tvplay.device.throughput"), value: t("tvplay.mbps", { n: Math.round(a.throughput_bps / 1e5) / 10 }) });
  return out;
}

// ---------------------------------------------------------------- release list

/** The bitrate cap (bits/s) from the applied constraints, or null. */
export function capFromConstraints(cs: readonly { code: string; mbps?: number }[] | null | undefined): number | null {
  const c = cs?.find((x) => x.code === "max_bitrate");
  return c?.mbps && c.mbps > 0 ? c.mbps * 1e6 : null;
}

/** «тяжёлая: N Мбит/с» when the release's average bitrate exceeds the cap (Mbit/s, rounded), else null. */
export function heavyMbps(estBps: number | null | undefined, capBps: number | null): number | null {
  if (!estBps || !capBps || estBps <= capBps) return null;
  return Math.round(estBps / 1e6);
}
