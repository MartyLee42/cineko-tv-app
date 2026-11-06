// «Пойдёт ли на этом устройстве?»: compact chips per release / source for a
// target device (this TV, the TV a phone sends to). Pure and shared: the TV
// feeds its own probe-derived capabilities, the PWA the TV's reported
// PlaybackAuto. Only what the device reported is judged: an empty codec list
// means «unknown», never «unsupported».
//
// Extending: capabilities are plain key lists, so new detection (video
// profiles, 10-bit decoding…) plugs in as more keys — e.g. a device that
// reports "h264_10bit" / "hevc_10bit" in `video` gets 10-bit releases judged
// by those keys instead of the generic «may not play» for H.264 10-bit.
import { resolutionForScreen, type MaxResolution } from "./playbackPrefs";

/** What a device can decode (PlaybackAuto's lists; null / empty = unknown). */
export interface DeviceCaps {
  /** For «Пойдёт на Living Room» (null: «Пойдёт»). */
  name?: string | null;
  /** h264, hevc, vp9, av1, hdr10, dv (+ profile keys like h264_10bit, mpeg4, mpeg2 when known). */
  video?: readonly string[] | null;
  /** aac, ac3, eac3, dts, truehd, mp3, opus, flac. */
  audio?: readonly string[] | null;
  /** mkv, mp4, ts (+ avi when known). */
  containers?: readonly string[] | null;
  hls?: boolean | null;
  /**
   * The server's compat stream is usable on this device: undecodable audio
   * → AAC, unknown containers (AVI) → MP4, old video (XviD, MPEG-2; ≤ 1080p)
   * → H.264.
   */
  compat?: boolean | null;
  screen_width?: number | null;
  screen_height?: number | null;
}

/** PlaybackAuto (the contract's or playbackPrefs.ts's): only what fit needs. */
export interface AutoLike {
  video?: readonly string[] | null;
  audio?: readonly string[] | null;
  containers?: readonly string[] | null;
  hls?: boolean | null;
  compat?: boolean | null;
  screen_width?: number | null;
  screen_height?: number | null;
}

/** A device's reported PlaybackAuto as capabilities. */
export function capsFromAuto(auto: AutoLike | null | undefined, name?: string | null): DeviceCaps {
  const a = auto ?? {};
  return {
    name: name ?? null,
    video: a.video ?? null,
    audio: a.audio ?? null,
    containers: a.containers ?? null,
    hls: a.hls ?? null,
    compat: a.compat ?? null,
    screen_width: a.screen_width ?? null,
    screen_height: a.screen_height ?? null,
  };
}

/** What is known about a release / prepared source. */
export interface FitInput {
  video_codec?: string | null;
  /** Codecs named in the title (which one is the default track is unknown). */
  audio_codecs?: readonly string[] | null;
  /** The default audio track of a prepared source (media_info). Wins over audio_codecs. */
  main_audio?: string | null;
  resolution?: string | null;
  hdr?: string | null;
  /** media_info.container, a MIME type or a file name. */
  container?: string | null;
  /** The release title (container / 10-bit hints). */
  title?: string | null;
  /** 10 for 10-bit video, when known. */
  bit_depth?: number | null;
  /** "hls" for online variants. */
  format?: string | null;
  /** Server warnings (disc_image…). */
  warnings?: readonly string[] | null;
}

interface ReleaseLike {
  title?: string | null;
  video_codec?: string | null;
  audio_codecs?: readonly string[] | null;
  resolution?: string | null;
  hdr?: string | null;
  warnings?: readonly string[] | null;
  provider?: { kind?: string | null } | null;
}

interface SourceLike {
  mime_type?: string | null;
  media_info?: { container?: string | null; video_codec?: string | null; audio?: readonly { codec?: string | null; default?: boolean | null }[] | null } | null;
  file?: { path?: string | null } | null;
  format?: string | null;
}

/** A release (and, when prepared, its source's media_info) as fit input. */
export function fitInput(r: ReleaseLike, src?: SourceLike | null): FitInput {
  const info = src?.media_info ?? null;
  const main = info?.audio && info.audio.length > 0 ? (info.audio.find((a) => a.default) ?? info.audio[0]!) : null;
  const online = !!r.provider?.kind && r.provider.kind !== "torrent";
  return {
    video_codec: info?.video_codec ?? r.video_codec ?? null,
    audio_codecs: r.audio_codecs ?? [],
    main_audio: main?.codec ?? null,
    resolution: r.resolution ?? null,
    hdr: r.hdr ?? null,
    container: info?.container ?? src?.mime_type ?? src?.file?.path ?? null,
    title: r.title ?? null,
    format: src?.format ?? (online ? "hls" : null),
    warnings: r.warnings ?? [],
  };
}

export type FitTone = "ok" | "convert" | "warn" | "bad" | "info";

export type FitChip =
  /** «✓ Пойдёт на Living Room». */
  | { code: "plays"; tone: "ok"; name: string | null }
  /** «Звук DTS → сервер переведёт в AAC». */
  | { code: "audio_convert"; tone: "convert"; codec: string }
  /** «Видео XviD → сервер перекодирует в H.264». */
  | { code: "video_convert"; tone: "convert"; codec: string }
  /** «AVI → сервер перепакует в MP4». */
  | { code: "container_convert"; tone: "convert"; container: string }
  /** «✗ Звук DTS не поддерживается» (picture without sound). */
  | { code: "audio_bad"; tone: "bad"; codec: string }
  /** «✗ Видео HEVC не поддерживается». */
  | { code: "video_bad"; tone: "bad"; codec: string }
  /** «✗ MKV не поддерживается». */
  | { code: "container_bad"; tone: "bad"; container: string }
  /** «✗ Образ диска». */
  | { code: "disc"; tone: "bad" }
  /** «✗ HLS не поддерживается» (online variants). */
  | { code: "hls_bad"; tone: "bad" }
  /** «Может не заиграть: AVI/XviD». */
  | { code: "maybe"; tone: "warn"; what: string[] }
  /** «4K: экран 1080p». */
  | { code: "screen"; tone: "info"; res: string; screen: string }
  /** «HDR: экран без HDR». */
  | { code: "no_hdr"; tone: "info" }
  /** «MKV ✓». */
  | { code: "container_ok"; tone: "ok"; container: string };

export type FitVerdict = "ok" | "convert" | "maybe" | "bad" | "unknown";

export interface Fit {
  verdict: FitVerdict;
  /** Most important first, at most `max`. */
  chips: FitChip[];
}

const VIDEO_LABEL: Record<string, string> = { h264: "H.264", hevc: "HEVC", vp9: "VP9", av1: "AV1", mpeg2: "MPEG-2", mpeg4: "XviD", vp8: "VP8" };
const AUDIO_LABEL: Record<string, string> = { aac: "AAC", ac3: "AC3", eac3: "E-AC3", dts: "DTS", truehd: "TrueHD", mp3: "MP3", opus: "Opus", flac: "FLAC" };
const CONTAINER_LABEL: Record<string, string> = { mkv: "MKV", mp4: "MP4", ts: "TS", avi: "AVI", webm: "WebM" };
/** Codecs a device reports (PlaybackAuto enums): judged as yes / no. */
const REPORTED_VIDEO = ["h264", "hevc", "vp9", "av1"];
const REPORTED_AUDIO = ["aac", "ac3", "eac3", "dts", "truehd", "mp3", "opus", "flac"];
const REPORTED_CONTAINERS = ["mkv", "mp4", "ts"];
/**
 * Rarely hardware-decoded on TVs, not in the report: «может не заиграть»
 * unless listed — or, with compat, re-encoded to H.264 by the server
 * (services/api VideoTranscodable: ≤ 1080p).
 */
const DOUBTFUL_VIDEO = ["mpeg2", "mpeg4"];

/** Normalized codec key (ffprobe names and the release parser's). */
export function fitCodecKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name.toLowerCase().replace(/[\s_.-]/g, "");
  if (["h264", "avc", "avc1", "x264"].includes(n)) return "h264";
  if (["hevc", "h265", "x265", "hvc1", "hev1"].includes(n)) return "hevc";
  if (n === "vp9" || n === "vp09") return "vp9";
  if (n === "av1" || n === "av01") return "av1";
  if (n === "mpeg2" || n === "mpeg2video") return "mpeg2";
  if (["mpeg4", "xvid", "divx", "mp4v", "msmpeg4", "msmpeg4v2", "msmpeg4v3"].includes(n)) return "mpeg4";
  if (n === "aac" || n === "mp4a") return "aac";
  if (n === "ac3" || n === "dd") return "ac3";
  if (["eac3", "ddp", "ec3", "dd+"].includes(n)) return "eac3";
  if (n.startsWith("dts")) return "dts";
  if (n === "truehd" || n === "mlp" || n === "atmos") return "truehd";
  return n;
}

/** Container key from media_info.container, a MIME type, a file name or a title. */
export function fitContainerKey(s: string | null | undefined): string | null {
  const v = (s ?? "").toLowerCase();
  if (!v) return null;
  if (/matroska|\bmkv\b/.test(v)) return "mkv";
  if (/webm/.test(v)) return "webm";
  if (/\bavi\b|x-msvideo/.test(v)) return "avi";
  if (/mpegts|mp2t|\.m2ts\b|\.ts\b|^ts$/.test(v)) return "ts";
  if (/\bmp4\b|\bm4v\b|quicktime|\bmov\b|isom/.test(v)) return "mp4";
  return null;
}

function tenBit(i: FitInput): boolean {
  if (i.bit_depth != null) return i.bit_depth >= 10;
  return /\b(10[\s-]?bit|hi10p?|main\s?10)\b/i.test(i.title ?? "");
}

const has = (list: readonly string[] | null | undefined, k: string) => !!list && list.includes(k);
const known = (list: readonly string[] | null | undefined) => !!list && list.length > 0;

const RES_LABEL: Record<string, string> = { "2160p": "4K" };
const RES_RANK: Record<string, number> = { "480p": 1, "576p": 2, "720p": 3, "1080p": 4, "2160p": 5 };

/**
 * Judges one release / source for a device: what fails (bad), what may not
 * play (warn), what the server converts, plus informational notes (a 4K
 * release on a 1080p screen). Returns the verdict and up to `max` chips.
 */
export function judgeFit(i: FitInput, caps: DeviceCaps, max = 3): Fit {
  const bad: FitChip[] = [];
  const maybe: string[] = [];
  const convert: FitChip[] = [];
  const info: FitChip[] = [];
  let judged = false;
  let containerOk: FitChip | null = null;
  // Not a REPORTED container the device lacks (e.g. AVI): compat repackages it.
  let containerConvert: FitChip | null = null;

  if (i.format === "hls") {
    if (caps.hls === false) bad.push({ code: "hls_bad", tone: "bad" });
    else if (caps.hls === true) judged = true;
  } else {
    if (i.warnings?.includes("disc_image")) bad.push({ code: "disc", tone: "bad" });
    // Container: from the source when prepared, else a hint in the title.
    const ck = fitContainerKey(i.container) ?? fitContainerKey(/\.(mkv|avi|mp4|m4v|ts|m2ts)\b/i.exec(i.title ?? "")?.[1] ?? null);
    if (ck && known(caps.containers)) {
      if (has(caps.containers, ck)) containerOk = { code: "container_ok", tone: "ok", container: CONTAINER_LABEL[ck]! };
      else if (REPORTED_CONTAINERS.includes(ck)) bad.push({ code: "container_bad", tone: "bad", container: CONTAINER_LABEL[ck]! });
      else if (caps.compat) containerConvert = { code: "container_convert", tone: "convert", container: CONTAINER_LABEL[ck] ?? ck.toUpperCase() };
      else maybe.push(CONTAINER_LABEL[ck] ?? ck.toUpperCase());
      judged = true;
    }

    const v = fitCodecKey(i.video_codec);
    if (v && known(caps.video)) {
      const label = VIDEO_LABEL[v] ?? v.toUpperCase();
      if (REPORTED_VIDEO.includes(v)) {
        judged = true;
        if (!has(caps.video, v)) bad.push({ code: "video_bad", tone: "bad", codec: label });
        else if (tenBit(i)) {
          // Profile keys reported (h264_10bit…): judge by them; else only H.264 10-bit is doubtful.
          const reportsDepth = caps.video!.some((k) => k.endsWith("_10bit"));
          if (reportsDepth ? !has(caps.video, `${v}_10bit`) : v === "h264") {
            if (reportsDepth) bad.push({ code: "video_bad", tone: "bad", codec: `${label} 10-bit` });
            else maybe.push(`${label} 10-bit`);
          }
        }
      } else if (DOUBTFUL_VIDEO.includes(v)) {
        judged = true;
        if (!has(caps.video, v)) {
          if (caps.compat && (RES_RANK[i.resolution ?? ""] ?? 0) <= RES_RANK["1080p"]!) convert.push({ code: "video_convert", tone: "convert", codec: label });
          else maybe.push(label);
        }
      }
    }

    // Audio: the prepared source's default track, else the title's codecs
    // (only «every listed codec is undecodable» counts — the default is unknown).
    if (known(caps.audio)) {
      const main = fitCodecKey(i.main_audio);
      const listed = (i.audio_codecs ?? []).map(fitCodecKey).filter((k): k is string => !!k && REPORTED_AUDIO.includes(k));
      const keys = main ? (REPORTED_AUDIO.includes(main) ? [main] : []) : listed;
      if (keys.length > 0) {
        judged = true;
        if (keys.every((k) => !has(caps.audio, k))) {
          const codec = AUDIO_LABEL[keys[0]!] ?? keys[0]!.toUpperCase();
          if (caps.compat) convert.push({ code: "audio_convert", tone: "convert", codec });
          else bad.push({ code: "audio_bad", tone: "bad", codec });
        }
      }
    }

    // Converted video comes as MP4 anyway: the container chip only alone.
    if (containerConvert && !convert.some((c) => c.code === "video_convert")) convert.push(containerConvert);

    if (i.hdr && known(caps.video) && !has(caps.video, "hdr10") && !has(caps.video, "dv")) info.push({ code: "no_hdr", tone: "info" });
  }

  // A release above the screen: informational («4K: экран 1080p»).
  const screen: MaxResolution | null = resolutionForScreen(caps.screen_width, caps.screen_height);
  if (screen && i.resolution && (RES_RANK[i.resolution] ?? 0) > (RES_RANK[screen] ?? 9)) {
    info.unshift({ code: "screen", tone: "info", res: RES_LABEL[i.resolution] ?? i.resolution, screen: RES_LABEL[screen] ?? screen });
  }

  const maybeChip: FitChip[] = maybe.length > 0 ? [{ code: "maybe", tone: "warn", what: maybe }] : [];
  let verdict: FitVerdict;
  let chips: FitChip[];
  if (bad.length > 0) {
    verdict = "bad";
    chips = [...bad, ...maybeChip, ...info];
  } else if (maybe.length > 0) {
    verdict = "maybe";
    chips = [...maybeChip, ...convert, ...info];
  } else if (!judged) {
    verdict = "unknown";
    chips = info;
  } else {
    verdict = convert.length > 0 ? "convert" : "ok";
    chips = [{ code: "plays", tone: "ok", name: caps.name ?? null }, ...convert, ...info, ...(containerOk ? [containerOk] : [])];
  }
  return { verdict, chips: chips.slice(0, max) };
}

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The chip's text (words from i18n: tvplay.fit.*). */
export function fitChipText(c: FitChip, t: T): string {
  switch (c.code) {
    case "plays":
      return c.name ? t("tvplay.fit.plays_on", { name: c.name }) : t("tvplay.fit.plays");
    case "audio_convert":
      return t("tvplay.fit.audio_convert", { codec: c.codec });
    case "video_convert":
      return t("tvplay.fit.video_convert", { codec: c.codec });
    case "container_convert":
      return t("tvplay.fit.container_convert", { container: c.container });
    case "audio_bad":
      return t("tvplay.fit.audio_bad", { codec: c.codec });
    case "video_bad":
      return t("tvplay.fit.video_bad", { codec: c.codec });
    case "container_bad":
      return t("tvplay.fit.container_bad", { container: c.container });
    case "disc":
      return t("tvplay.fit.disc");
    case "hls_bad":
      return t("tvplay.fit.hls_bad");
    case "maybe":
      return t("tvplay.fit.maybe", { list: c.what.join("/") });
    case "screen":
      return t("tvplay.fit.screen", { res: c.res, screen: c.screen });
    case "no_hdr":
      return t("tvplay.fit.no_hdr");
    case "container_ok":
      return t("tvplay.fit.container_ok", { container: c.container });
  }
}

/** A few characters for tight rows: «✓», «DTS→AAC», «✗ HEVC», «? AVI/XviD», «4K→1080p». */
export function fitChipShort(c: FitChip): string {
  switch (c.code) {
    case "plays":
      return "✓";
    case "audio_convert":
      return `${c.codec}→AAC`;
    case "video_convert":
      return `${c.codec}→H.264`;
    case "container_convert":
      return `${c.container}→MP4`;
    case "audio_bad":
    case "video_bad":
      return `✗ ${c.codec}`;
    case "container_bad":
      return `✗ ${c.container}`;
    case "disc":
      return "✗ ISO";
    case "hls_bad":
      return "✗ HLS";
    case "maybe":
      return `? ${c.what.join("/")}`;
    case "screen":
      return `${c.res}→${c.screen}`;
    case "no_hdr":
      return "SDR";
    case "container_ok":
      return `${c.container} ✓`;
  }
}

/** The one chip that sums a fit up (the failure, the conversion — video first —, else «✓»). */
export function fitHeadline(fit: Fit): FitChip | null {
  if (fit.verdict === "convert") return fit.chips.find((c) => c.tone === "convert") ?? fit.chips[0] ?? null;
  return fit.chips[0] ?? null;
}

/**
 * Server warnings a device fit already explains (don't show both):
 * codec / audio judgements, and the resolution note when a screen chip is shown.
 */
export function fitCoveredWarnings(fit: Fit | null | undefined): string[] {
  if (!fit || fit.verdict === "unknown") return [];
  const out = ["codec_unsupported", "audio_needs_conversion", "audio_unsupported"];
  if (fit.chips.some((c) => c.code === "disc")) out.push("disc_image");
  if (fit.chips.some((c) => c.code === "no_hdr")) out.push("hdr_avoided");
  return out;
}
