// Display helpers for releases, sources and the player (pure).
import type { MediaInfo, Release } from "@martytv/contracts";
import { episodeCode, releaseFormat, releaseFormatText } from "@martytv/media-types";
import { voiceoverLabel } from "./tracks";

const UNITS: Record<string, string[]> = {
  en: ["B", "KB", "MB", "GB", "TB"],
  ru: ["Б", "КБ", "МБ", "ГБ", "ТБ"],
};

/** 1.4 GB / 850 MB (decimal separator per locale). */
export function formatBytes(n: number | null | undefined, locale = "en"): string {
  const units = UNITS[locale] ?? UNITS.en!;
  if (n === null || n === undefined || !isFinite(n) || n < 0) return "—";
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = v < 10 && i >= 2 ? 1 : 0;
  const s = v.toFixed(digits);
  return `${locale === "ru" ? s.replace(".", ",") : s} ${units[i]}`;
}

/** Download speed (bytes per second). */
export function formatSpeed(bps: number | null | undefined, locale = "en"): string {
  return `${formatBytes(bps ?? 0, locale)}/${locale === "ru" ? "с" : "s"}`;
}

/** 4:05 / 1:02:03. */
export function formatClock(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !isFinite(sec) || sec < 0) return "--:--";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "S01E02 · Name" (or just the code). */
export function episodeLabel(season: number | null | undefined, episode: number | null | undefined, name?: string | null): string | null {
  if (season === null || season === undefined || episode === null || episode === undefined) return null;
  const code = episodeCode(season, episode);
  return name ? `${code} · ${name}` : code;
}

const QUALITY: Record<string, string> = {
  remux: "Remux",
  bluray: "Blu-ray",
  bdrip: "BDRip",
  "web-dl": "WEB-DL",
  webrip: "WEBRip",
  hdtv: "HDTV",
  dvd: "DVD",
  cam: "CAM",
  telesync: "TS",
  screener: "SCR",
};

const HDR: Record<string, string> = { hdr10: "HDR10", hdr10plus: "HDR10+", dolby_vision: "Dolby Vision", hlg: "HLG" };
const VCODEC: Record<string, string> = { hevc: "HEVC", h264: "H.264", av1: "AV1", mpeg2: "MPEG-2", xvid: "XviD" };
const ACODEC: Record<string, string> = { aac: "AAC", ac3: "AC3", eac3: "E-AC3", dts: "DTS", truehd: "TrueHD", flac: "FLAC", mp3: "MP3", opus: "Opus" };

export const WARNING_KEYS = {
  low_seeders: "player.warning.low_seeders",
  cam_quality: "player.warning.cam_quality",
  over_size_limit: "player.warning.over_size_limit",
  no_preferred_language: "player.warning.no_preferred_language",
  likely_unplayable_codec: "player.warning.likely_unplayable_codec",
  disc_image: "player.tv.warning.disc_image",
  // Device playback profile (server ranking for this TV).
  too_heavy_for_device: "tvplay.warn.too_heavy_for_device",
  over_device_resolution: "tvplay.warn.over_device_resolution",
  codec_unsupported: "tvplay.warn.codec_unsupported",
  codec_unknown: "tvplay.warn.codec_unknown",
  audio_needs_conversion: "tvplay.warn.audio_needs_conversion",
  audio_unsupported: "tvplay.warn.audio_unsupported",
} as const;
export type WarningKey = (typeof WARNING_KEYS)[keyof typeof WARNING_KEYS];

export interface ReleaseRow {
  /** Big badge: 4K / 1080p / 720p / SD / "?" */
  resolution: string;
  /** Chips after the resolution: quality, HDR, codec. */
  chips: string[];
  hdr: string | null;
  audio: string;
  languages: string;
  /** Voice-overs named in the title: "MVO · LostFilm" (dubs first, max 3). */
  voices: string[];
  size: string;
  seeders: number;
  seasonPack: boolean;
  /** Known warnings (translation keys); unknown ones are dropped. */
  warnings: WarningKey[];
  /** Episode range for packs etc., e.g. "S01" / "S01–S03" / "S01E05". */
  scope: string | null;
}

function resolutionLabel(r: Release["resolution"]): string {
  if (r === "2160p") return "4K";
  if (r === "576p" || r === "480p") return "SD";
  return r ?? "—";
}

function scopeLabel(r: Pick<Release, "seasons" | "episodes">): string | null {
  if (r.seasons.length === 0) return null;
  const s = [...r.seasons].sort((a, b) => a - b);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s.length > 1) return `S${pad(s[0]!)}–S${pad(s[s.length - 1]!)}`;
  if (r.episodes.length === 1) return `S${pad(s[0]!)}E${pad(r.episodes[0]!)}`;
  if (r.episodes.length > 1) {
    const e = [...r.episodes].sort((a, b) => a - b);
    return `S${pad(s[0]!)}E${pad(e[0]!)}–E${pad(e[e.length - 1]!)}`;
  }
  return `S${pad(s[0]!)}`;
}

/** What a picker row shows for a release. */
export function releaseRow(r: Release, locale = "en"): ReleaseRow {
  const hdr = r.hdr ? (HDR[r.hdr] ?? r.hdr.toUpperCase()) : null;
  const chips = [r.source_quality ? (QUALITY[r.source_quality] ?? r.source_quality) : null, hdr, r.video_codec ? (VCODEC[r.video_codec] ?? r.video_codec.toUpperCase()) : null, releaseFormatText(releaseFormat(r))].filter(
    (c): c is string => !!c,
  );
  const audio = [...new Set(r.audio_codecs.map((c) => ACODEC[c.toLowerCase()] ?? c.toUpperCase()))].join(" · ");
  const languages = r.languages.map((l) => l.toUpperCase()).join(" · ");
  const warnings = r.warnings.filter((w): w is keyof typeof WARNING_KEYS => w in WARNING_KEYS).map((w) => WARNING_KEYS[w]);
  return {
    resolution: resolutionLabel(r.resolution),
    chips,
    hdr,
    audio,
    languages,
    voices: [...new Set((r.voiceovers ?? []).map(voiceoverLabel).filter((v): v is string => !!v))].slice(0, 3),
    size: formatBytes(r.size_bytes, locale),
    seeders: r.seeders,
    seasonPack: r.is_season_pack,
    warnings,
    scope: scopeLabel(r),
  };
}

type Stream = MediaInfo["audio"][number];

/** Label of an audio/subtitle stream: "RU · AC3 5.1 · Dub". */
export function streamLabel(s: Stream, n: number): string {
  const parts: string[] = [];
  if (s.language && s.language !== "und") parts.push(s.language.toUpperCase());
  if (s.codec) parts.push(`${(ACODEC[s.codec.toLowerCase()] ?? s.codec.toUpperCase()).replace("SUBRIP", "SRT")}${channels(s.channels)}`);
  if (s.title) parts.push(s.title);
  return parts.length > 0 ? parts.join(" · ") : `#${n + 1}`;
}

function channels(c: number | null | undefined): string {
  if (!c) return "";
  if (c === 6) return " 5.1";
  if (c === 8) return " 7.1";
  if (c === 2) return " 2.0";
  if (c === 1) return " 1.0";
  return ` ${c}ch`;
}
