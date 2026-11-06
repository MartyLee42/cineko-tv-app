// Pure release / source helpers (no React, no I/O) so they can be unit tested.
import type { DeviceState, Release } from "@martytv/contracts";
import type { MessageKey } from "@martytv/ui";

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

// ---------------------------------------------------------------- labels

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** 14.2 GB, 850 MB, 9.8 MB (binary units, as torrent clients show them). */
export function formatSize(bytes: number | null | undefined, locale = "en"): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "—";
  const nf = (n: number, digits: number) =>
    n.toLocaleString(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  if (bytes >= GB) return `${nf(bytes / GB, bytes >= 100 * GB ? 0 : 1)} GB`;
  if (bytes >= MB) return `${nf(bytes / MB, 0)} MB`;
  return `${nf(Math.max(1, bytes / 1024), 0)} KB`;
}

/** Download speed in bytes per second → "3.4 MB/s". */
export function formatSpeed(bytesPerSecond: number | null | undefined, locale = "en"): string {
  if (!bytesPerSecond || bytesPerSecond < 0) return "0 KB/s";
  if (bytesPerSecond >= MB) return `${(bytesPerSecond / MB).toLocaleString(locale, { maximumFractionDigits: 1 })} MB/s`;
  return `${Math.round(bytesPerSecond / 1024).toLocaleString(locale)} KB/s`;
}

const RES: Record<string, string> = { "2160p": "4K", "1080p": "1080p", "720p": "720p", "576p": "576p", "480p": "480p" };
export function resolutionLabel(r: string | null | undefined): string | null {
  return r ? (RES[r] ?? r) : null;
}

const CODEC: Record<string, string> = { hevc: "HEVC", h264: "H.264", av1: "AV1", mpeg2: "MPEG-2", xvid: "XviD" };
export function codecLabel(c: string | null | undefined): string | null {
  return c ? (CODEC[c] ?? c.toUpperCase()) : null;
}

const HDR: Record<string, string> = { hdr10: "HDR10", hdr10plus: "HDR10+", dolby_vision: "Dolby Vision", hlg: "HLG" };
export function hdrLabel(h: string | null | undefined): string | null {
  return h ? (HDR[h] ?? h.toUpperCase()) : null;
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
export function qualityLabel(q: string | null | undefined): string | null {
  return q ? (QUALITY[q] ?? q.toUpperCase()) : null;
}

const AUDIO: Record<string, string> = {
  aac: "AAC",
  ac3: "DD",
  eac3: "DD+",
  dts: "DTS",
  "dts-hd": "DTS-HD",
  truehd: "TrueHD",
  atmos: "Atmos",
  flac: "FLAC",
  mp3: "MP3",
  opus: "Opus",
};
export function audioCodecsLabel(codecs: string[]): string | null {
  const out = [...new Set(codecs.map((c) => AUDIO[c.toLowerCase()] ?? c.toUpperCase()))];
  return out.length ? out.join(" · ") : null;
}

/** Display name of a language code in the UI language ("ru" → "Russian" / "русский"). */
export function languageName(code: string, locale = "en"): string {
  try {
    const dn = new Intl.DisplayNames([locale], { type: "language" });
    const name = dn.of(code);
    if (name && name !== code) return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  } catch {
    // unknown code or no Intl.DisplayNames: fall through
  }
  return code.toUpperCase();
}

const VO_KIND: Record<string, string> = { dub: "Dub", mvo: "MVO", dvo: "DVO", avo: "AVO", vo: "VO" };

/**
 * Compact chip text for a parsed voice-over: "Dub", "Dub · Пифагор",
 * "MVO · LostFilm", "AVO · Гаврилов", "Original EN", or "RU" when only the
 * language is known.
 */
export function voiceoverLabel(v: { kind: string | null; studio: string | null; language: string }): string {
  const lang = v.language && v.language !== "orig" ? v.language.toUpperCase() : "";
  if (v.kind === "original") return lang ? `Original ${lang}` : "Original";
  const kind = v.kind ? VO_KIND[v.kind] ?? v.kind.toUpperCase() : null;
  const parts = [kind, v.studio].filter(Boolean) as string[];
  if (!parts.length) return lang || "—";
  return parts.join(" · ");
}

/**
 * Audio track label as "Русский · LostFilm": the language name plus the
 * track title, without repeating the language when the title already is it.
 */
export function trackLabel(tr: { label?: string | null; title?: string | null; language?: string | null }, locale = "en"): string {
  const lang = tr.language && tr.language !== "und" ? languageName(tr.language, locale) : "";
  const redundant = (x: string) => {
    const tl = x.toLowerCase();
    return (
      /^(track|audio|stereo|sound)\s*\d*$/i.test(x) ||
      (!!lang &&
        (tl === tr.language!.toLowerCase() || tl.includes(lang.toLowerCase()) || tl === languageName(tr.language!, "en").toLowerCase() ||
          tl === tr.language!.toLowerCase().slice(0, 3)))
    );
  };
  // An engine label that only repeats the language must not hide the studio
  // (LostFilm, MovieDalen…) from the file's track title.
  const title = [tr.label, tr.title].map((x) => (x ?? "").trim()).find((x) => x && !redundant(x)) ?? "";
  if (!lang) return title || (tr.label ?? tr.title ?? "").trim() || "—";
  return title ? `${lang} · ${title}` : lang;
}

/** Compact language code for a chip: "RU", "EN". */
export function languageCode(code: string): string {
  return code.toUpperCase();
}

export function confidencePct(c: number): number {
  return Math.round(Math.max(0, Math.min(1, c)) * 100);
}

const WARNINGS: Record<string, MessageKey> = {
  low_seeders: "player.warning.low_seeders",
  cam_quality: "player.warning.cam_quality",
  over_size_limit: "player.warning.over_size_limit",
  no_preferred_language: "player.warning.no_preferred_language",
  likely_unplayable_codec: "player.warning.likely_unplayable_codec",
  uncertain_match: "player.warning.uncertain_match",
  // Device playback profile (shared with the TV).
  too_heavy_for_device: "tvplay.warn.too_heavy_for_device",
  over_device_resolution: "tvplay.warn.over_device_resolution",
  codec_unsupported: "tvplay.warn.codec_unsupported",
  codec_unknown: "tvplay.warn.codec_unknown",
  audio_needs_conversion: "tvplay.warn.audio_needs_conversion",
  audio_unsupported: "tvplay.warn.audio_unsupported",
  hdr_avoided: "tvplay.warn.hdr_avoided",
};

/** Localized warning chips; unknown codes are shown humanized rather than dropped. */
export function warningLabels(warnings: string[], t: T): string[] {
  return warnings.map((w) => {
    const key = WARNINGS[w];
    return key ? t(key) : w.replace(/_/g, " ");
  });
}

/** "S01E03", "S01E01–E08", "S02" (season pack) — what a release covers. */
export function coverageLabel(r: Pick<Release, "seasons" | "episodes" | "is_season_pack">): string | null {
  const s = [...r.seasons].sort((a, b) => a - b);
  const e = [...r.episodes].sort((a, b) => a - b);
  if (!s.length) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const seasons = s.length > 1 ? `S${pad(s[0]!)}–S${pad(s[s.length - 1]!)}` : `S${pad(s[0]!)}`;
  if (s.length > 1 || !e.length) return seasons;
  return e.length === 1 ? `${seasons}E${pad(e[0]!)}` : `${seasons}E${pad(e[0]!)}–E${pad(e[e.length - 1]!)}`;
}

// ---------------------------------------------------------------- filters

export interface ReleaseFilters {
  resolution: string | null;
  language: string | null;
}

export const NO_FILTERS: ReleaseFilters = { resolution: null, language: null };

const RES_ORDER = ["2160p", "1080p", "720p", "576p", "480p"];

/** Filter chips offered for a result set: resolutions high → low, languages by how common they are. */
export function filterOptions(items: Release[]): { resolutions: string[]; languages: string[] } {
  const res = new Set(items.map((r) => r.resolution).filter((x): x is NonNullable<typeof x> => !!x));
  const counts = new Map<string, number>();
  for (const r of items) for (const l of new Set(r.languages)) counts.set(l, (counts.get(l) ?? 0) + 1);
  return {
    resolutions: RES_ORDER.filter((x) => res.has(x as never)),
    languages: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([l]) => l),
  };
}

/** Client-side quick filters; keeps the server's ranking order. */
export function applyFilters(items: Release[], f: ReleaseFilters): Release[] {
  return items.filter(
    (r) => (!f.resolution || r.resolution === f.resolution) && (!f.language || r.languages.includes(f.language)),
  );
}

/** Drops filters whose value no longer exists in the result set (e.g. after "Search again"). */
export function sanitizeFilters(items: Release[], f: ReleaseFilters): ReleaseFilters {
  const o = filterOptions(items);
  return {
    resolution: f.resolution && o.resolutions.includes(f.resolution) ? f.resolution : null,
    language: f.language && o.languages.includes(f.language) ? f.language : null,
  };
}

// ---------------------------------------------------------------- ranking & queries

/**
 * Releases are ranked with the preferences of whoever is watching: the active
 * profile on the target TV when it reports one, else the server default.
 */
export function rankingProfileId(state: DeviceState | null | undefined): string | undefined {
  return state?.profile_id ?? undefined;
}

export interface ReleaseTarget {
  media_id: string;
  /** Series only. */
  season_number?: number;
  episode_number?: number;
  episode_id?: string;
}

/**
 * Whose playback profile ranks the list: a TV (`device_id`), this browser
 * (`client_id`), and «Показать все» (`all` → device_prefs=off).
 */
export interface RankFor {
  device_id?: string;
  client_id?: string;
  all?: boolean;
}

/** Query parameters for GET /media/{id}/releases. */
export function releaseParams(
  t: ReleaseTarget,
  opts: { profile_id?: string; refresh?: boolean; lang?: "en" | "ru"; q?: string | null; loose?: boolean; rank?: RankFor } = {},
): {
  season?: number;
  episode?: number;
  profile_id?: string;
  refresh?: boolean;
  lang?: "en" | "ru";
  q?: string;
  loose?: boolean;
  device_id?: string;
  client_id?: string;
  device_prefs?: "off";
} {
  return {
    ...(opts.rank?.device_id && { device_id: opts.rank.device_id }),
    ...(!opts.rank?.device_id && opts.rank?.client_id && { client_id: opts.rank.client_id }),
    ...(opts.rank?.all && { device_prefs: "off" as const }),
    ...(opts.q && { q: opts.q }),
    ...(opts.loose && { loose: true }),
    ...(t.season_number != null && { season: t.season_number }),
    ...(t.season_number != null && t.episode_number != null && { episode: t.episode_number }),
    ...(opts.profile_id && { profile_id: opts.profile_id }),
    ...(opts.refresh && { refresh: true }),
    ...(opts.lang && { lang: opts.lang }),
  };
}

/** "S01E02 · Name" → { season: 1, episode: 2 } (the TV's episode_label format). */
export function episodeFromLabel(label: string | null | undefined): { season: number; episode: number } | null {
  const m = label?.match(/S(\d{1,3})\s*E(\d{1,4})/i);
  return m ? { season: Number(m[1]), episode: Number(m[2]) } : null;
}

// ---------------------------------------------------------------- source errors

const SOURCE_ERRORS: Record<string, MessageKey> = {
  no_metadata: "player.error.no_metadata",
  no_matching_file: "player.error.no_matching_file",
  torrserver_unavailable: "player.error.torrserver_unavailable",
  release_unavailable: "player.error.release_unavailable",
  not_found: "player.error.release_unavailable",
  no_releases: "player.no_releases",
  network: "common.network_error",
  network_error: "common.network_error",
};

export function sourceErrorMessage(code: string | null | undefined, t: T): string {
  const c = code || "failed";
  const key = SOURCE_ERRORS[c];
  return key ? t(key) : t("player.error.generic", { code: c });
}
