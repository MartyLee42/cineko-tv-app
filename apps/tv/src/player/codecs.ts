// Will this TV's engine play a file? A decision table over container, video
// and audio codecs, probed with canPlayType / MediaSource.isTypeSupported.
// Pure: the probe is injected, so the table is unit-tested.
import type { MediaInfo, PlaybackSource, Release } from "@martytv/contracts";
import { hlsMode, isHlsSource } from "@martytv/media-types";
import { isWebView } from "../players/select";

export interface Probe {
  canPlayType(type: string): string;
  isTypeSupported?(type: string): boolean;
  /**
   * Only a firm answer counts for the multichannel codecs (AC3, E-AC3, DTS,
   * TrueHD): canPlayType "probably" or MediaSource.isTypeSupported. Android
   * WebViews (MSX, TV launchers) may say "maybe" for formats their pipeline
   * then silently drops: the video plays without sound and no error fires.
   */
  strict?: boolean;
}

interface CodecSpec {
  label: string;
  /** Full MIME types with codecs; supported if any of them answers yes. */
  types: string[];
  /** Only "probably" / isTypeSupported counts (engines say "maybe" and then can't decode). */
  firm?: boolean;
}

/** Normalized key for a codec name from ffprobe or the release parser. */
export function codecKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name.toLowerCase().replace(/[\s_.-]/g, "");
  if (n === "h264" || n === "avc" || n === "avc1" || n === "x264") return "h264";
  if (n === "hevc" || n === "h265" || n === "x265" || n === "hvc1" || n === "hev1") return "hevc";
  if (n === "vp9" || n === "vp09") return "vp9";
  if (n === "vp8") return "vp8";
  if (n === "av1" || n === "av01") return "av1";
  if (n === "mpeg2" || n === "mpeg2video") return "mpeg2";
  if (n === "mpeg4" || n === "xvid" || n === "divx" || n === "mp4v" || n === "msmpeg4v3" || n === "msmpeg4v2") return "mpeg4";
  if (n === "vc1" || n === "wmv3" || n === "wvc1") return "vc1";
  if (n === "aac" || n === "mp4a") return "aac";
  if (n === "ac3" || n === "ac-3") return "ac3";
  if (n === "eac3" || n === "ddp" || n === "ec3") return "eac3";
  if (n.startsWith("dts")) return "dts";
  if (n === "truehd" || n === "mlp") return "truehd";
  if (n === "flac") return "flac";
  if (n === "mp3" || n === "mp2" || n === "mp1") return n;
  if (n === "opus") return "opus";
  if (n === "vorbis") return "vorbis";
  if (n.startsWith("pcm")) return "pcm";
  return n;
}

const VIDEO: Record<string, CodecSpec> = {
  h264: { label: "H.264", types: ['video/mp4; codecs="avc1.640028"', 'video/mp4; codecs="avc1.4d401f"', 'video/mp4; codecs="avc1.42E01E"'] },
  hevc: { label: "HEVC", types: ['video/mp4; codecs="hvc1.1.6.L120.90"', 'video/mp4; codecs="hev1.1.6.L120.90"', 'video/mp4; codecs="hvc1"', 'video/mp4; codecs="hev1"'] },
  vp9: { label: "VP9", types: ['video/webm; codecs="vp9"', 'video/mp4; codecs="vp09.00.10.08"'] },
  vp8: { label: "VP8", types: ['video/webm; codecs="vp8"'] },
  av1: { label: "AV1", types: ['video/mp4; codecs="av01.0.08M.08"', 'video/webm; codecs="av01.0.08M.08"'] },
  // Old codecs: a firm answer only (TVs say "maybe" to bare AVI/MPEG types
  // and then fail to decode MPEG-4 Part 2 / VC-1 / MPEG-2 in a stream).
  mpeg2: { label: "MPEG-2", types: ['video/mp4; codecs="mp4v.61"', 'video/mp2t; codecs="mp2v"', 'video/mpeg; codecs="mp2v"'], firm: true },
  mpeg4: { label: "MPEG-4 (XviD)", types: ['video/mp4; codecs="mp4v.20.9"', 'video/mp4; codecs="mp4v.20.240"'], firm: true },
  vc1: { label: "VC-1", types: ['video/mp4; codecs="vc-1"', 'video/x-ms-wmv; codecs="wvc1"'], firm: true },
  // Profiles hardware decoders often lack (keys `<codec>_<variant>`; see videoKey).
  // H.264 High 10 / 4:2:2 / 4:4:4: TV decoders are 8-bit 4:2:0 — firm answers only.
  h264_10bit: { label: "10-bit H.264", types: ['video/mp4; codecs="avc1.6E0028"', 'video/mp4; codecs="avc1.6e0028"'], firm: true },
  h264_422: { label: "H.264 4:2:2", types: ['video/mp4; codecs="avc1.7A0028"'], firm: true },
  h264_444: { label: "H.264 4:4:4", types: ['video/mp4; codecs="avc1.F40028"'], firm: true },
  // HEVC Main 10: many TVs do decode it — probed, not assumed.
  hevc_10bit: { label: "HEVC 10-bit", types: ['video/mp4; codecs="hvc1.2.4.L120.90"', 'video/mp4; codecs="hev1.2.4.L120.90"', 'video/mp4; codecs="hvc1.2.4.L150.90"'] },
  // HEVC RExt (4:2:2 / 4:4:4 / 12-bit).
  hevc_rext: { label: "HEVC 4:2:2/12-bit", types: ['video/mp4; codecs="hvc1.4.10.L120.9D.08"'], firm: true },
};

/** The base codec of a video key ("h264_10bit" → "h264"). */
export function baseCodec(key: string): string {
  return key.split("_")[0]!;
}

/** Bit depth from ffprobe's pix_fmt ("yuv420p10le" → 10), null when unknown. */
function pixDepth(pixFmt: string | null | undefined): number | null {
  const f = (pixFmt ?? "").toLowerCase();
  if (!f || f === "unknown") return null;
  if (/^nv(12|21|16|24)$/.test(f)) return 8;
  const p = /^p01([026])/.exec(f);
  if (p) return p[1] === "0" ? 10 : p[1] === "2" ? 12 : 16;
  const m = /[a-z](9|10|12|14|16)(?:le|be)?$/.exec(f);
  if (m) return Number(m[1]);
  return /^(yuv|gray$)/.test(f) ? 8 : null;
}

/** Chroma subsampling from pix_fmt / profile: "420", "422", "444" or null. */
function chromaOf(pixFmt: string | null | undefined, profile: string | null | undefined): string | null {
  const m = /yuvj?a?(4[24][024])p/.exec((pixFmt ?? "").toLowerCase());
  if (m) return m[1]!;
  const p = (profile ?? "").toLowerCase();
  if (p.includes("4:4:4")) return "444";
  if (p.includes("4:2:2")) return "422";
  return null;
}

type VideoInfo = Pick<MediaInfo, "video_codec" | "video_profile" | "pix_fmt" | "bit_depth">;

/**
 * The video key of a probed file: the codec, refined by profile / bit
 * depth / chroma when that changes what a TV can decode — "h264_10bit"
 * (High 10, Hi10P), "h264_422", "h264_444", "hevc_10bit" (Main 10),
 * "hevc_rext"; else the plain codec key ("h264", "hevc", "mpeg4"…).
 */
export function videoKey(info: VideoInfo | null | undefined): string | null {
  const key = codecKey(info?.video_codec);
  if (!key || !info) return key;
  const profile = (info.video_profile ?? "").toLowerCase();
  const bits = info.bit_depth ?? pixDepth(info.pix_fmt) ?? 8;
  const chroma = chromaOf(info.pix_fmt, info.video_profile);
  if (key === "h264") {
    if (chroma === "444" || profile.includes("4:4:4")) return "h264_444";
    if (chroma === "422" || profile.includes("4:2:2")) return "h264_422";
    if (bits > 8 || profile.includes("high 10")) return "h264_10bit";
  }
  if (key === "hevc") {
    if (bits > 10 || chroma === "422" || chroma === "444" || /rext|4:2:2|4:4:4|main 12/.test(profile)) return "hevc_rext";
    if (bits > 8 || profile.includes("main 10")) return "hevc_10bit";
  }
  return key;
}

/** Release title hints: «10bit», «Hi10P», «x265 10bit», «AVI». */
const HI10_RE = /\bHi10P?\b/i;
const TEN_BIT_RE = /(?:^|[^0-9])10[- ]?bit/i;
const AVI_RE = /\bAVI\b|\.avi\b/i;

type ReleaseLike = Pick<Release, "video_codec" | "audio_codecs"> & { title?: string | null; hdr?: Release["hdr"] };

/**
 * The video key of a release from its parsed codec and title hints: «Hi10P»
 * → 10-bit H.264; «10bit» with H.264 / HEVC (or HDR HEVC) → the 10-bit key;
 * XviD / DivX → mpeg4. null when the codec is unknown.
 */
export function releaseVideoKey(r: ReleaseLike): string | null {
  const title = r.title ?? "";
  let key = codecKey(r.video_codec);
  if (!key && /\bXviD\b|\bDivX\b/i.test(title)) key = "mpeg4";
  if (HI10_RE.test(title) && (!key || key === "h264")) return "h264_10bit";
  const ten = TEN_BIT_RE.test(title);
  if (key === "h264" && ten) return "h264_10bit";
  if (key === "hevc" && (ten || !!r.hdr)) return "hevc_10bit";
  return key;
}

const AUDIO: Record<string, CodecSpec> = {
  aac: { label: "AAC", types: ['audio/mp4; codecs="mp4a.40.2"'] },
  ac3: { label: "AC3", types: ['audio/mp4; codecs="ac-3"', "audio/ac3"] },
  eac3: { label: "E-AC3", types: ['audio/mp4; codecs="ec-3"', "audio/eac3"] },
  dts: { label: "DTS", types: ['audio/mp4; codecs="dtsc"', 'audio/mp4; codecs="dtsh"', "audio/vnd.dts", "audio/dts"] },
  truehd: { label: "TrueHD", types: ['audio/mp4; codecs="mlpa"', "audio/true-hd"] },
  flac: { label: "FLAC", types: ['audio/mp4; codecs="flac"', "audio/flac"] },
  mp3: { label: "MP3", types: ["audio/mpeg", 'audio/mp4; codecs="mp4a.6B"'] },
  mp2: { label: "MP2", types: ["audio/mpeg", 'audio/mp4; codecs="mp4a.6B"'] },
  opus: { label: "Opus", types: ['audio/webm; codecs="opus"', 'audio/mp4; codecs="opus"'] },
  vorbis: { label: "Vorbis", types: ['audio/webm; codecs="vorbis"'] },
  pcm: { label: "PCM", types: ["audio/wav", 'audio/wav; codecs="1"'] },
};

interface ContainerSpec {
  label: string;
  types: string[];
  /** Engines often play it although canPlayType says no (MKV ≈ WebM). */
  lenient?: string[];
}

const CONTAINERS: Record<string, ContainerSpec> = {
  mp4: { label: "MP4", types: ["video/mp4"] },
  matroska: { label: "MKV", types: ["video/x-matroska", "video/mkv"], lenient: ["video/webm"] },
  webm: { label: "WebM", types: ["video/webm"] },
  mpegts: { label: "MPEG-TS", types: ["video/mp2t", "video/MP2T"] },
  avi: { label: "AVI", types: ["video/x-msvideo", "video/avi"] },
};

export function containerKey(container: string | null | undefined, mime: string | null | undefined): string | null {
  const c = (container ?? "").toLowerCase();
  const m = (mime ?? "").toLowerCase().split(";")[0]!.trim();
  if (/matroska|mkv/.test(c) || m === "video/x-matroska") return c.includes("webm") && m === "video/webm" ? "webm" : "matroska";
  if (/webm/.test(c) || m === "video/webm") return "webm";
  if (/mp4|mov|m4v|isom|3gp/.test(c) || m === "video/mp4" || m === "video/quicktime") return "mp4";
  if (/mpegts|\bts\b|mp2t/.test(c) || m === "video/mp2t") return "mpegts";
  if (/avi/.test(c) || m === "video/x-msvideo" || m === "video/avi") return "avi";
  return null;
}

function yes(probe: Probe, types: string[], firm = false): boolean {
  for (const t of types) {
    try {
      const a = probe.canPlayType(t);
      if (firm ? a === "probably" : a !== "") return true;
      if (probe.isTypeSupported?.(t)) return true;
    } catch {
      // some engines throw on unknown types
    }
  }
  return false;
}

/** For error reports: what the engine answers for an audio codec's MIME types ("probably"/"maybe"/""). */
export function audioProbeAnswers(probe: Probe, name: string | null | undefined): string | null {
  const key = codecKey(name);
  const spec = key ? AUDIO[key] : undefined;
  if (!spec) return null;
  return spec.types
    .map((t) => {
      let a: string;
      try {
        a = probe.canPlayType(t) || "no";
      } catch {
        a = "throws";
      }
      return `${t.replace(/^audio\//, "")}=${a}`;
    })
    .join(" ");
}

/** One checked component of a file. `ok: null` = unknown codec (not judged). */
export interface Part {
  kind: "container" | "video" | "audio" | "mime";
  key: string;
  label: string;
  ok: boolean | null;
}

export interface Support {
  /** "unlikely" when a component the TV must decode isn't supported. */
  verdict: "ok" | "unlikely";
  /** Labels of the unsupported components, e.g. ["HEVC", "DTS"]. */
  unsupported: string[];
  /** Codec keys to avoid in the next release (e.g. ["hevc", "dts"]). */
  avoid: string[];
  parts: Part[];
}

/** Whether this engine decodes a video key (videoKey), null when unknown. `exact`: ffprobe's codec string, tried first. */
export function videoSupported(probe: Probe, key: string, exact?: string | null): boolean | null {
  const spec = VIDEO[key];
  if (!spec) return null;
  const types = exact && /^[a-z0-9]{4}\.[\w.]+$/i.test(exact) ? ['video/mp4; codecs="' + exact + '"', ...spec.types] : spec.types;
  return yes(probe, types, !!spec.firm);
}

function checkVideo(probe: Probe, key: string | null, exact?: string | null): Part | null {
  if (!key) return null;
  const spec = VIDEO[key];
  return { kind: "video", key, label: spec?.label ?? key.toUpperCase(), ok: videoSupported(probe, key, exact) };
}

/** Codecs that WebViews half-support ("maybe", then no sound). */
const MULTICHANNEL = ["ac3", "eac3", "dts", "truehd"];

/**
 * Whether this engine decodes an audio codec (codecKey), null when unknown.
 * The one audio probe: the playback decision and the device report use it.
 */
export function audioSupported(probe: Probe, key: string): boolean | null {
  const spec = AUDIO[key];
  if (!spec) return null;
  return yes(probe, spec.types, !!probe.strict && MULTICHANNEL.includes(key));
}

function checkAudio(probe: Probe, name: string | null | undefined): Part | null {
  const key = codecKey(name);
  if (!key) return null;
  const spec = AUDIO[key];
  return { kind: "audio", key, label: spec?.label ?? key.toUpperCase(), ok: audioSupported(probe, key) };
}

function summarize(parts: Part[]): Support {
  const bad = parts.filter((p) => p.ok === false);
  return {
    verdict: bad.length > 0 ? "unlikely" : "ok",
    unsupported: bad.map((p) => p.label),
    avoid: bad.filter((p) => p.kind === "video" || p.kind === "audio").map((p) => p.key),
    parts,
  };
}

/**
 * Judges a prepared source: container (from media_info or mime), the video
 * codec and the default audio track. With no media_info, only the MIME type
 * and the release's parsed codecs are known.
 */
export function assessSource(
  src: Pick<PlaybackSource, "mime_type" | "media_info"> & { release?: ReleaseLike | null; format?: string | null },
  probe: Probe,
): Support {
  const info: MediaInfo | null = src.media_info ?? null;
  const parts: Part[] = [];
  // Online HLS (H.264/AAC): native HLS, else hls.js over MSE.
  if (src.format === "hls" || (!src.format && isHlsSource(src))) {
    if (hlsMode(probe, !!probe.isTypeSupported) === "none") parts.push({ kind: "mime", key: "hls", label: "HLS", ok: false });
    return summarize(parts);
  }
  const ck = containerKey(info?.container, src.mime_type);
  if (ck) {
    const spec = CONTAINERS[ck]!;
    const ok = yes(probe, spec.types) || (spec.lenient ? yes(probe, spec.lenient) : false);
    parts.push({ kind: "container", key: ck, label: spec.label, ok });
  } else if (src.mime_type) {
    const mime = src.mime_type.split(";")[0]!.trim();
    parts.push({ kind: "mime", key: mime, label: mime, ok: yes(probe, [mime]) });
  } else if (!info && src.release && AVI_RE.test(src.release.title ?? "")) {
    const spec = CONTAINERS.avi!;
    parts.push({ kind: "container", key: "avi", label: spec.label, ok: yes(probe, spec.types) });
  }
  // The probed video (profile / bit depth) when known, else the release's codec + title hints.
  const video = info?.video_codec ? checkVideo(probe, videoKey(info), info.video_codec_string) : checkVideo(probe, src.release ? releaseVideoKey(src.release) : null);
  if (video) parts.push(video);
  if (info && info.audio.length > 0) {
    const main = info.audio.find((a) => a.default) ?? info.audio[0]!;
    const a = checkAudio(probe, main.codec);
    if (a) parts.push(a);
  } else if (!info && src.release && src.release.audio_codecs.length > 0) {
    // Parsed from the title: unknown which track is the default, so only
    // "every listed codec is unsupported" counts.
    const all = src.release.audio_codecs.map((c) => checkAudio(probe, c)).filter((p): p is Part => !!p);
    if (all.length > 0 && all.every((p) => p.ok === false)) parts.push(all[0]!);
  }
  return summarize(parts);
}

/** A release in the picker: judged from its parsed codecs only. */
export function assessRelease(r: ReleaseLike, probe: Probe): Support {
  return assessSource({ mime_type: null, media_info: null, release: r }, probe);
}

/** Server warnings that make a release a poor automatic choice. */
const UNSTREAMABLE = ["likely_unplayable_codec", "disc_image"];

/**
 * Whether a release uses any codec in `avoid`. A video key matches its
 * variants too: avoiding "h264" avoids «Hi10P» releases, avoiding
 * "h264_10bit" leaves plain H.264 alone.
 */
export function usesCodec(r: ReleaseLike, avoid: readonly string[]): boolean {
  if (avoid.length === 0) return false;
  const vk = releaseVideoKey(r);
  const keys = [vk, vk ? baseCodec(vk) : null, ...r.audio_codecs.map(codecKey)];
  return keys.some((k) => k !== null && avoid.includes(k));
}

/**
 * Video keys / containers the server's compat stream converts (old codecs
 * re-encoded to H.264, AVI repackaged as MP4; services/api VideoTranscodable).
 */
const CONVERTIBLE = ["mpeg4", "mpeg2", "vc1", "avi"];

/** A failing part the compat stream fixes: audio (→ AAC), or an old video codec / AVI. */
function compatFixes(p: Part): boolean {
  return p.kind === "audio" || ((p.kind === "video" || p.kind === "container") && CONVERTIBLE.includes(p.key));
}

/**
 * Whether this TV can play a release: nothing it must decode is known
 * unsupported. With compat available (server conversion), an undecodable
 * audio codec, an old video codec (XviD, MPEG-2) or AVI don't count.
 */
export function playableHere(r: ReleaseLike, probe: Probe, compat = false): boolean {
  return !assessRelease(r, probe).parts.some((p) => p.ok === false && !(compat && compatFixes(p)));
}

/** What the TV knows when ranking releases. */
export interface RankEnv {
  probe?: Probe;
  /** Last good download-rate estimate of this TV (bits/s). */
  rateBps?: number | null;
  /** The server converts (compat_url) — undecodable audio, XviD / MPEG-2 video cost less. */
  compat?: boolean;
  /** Title runtime (s) for releases without est_bitrate_bps. */
  runtime?: number | null;
}

type Rankable = Pick<Release, "id" | "video_codec" | "audio_codecs" | "warnings" | "size_bytes" | "is_season_pack"> & {
  score?: number;
  est_bitrate_bps?: number | null;
  title?: string | null;
  hdr?: Release["hdr"];
};

/** Share of the measured rate a release may need (headroom for dips/seeks). */
export const RATE_HEADROOM = 0.9;

/** Estimated average bitrate (bits/s): the server's, else size × 8 / runtime (not for packs). */
export function releaseBitrateOf(r: Rankable, runtime?: number | null): number | null {
  if (typeof r.est_bitrate_bps === "number" && r.est_bitrate_bps > 0) return r.est_bitrate_bps;
  if (!runtime || runtime <= 0 || r.is_season_pack || !r.size_bytes) return null;
  return (r.size_bytes * 8) / runtime;
}

/** Bitrate penalty against the TV's measured rate: 1 when it fits, falling steeply above. */
export function bitrateFactor(bitrate: number | null, rateBps: number | null | undefined): number {
  if (!bitrate || !rateBps || rateBps <= 0) return 1;
  const r = bitrate / (rateBps * RATE_HEADROOM);
  if (r <= 1) return 1;
  if (r <= 1.3) return 0.75;
  return Math.max(0.08, 0.5 / r);
}

/** Audio penalty: main audio undecodable here → mild with compat, strong without. */
export function audioFactor(r: ReleaseLike, probe: Probe | undefined, compat: boolean): number {
  if (!probe) return 1;
  const bad = assessRelease(r, probe).parts.some((p) => p.kind === "audio" && p.ok === false);
  if (!bad) return 1;
  return compat ? 0.85 : 0.4;
}

/**
 * Video penalty: the video (codec, or a profile from the title like «Hi10P»,
 * «x265 10bit») or the container is known undecodable here. Compat copies
 * modern video, so that weighs more than undecodable audio; old codecs
 * (XviD, MPEG-2) and AVI the server converts with compat: a milder penalty
 * (re-encoded SD still loses to a native release).
 */
export function videoFactor(r: ReleaseLike, probe: Probe | undefined, compat = false): number {
  if (!probe) return 1;
  const bad = assessRelease(r, probe).parts.filter((p) => (p.kind === "video" || p.kind === "container") && p.ok === false);
  if (bad.length === 0) return 1;
  return compat && bad.every(compatFixes) ? 0.7 : 0.3;
}

/**
 * «тяжёлая: 39 Мбит/с»: the release needs more than this TV's measured rate
 * allows (or, unmeasured, more than 30 Mbit/s). Returns the Mbit/s or null.
 */
export function heavyMbps(r: Rankable, env: RankEnv): number | null {
  const br = releaseBitrateOf(r, env.runtime);
  if (!br) return null;
  const limit = env.rateBps && env.rateBps > 0 ? env.rateBps * RATE_HEADROOM : 30e6;
  return br > limit ? Math.round(br / 1e6) : null;
}

/**
 * The TV's own order on top of the server ranking: the server score × the
 * bitrate penalty (vs the last measured rate) × the audio penalty × the
 * video penalty (10-bit H.264, XviD… this engine can't decode). Stable:
 * equal factors keep the server's order.
 */
export function rankForTv<R extends Rankable>(items: readonly R[], env: RankEnv): R[] {
  const n = items.length;
  const scored = items.map((r, i) => {
    const base = typeof r.score === "number" && r.score > 0 ? r.score : (n - i) / Math.max(1, n);
    const f = bitrateFactor(releaseBitrateOf(r, env.runtime), env.rateBps) * audioFactor(r, env.probe, !!env.compat) * videoFactor(r, env.probe, !!env.compat);
    return { r, i, s: base * f, f };
  });
  // Only re-order when a penalty applies somewhere (keep the server's tie-breaks otherwise).
  if (scored.every((x) => x.f === 1)) return [...items];
  return scored.sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.r);
}

/**
 * The release to try next: the best-ranked one not tried yet that avoids the
 * failing codecs and isn't flagged as unplayable by the server; falling back
 * to any untried one. With `env`, the TV's ranking (bitrate vs measured
 * rate, audio vs compat) re-orders first.
 */
export function nextRelease<R extends Rankable>(items: readonly R[], tried: readonly string[], avoid: readonly string[], probe?: Probe, env?: RankEnv): R | null {
  const ranked = env ? rankForTv(items, { ...env, probe: env.probe ?? probe }) : items;
  const compat = !!env?.compat;
  const fresh = ranked.filter((r) => !tried.includes(r.id));
  const clean = fresh.filter((r) => !usesCodec(r, compat ? avoid.filter((c) => !AUDIO_KEYS.includes(c)) : avoid));
  const playable = clean.filter((r) => !r.warnings.some((w) => UNSTREAMABLE.includes(w)) && (!probe || playableHere(r, probe, compat)));
  return playable[0] ?? clean[0] ?? (avoid.length === 0 ? (fresh[0] ?? null) : null);
}

const AUDIO_KEYS = Object.keys(AUDIO);

/** Not for silent automatic play here: heavier than this TV's link / cap, or main audio undecodable without compat. */
export function tooHeavyHere(r: Rankable, env: RankEnv): boolean {
  if (heavyMbps(r, env) !== null) return true;
  return !env.compat && !!env.probe && assessRelease(r, env.probe).parts.some((p) => p.kind === "audio" && p.ok === false);
}

/**
 * A source picked earlier (resume from the phone, «Продолжить») whose
 * release is too heavy for this TV now: the best-ranked suitable release to
 * play instead at the same spot (the server's order keeps the profile's
 * voice-over / language preference), or null to keep the current one.
 */
export function lighterInstead<R extends Rankable>(current: Rankable, items: readonly R[], env: RankEnv): R | null {
  if (!tooHeavyHere(current, env)) return null;
  const next = nextRelease(items, [current.id], [], env.probe, env);
  return next && !tooHeavyHere(next, env) ? next : null;
}

/** The video is known undecodable here (the compat stream fixes it only with compat_video: re-encoded to H.264). */
export function videoUndecodable(support: Support | null | undefined): boolean {
  return !!support?.parts.some((p) => p.kind === "video" && p.ok === false);
}

/**
 * A decode error the player gives up on (MEDIA_ERR_DECODE / SRC_NOT_SUPPORTED):
 * the reason to show and the codec keys the next release must avoid.
 * Original file: every unsupported component. Compat stream (MP4 + AAC,
 * video copied): only the video can be at fault — never the audio or the
 * container — so the reason is the video (e.g. «10-bit H.264») and its key is
 * avoided when it's more than plain H.264 (a broken 8-bit H.264 file says
 * nothing about other H.264 releases; it's in `tried` anyway). (Re-encoded
 * video is H.264 too: the same reasoning names the source codec.)
 */
export function decodeFailure(support: Support | null | undefined, compat: boolean, mime: string | null | undefined): { reason: string; avoid: string[] } {
  const fallback = (mime ?? "").split(";")[0]!.trim() || "?";
  if (!support) return { reason: fallback, avoid: [] };
  if (!compat) return { reason: support.unsupported.length > 0 ? support.unsupported.join(", ") : fallback, avoid: support.avoid };
  const video = support.parts.find((p) => p.kind === "video");
  if (!video) return { reason: fallback, avoid: [] };
  return { reason: video.label, avoid: video.ok === false || video.key !== "h264" ? [video.key] : [] };
}

/** The engine's probe (the given video element, else a fresh one); strict in Android WebViews. */
export function engineProbe(video?: HTMLVideoElement | null): Probe {
  const v = video ?? (typeof document !== "undefined" ? document.createElement("video") : null);
  const MS = typeof window !== "undefined" ? (window as unknown as { MediaSource?: { isTypeSupported?(t: string): boolean } }).MediaSource : undefined;
  return {
    canPlayType: (t) => (v ? v.canPlayType(t) : ""),
    isTypeSupported: MS?.isTypeSupported ? (t) => !!MS.isTypeSupported!(t) : undefined,
    strict: isWebView(typeof navigator !== "undefined" ? navigator.userAgent : ""),
  };
}
