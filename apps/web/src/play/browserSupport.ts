// Can this browser play a stream? A decision table over container, video and
// audio codecs, probed with HTMLMediaElement.canPlayType and
// MediaSource.isTypeSupported, plus the known quirks that probes don't show
// (Chrome plays MKV although canPlayType says no, Safari never opens MKV, no
// browser decodes DTS/TrueHD…). Pure: the probe and the browser are injected,
// so the table is unit-tested.
import type { MediaInfo, PlaybackSource, Release } from "@martytv/contracts";
import type { MessageKey } from "@martytv/ui";
import { hlsMode, isHlsSource } from "@martytv/media-types";
import { compatFixes, compatServerHint, readCompatPref } from "../player/compat";

export type Verdict = "playable" | "maybe" | "unlikely";

export interface Probe {
  canPlayType(type: string): string;
  isTypeSupported?(type: string): boolean;
}

export type Engine = "safari" | "chromium" | "firefox" | "other";

export interface BrowserEnv {
  engine: Engine;
  /** Apple OS (macOS, iOS, iPadOS): Safari decodes AC3/E-AC3/HEVC there. */
  apple: boolean;
  windows: boolean;
  android: boolean;
  /** iPhone / iPad: every browser is WebKit; fullscreen only on the <video>. */
  ios: boolean;
}

/** Browser family from the user agent (only what the decision table needs). */
export function detectBrowser(ua: string, maxTouchPoints = 0, touchEvents = false): BrowserEnv {
  // iPadOS reports a Mac UA; a touch screen (or touch events, which Mac
  // Safari lacks) gives it away.
  const ios = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && (maxTouchPoints > 0 || touchEvents));
  const apple = ios || /macintosh|mac os x/i.test(ua);
  const windows = /windows/i.test(ua);
  const android = /android/i.test(ua);
  let engine: Engine = "other";
  // Every iOS browser is WebKit, whatever it calls itself.
  if (ios) engine = "safari";
  else if (/firefox|fxios/i.test(ua)) engine = "firefox";
  else if (/chrome|chromium|crios|edg\//i.test(ua)) engine = "chromium";
  else if (/safari/i.test(ua) && apple) engine = "safari";
  // In-app web views (WKWebView: Media Station X…) drop the "Safari" token.
  else if (/applewebkit/i.test(ua) && apple) engine = "safari";
  return { engine, apple, windows, android, ios };
}

// ---------------------------------------------------------------- codecs

/** Normalized key for a codec name from ffprobe or the release parser. */
export function codecKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name.toLowerCase().replace(/[\s_.-]/g, "");
  if (["h264", "avc", "avc1", "x264"].includes(n)) return "h264";
  if (["hevc", "h265", "x265", "hvc1", "hev1"].includes(n)) return "hevc";
  if (n === "vp9" || n === "vp09") return "vp9";
  if (n === "vp8") return "vp8";
  if (n === "av1" || n === "av01") return "av1";
  if (n === "mpeg2" || n === "mpeg2video") return "mpeg2";
  if (["mpeg4", "xvid", "divx", "mp4v"].includes(n)) return "mpeg4";
  if (n === "aac" || n === "mp4a") return "aac";
  if (n === "ac3" || n === "dd") return "ac3";
  if (["eac3", "ddp", "ec3", "dd+"].includes(n)) return "eac3";
  if (n.startsWith("dts")) return "dts";
  if (n === "truehd" || n === "mlp" || n === "atmos") return "truehd";
  if (n === "flac") return "flac";
  if (n === "mp3" || n === "mp2") return n;
  if (n === "opus") return "opus";
  if (n === "vorbis") return "vorbis";
  if (n.startsWith("pcm")) return "pcm";
  return n;
}

interface CodecSpec {
  label: string;
  /** Full MIME types with RFC 6381 codec strings; supported if any answers yes. */
  types: string[];
}

const VIDEO: Record<string, CodecSpec> = {
  h264: {
    label: "H.264",
    types: ['video/mp4; codecs="avc1.640028"', 'video/mp4; codecs="avc1.4d401f"', 'video/mp4; codecs="avc1.42E01E"'],
  },
  hevc: {
    label: "HEVC",
    types: ['video/mp4; codecs="hvc1.1.6.L120.90"', 'video/mp4; codecs="hev1.1.6.L120.90"', 'video/mp4; codecs="hvc1.2.4.L153.B0"'],
  },
  av1: { label: "AV1", types: ['video/mp4; codecs="av01.0.08M.08"', 'video/webm; codecs="av01.0.08M.08"'] },
  vp9: { label: "VP9", types: ['video/webm; codecs="vp9"', 'video/mp4; codecs="vp09.00.40.08"'] },
  vp8: { label: "VP8", types: ['video/webm; codecs="vp8"'] },
  mpeg4: { label: "MPEG-4 (XviD)", types: ['video/mp4; codecs="mp4v.20.9"'] },
  mpeg2: { label: "MPEG-2", types: ['video/mp4; codecs="mp4v.61"', "video/mpeg"] },
};

const AUDIO: Record<string, CodecSpec> = {
  aac: { label: "AAC", types: ['audio/mp4; codecs="mp4a.40.2"'] },
  mp3: { label: "MP3", types: ["audio/mpeg", 'audio/mp4; codecs="mp4a.69"', 'audio/mp4; codecs="mp4a.6B"'] },
  mp2: { label: "MP2", types: ['audio/mp4; codecs="mp4a.69"'] },
  opus: { label: "Opus", types: ['audio/webm; codecs="opus"', 'audio/mp4; codecs="opus"'] },
  vorbis: { label: "Vorbis", types: ['audio/webm; codecs="vorbis"'] },
  flac: { label: "FLAC", types: ['audio/mp4; codecs="flac"', "audio/flac"] },
  ac3: { label: "AC3", types: ['audio/mp4; codecs="ac-3"'] },
  eac3: { label: "E-AC3", types: ['audio/mp4; codecs="ec-3"'] },
  dts: { label: "DTS", types: ['audio/mp4; codecs="dtsc"', 'audio/mp4; codecs="dtsh"'] },
  truehd: { label: "TrueHD", types: ['audio/mp4; codecs="mlpa"'] },
  pcm: { label: "PCM", types: ['audio/wav; codecs="1"'] },
};

export type ContainerKey = "mp4" | "matroska" | "webm" | "mpegts" | "avi";

const CONTAINER_LABEL: Record<ContainerKey, string> = { mp4: "MP4", matroska: "MKV", webm: "WebM", mpegts: "MPEG-TS", avi: "AVI" };

/** Container from ffprobe's format name and/or the stream's MIME type. */
export function containerKey(container: string | null | undefined, mime: string | null | undefined): ContainerKey | null {
  const c = (container ?? "").toLowerCase();
  const m = (mime ?? "").toLowerCase().split(";")[0]!.trim();
  // ffprobe names WebM and MKV alike ("matroska,webm"): the MIME type decides.
  if (/matroska|mkv/.test(c) || m === "video/x-matroska") return m === "video/webm" ? "webm" : "matroska";
  if (/webm/.test(c) || m === "video/webm") return "webm";
  if (/mp4|mov|m4v|isom|3gp/.test(c) || m === "video/mp4" || m === "video/quicktime") return "mp4";
  if (/mpegts|^ts$|mp2t/.test(c) || m === "video/mp2t") return "mpegts";
  if (/avi/.test(c) || m === "video/x-msvideo" || m === "video/avi") return "avi";
  return null;
}

/** Container guessed from a release title ("…BDRip 1080p.mkv", "[AVI]", XviD). */
export function containerFromTitle(title: string): ContainerKey | null {
  const s = title.toLowerCase();
  if (/\.?\bmkv\b/.test(s)) return "matroska";
  if (/\.?\bmp4\b|\bm4v\b/.test(s)) return "mp4";
  if (/\.?\bwebm\b/.test(s)) return "webm";
  if (/\.?\bavi\b|\bxvid\b|\bdivx\b/.test(s)) return "avi";
  if (/\bm2ts\b|\.ts\b/.test(s)) return "mpegts";
  return null;
}

function yes(probe: Probe, types: string[]): boolean {
  for (const t of types) {
    try {
      if (probe.canPlayType(t) !== "") return true;
      if (probe.isTypeSupported?.(t)) return true;
    } catch {
      // some engines throw on unknown types
    }
  }
  return false;
}

// ---------------------------------------------------------------- decision

export type ReasonCode =
  | "container" // the browser can't open this container
  | "container_maybe" // may not open (Firefox + MKV, unknown container on Safari…)
  | "video" // video codec not decodable → nothing to see
  | "video_unknown" // codec unknown before preparing
  | "no_audio" // main audio track not decodable → plays silently
  | "some_audio" // other audio tracks won't play (info)
  | "hdr" // Dolby Vision without fallback may show wrong colours (info)
  | "disc_image"
  | "mime"
  | "hls"; // an HLS stream (online source) and neither native HLS nor MSE for hls.js

export interface Reason {
  code: ReasonCode;
  /** What it does to the verdict ("info" doesn't lower it). */
  severity: "info" | "maybe" | "unlikely";
  /** Codec / container label, e.g. "DTS", "MKV". */
  label: string;
}

export interface BrowserSupport {
  verdict: Verdict;
  reasons: Reason[];
  /** Video will likely play but without sound. */
  noAudio: boolean;
  /** Codec keys to avoid when picking another release (e.g. ["dts"]). */
  avoid: string[];
  /** Plays thanks to the compat stream (audio converted / remuxed to MP4). */
  compat?: boolean;
}

/**
 * With a compat stream available: problems it fixes (audio codec, container)
 * no longer count — the release plays, with its audio converted.
 */
export function withCompat(s: BrowserSupport, available: boolean): BrowserSupport {
  if (!available || !compatFixes(s)) return s;
  return { ...s, verdict: "playable", noAudio: false, compat: true, avoid: [] };
}

/** Compat counts for this browser: the server has it and the user didn't switch it off. */
export function compatUsable(compatUrl?: string | null): boolean {
  const pref = readCompatPref();
  if (pref === "off") return false;
  return compatUrl !== undefined ? !!compatUrl : compatServerHint();
}

export interface AssessInput {
  /** Online sources: mp4 | hls (torrents: null). */
  format?: string | null;
  mime_type?: string | null;
  media_info?: MediaInfo | null;
  release?: Pick<Release, "video_codec" | "audio_codecs"> & Partial<Pick<Release, "title" | "warnings" | "hdr">> | null;
}

function checkContainer(key: ContainerKey, probe: Probe, env: BrowserEnv): Reason | null {
  const label = CONTAINER_LABEL[key];
  switch (key) {
    case "mp4":
      return null;
    case "webm":
      return yes(probe, ["video/webm"]) ? null : { code: "container", severity: "unlikely", label };
    case "avi":
      return { code: "container", severity: "unlikely", label };
    case "mpegts":
      // Raw TS only plays inside HLS; no browser opens a .ts URL directly.
      return yes(probe, ["video/mp2t"]) ? null : { code: "container", severity: "unlikely", label };
    case "matroska":
      if (yes(probe, ['video/x-matroska', 'video/matroska', "video/mkv"])) return null;
      // Safari / WebKit never opened Matroska.
      if (env.engine === "safari") return { code: "container", severity: "unlikely", label };
      // Chromium demuxes MKV (as WebM) even though canPlayType says "".
      if (env.engine === "chromium") return null;
      // Firefox: only recent versions; others: unknown.
      return { code: "container_maybe", severity: "maybe", label };
  }
}

function checkVideo(name: string | null | undefined, probe: Probe): Reason | null {
  const key = codecKey(name);
  if (!key) return null;
  const spec = VIDEO[key];
  if (spec && yes(probe, spec.types)) return null;
  return { code: "video", severity: "unlikely", label: spec?.label ?? key.toUpperCase() };
}

/**
 * Dolby / DTS: a "yes" from the probe means the platform's MP4 / MSE path
 * (Edge and Chrome on Windows / macOS). A Matroska file opened directly goes
 * through Chromium's or Firefox's own demuxer and decoders, which lack
 * them: such files played silent although the probe said yes.
 */
const PLATFORM_AUDIO = new Set(["ac3", "eac3", "dts", "truehd"]);

function audioOk(key: string, probe: Probe, env?: BrowserEnv, container?: ContainerKey | null): boolean | null {
  const spec = AUDIO[key];
  if (!spec) return null;
  if (PLATFORM_AUDIO.has(key) && container === "matroska" && env && env.engine !== "safari") return false;
  return yes(probe, spec.types);
}

function audioLabel(key: string): string {
  return AUDIO[key]?.label ?? key.toUpperCase();
}

/**
 * Judges a stream for this browser. With `media_info` (ffprobe) the container,
 * the video codec and the default audio track are known; without it, the MIME
 * type and the release's parsed codecs / title hints are used.
 */
export function assessForBrowser(src: AssessInput, probe: Probe, env: BrowserEnv): BrowserSupport {
  const info = src.media_info ?? null;
  const rel = src.release ?? null;
  const reasons: Reason[] = [];
  const avoid: string[] = [];

  // Online HLS: the browser's own HLS (Safari/iOS) or hls.js over MSE. The
  // provider's streams are H.264/AAC, which every such browser decodes.
  if (src.format === "hls" || (!src.format && isHlsSource({ mime_type: src.mime_type }))) {
    if (hlsMode(probe, !!probe.isTypeSupported) === "none") reasons.push({ code: "hls", severity: "unlikely", label: "HLS" });
    return { verdict: reasons.length ? "unlikely" : "playable", reasons, noAudio: false, avoid };
  }

  if (rel?.warnings?.includes("disc_image")) reasons.push({ code: "disc_image", severity: "unlikely", label: "ISO" });

  // Container.
  const fromSource = containerKey(info?.container, src.mime_type);
  const ck = fromSource ?? (rel?.title ? containerFromTitle(rel.title) : null);
  if (ck) {
    const r = checkContainer(ck, probe, env);
    if (r) reasons.push(r);
  } else if (src.mime_type && src.mime_type !== "application/octet-stream") {
    const mime = src.mime_type.split(";")[0]!.trim();
    if (!yes(probe, [mime])) reasons.push({ code: "mime", severity: "unlikely", label: mime });
  } else if (!info && !src.mime_type && env.engine === "safari") {
    // Most torrent video is MKV, which Safari can't open.
    reasons.push({ code: "container_maybe", severity: "maybe", label: "MKV" });
  }

  // Video.
  const vName = info?.video_codec ?? rel?.video_codec ?? null;
  const v = checkVideo(vName, probe);
  if (v) {
    reasons.push(v);
    avoid.push(codecKey(vName)!);
  } else if (!vName && !info && rel) {
    reasons.push({ code: "video_unknown", severity: "maybe", label: "" });
  }

  // Audio.
  let noAudio = false;
  if (info && info.audio.length > 0) {
    const main = info.audio.find((a) => a.default) ?? info.audio[0]!;
    const mk = codecKey(main.codec);
    if (mk && audioOk(mk, probe, env, ck) === false) {
      noAudio = true;
      avoid.push(mk);
      reasons.push({ code: "no_audio", severity: "maybe", label: audioLabel(mk) });
    } else {
      const others = [...new Set(info.audio.map((a) => codecKey(a.codec)).filter((k): k is string => !!k && audioOk(k, probe, env, ck) === false))];
      if (others.length) reasons.push({ code: "some_audio", severity: "info", label: others.map(audioLabel).join(", ") });
    }
  } else if (!info && rel && rel.audio_codecs.length > 0) {
    // Parsed from the title: which track is the default is unknown. All bad →
    // silent; some bad → the main (usually first-listed) track may be one of them.
    const keys = [...new Set(rel.audio_codecs.map(codecKey).filter((k): k is string => !!k))];
    const bad = keys.filter((k) => audioOk(k, probe, env, ck) === false);
    if (bad.length && bad.length === keys.length) {
      noAudio = true;
      avoid.push(...bad);
      reasons.push({ code: "no_audio", severity: "maybe", label: bad.map(audioLabel).join(", ") });
    } else if (bad.length) {
      const firstBad = bad.includes(keys[0]!);
      reasons.push({ code: firstBad ? "no_audio" : "some_audio", severity: firstBad ? "maybe" : "info", label: bad.map(audioLabel).join(", ") });
      if (firstBad) noAudio = true;
    }
  }

  // Dolby Vision without an HDR10 base layer shows green/purple outside Apple / Edge.
  if (rel?.hdr === "dolby_vision" && !(env.engine === "safari" && env.apple) && !(env.windows && env.engine === "chromium")) {
    reasons.push({ code: "hdr", severity: "info", label: "Dolby Vision" });
  }

  const verdict: Verdict = reasons.some((r) => r.severity === "unlikely")
    ? "unlikely"
    : reasons.some((r) => r.severity === "maybe")
      ? "maybe"
      : "playable";
  return { verdict, reasons, noAudio: noAudio && verdict !== "unlikely", avoid: [...new Set(avoid)] };
}

/** A release before preparing: parsed codecs, title hints and warnings only. */
export function assessRelease(
  r: Pick<Release, "video_codec" | "audio_codecs" | "title" | "warnings" | "hdr">,
  probe: Probe,
  env: BrowserEnv,
): BrowserSupport {
  return assessForBrowser({ release: r }, probe, env);
}

/** A prepared source: ffprobe info when available, else MIME + release. */
export function assessSource(
  s: Pick<PlaybackSource, "mime_type" | "media_info"> & { release?: AssessInput["release"]; format?: string | null },
  probe: Probe,
  env: BrowserEnv,
): BrowserSupport {
  return assessForBrowser({ format: s.format, mime_type: s.mime_type, media_info: s.media_info, release: s.release }, probe, env);
}

/** An online variant before preparing (its format is all that matters here). */
export function assessOnlineHere(format: string): BrowserSupport {
  const { probe, env } = thisBrowser();
  return assessForBrowser({ format }, probe, env);
}

// ---------------------------------------------------------------- capabilities

export interface Decodable {
  /** h264, hevc, vp9, av1, hdr10, dv (contract tokens). */
  video: ("h264" | "hevc" | "vp9" | "av1" | "hdr10" | "dv")[];
  audio: ("aac" | "ac3" | "eac3" | "dts" | "truehd" | "mp3" | "opus" | "flac")[];
  containers: ("mkv" | "mp4" | "ts")[];
  hls: boolean;
}

/**
 * What this browser decodes, in the playback-profile tokens (PlaybackAuto),
 * from the same probe tables the release verdicts use. `hdrScreen`: the
 * display reports `(dynamic-range: high)`.
 */
export function decodableCodecs(probe: Probe, env: BrowserEnv, hdrScreen = false): Decodable {
  const video = (["h264", "hevc", "vp9", "av1"] as const).filter((k) => yes(probe, VIDEO[k]!.types));
  const out: Decodable["video"] = [...video];
  if (hdrScreen && (video.includes("hevc") || video.includes("av1") || video.includes("vp9"))) out.push("hdr10");
  if (hdrScreen && yes(probe, ['video/mp4; codecs="dvh1.05.06"', 'video/mp4; codecs="dvhe.05.06"'])) out.push("dv");
  const audio = (["aac", "ac3", "eac3", "dts", "truehd", "mp3", "opus", "flac"] as const).filter((k) => yes(probe, AUDIO[k]!.types));
  const containers: Decodable["containers"] = ["mp4"];
  if (!checkContainer("matroska", probe, env)) containers.unshift("mkv");
  if (!checkContainer("mpegts", probe, env)) containers.push("ts");
  return { video: out, audio: [...audio], containers, hls: hlsMode(probe, !!probe.isTypeSupported) !== "none" };
}

// ---------------------------------------------------------------- ranking

const ORDER: Record<Verdict, number> = { playable: 0, maybe: 1, unlikely: 2 };

/** Releases with their verdicts, playable first; the server's order is kept within a verdict. */
export function rankForBrowser<R>(items: readonly R[], assess: (r: R) => BrowserSupport): { release: R; support: BrowserSupport }[] {
  return items
    .map((release, i) => ({ release, support: assess(release), i }))
    .sort((a, b) => ORDER[a.support.verdict] - ORDER[b.support.verdict] || a.i - b.i)
    .map(({ release, support }) => ({ release, support }));
}

/**
 * "Watch here (best)": the top-ranked release that is playable, else one that
 * may play. Releases already tried and ones using a failing codec are skipped.
 * Null when nothing is expected to play in this browser.
 */
export function bestForBrowser<R extends { id: string; video_codec: string | null; audio_codecs: string[] }>(
  items: readonly R[],
  assess: (r: R) => BrowserSupport,
  opts: { tried?: readonly string[]; avoid?: readonly string[] } = {},
): R | null {
  const tried = opts.tried ?? [];
  const avoid = opts.avoid ?? [];
  const uses = (r: R) => [codecKey(r.video_codec), ...r.audio_codecs.map(codecKey)].some((k) => k && avoid.includes(k));
  const ranked = rankForBrowser(
    items.filter((r) => !tried.includes(r.id) && !uses(r)),
    assess,
  );
  return ranked.find((x) => x.support.verdict === "playable")?.release ?? ranked.find((x) => x.support.verdict === "maybe")?.release ?? null;
}

// ---------------------------------------------------------------- text

const REASON_KEY: Record<ReasonCode, MessageKey> = {
  container: "player.web.reason.container",
  container_maybe: "player.web.reason.container_maybe",
  video: "player.web.reason.video",
  video_unknown: "player.web.reason.video_unknown",
  no_audio: "player.web.reason.no_audio",
  some_audio: "player.web.reason.some_audio",
  hdr: "player.web.reason.hdr",
  disc_image: "player.web.reason.disc_image",
  mime: "player.web.reason.mime",
  hls: "sources.reason.hls",
};

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Human reasons, most severe first. */
export function reasonTexts(s: BrowserSupport, t: T): string[] {
  const rank = { unlikely: 0, maybe: 1, info: 2 } as const;
  return [...s.reasons].sort((a, b) => rank[a.severity] - rank[b.severity]).map((r) => t(REASON_KEY[r.code], { codec: r.label }));
}

/** Badge text for a verdict. */
export function verdictLabel(s: BrowserSupport, t: T): string {
  if (s.compat) return t("player.web.badge.converted");
  if (s.verdict === "playable") return t("player.web.badge.playable");
  if (s.verdict === "unlikely") return t("player.web.badge.unlikely");
  return s.noAudio ? t("player.web.badge.no_sound") : t("player.web.badge.maybe");
}

// ---------------------------------------------------------------- runtime

/** The engine's probe (a throwaway <video> + MediaSource). */
export function browserProbe(): Probe {
  const v = typeof document !== "undefined" ? document.createElement("video") : null;
  const MS = typeof window !== "undefined" ? (window as unknown as { MediaSource?: { isTypeSupported?(t: string): boolean } }).MediaSource : undefined;
  return {
    canPlayType: (t) => (v ? v.canPlayType(t) : ""),
    isTypeSupported: MS?.isTypeSupported ? (t) => !!MS.isTypeSupported!(t) : undefined,
  };
}

let cached: { probe: Probe; env: BrowserEnv } | null = null;

/** Probe + browser for this page (computed once). */
export function thisBrowser(): { probe: Probe; env: BrowserEnv } {
  if (!cached) {
    const nav = typeof navigator !== "undefined" ? navigator : null;
    cached = { probe: browserProbe(), env: detectBrowser(nav?.userAgent ?? "", nav?.maxTouchPoints ?? 0, typeof document !== "undefined" && "ontouchend" in document) };
  }
  return cached;
}

/** Release verdict in this browser. */
export function assessHere(r: Pick<Release, "video_codec" | "audio_codecs" | "title" | "warnings" | "hdr">): BrowserSupport {
  const { probe, env } = thisBrowser();
  return withCompat(assessRelease(r, probe, env), compatUsable());
}
