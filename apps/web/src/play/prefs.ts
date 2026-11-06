// Pure helpers for the playback-preferences editor.
import type { Schemas } from "@martytv/contracts";

export type Preferences = Schemas["Preferences"];

export const COMMON_LANGUAGES = ["ru", "en", "uk", "ja", "ko", "de", "fr", "es", "it", "zh"];
export const CODECS = ["h264", "hevc", "av1"];
export const RESOLUTIONS = ["", "2160p", "1080p", "720p", "480p"] as const;

/** Toggles a value in a priority-ordered list (appended last when added). */
export function toggleOrdered(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

/** Chips to offer: the common set plus anything already saved that isn't in it. */
export function languageOptions(selected: string[]): string[] {
  return [...COMMON_LANGUAGES, ...selected.filter((l) => !COMMON_LANGUAGES.includes(l))];
}

/** Max size input → GB number, null (no limit) or "invalid". Accepts "4,5" too. */
export function parseMaxSize(input: string): number | null | "invalid" {
  const v = input.trim().replace(",", ".");
  if (!v) return null;
  if (!/^\d+(\.\d+)?$/.test(v)) return "invalid";
  const n = Number(v);
  return n > 0 && n <= 1000 ? n : "invalid";
}

export function formatMaxSize(n: number | null | undefined): string {
  return n == null ? "" : String(n);
}

/** Server validation fields → which editor field shows them. */
export function prefsFieldErrors(fields: Record<string, string>): {
  audio?: string;
  subtitles?: string;
  resolution?: string;
  max_size?: string;
  codecs?: string;
  voiceovers?: string;
  other?: string;
} {
  const langs = fields.languages ?? fields.preferred_audio_languages;
  const out = {
    audio: langs,
    subtitles: fields.preferred_subtitle_languages ?? fields.languages,
    resolution: fields.preferred_resolution,
    max_size: fields.max_size_gb,
    codecs: fields.preferred_codecs,
    voiceovers: fields.preferred_voiceovers,
    other: [fields.lists, fields.ui_language].filter(Boolean).join(" ") || undefined,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v)) as typeof out;
}

export const VOICEOVER_SUGGESTIONS = [
  "LostFilm",
  "HDRezka Studio",
  "NewStudio",
  "Кубик в Кубе",
  "AlexFilm",
  "Jaskier",
  "TVShows",
  "Red Head Sound",
  "Пифагор",
  "AniLibria",
  "Гоблин",
  "Гаврилов",
];
export const MAX_VOICEOVERS = 10;

/** Appends a studio (trimmed, ≤40 chars, case-insensitive dedupe, ≤10 items). */
export function addVoiceover(list: readonly string[], name: string): string[] {
  const v = name.trim().replace(/\s+/g, " ").slice(0, 40);
  if (!v || list.length >= MAX_VOICEOVERS) return [...list];
  if (list.some((x) => x.toLocaleLowerCase() === v.toLocaleLowerCase())) return [...list];
  return [...list, v];
}

/** Moves item `i` one step up (-1) or down (+1). */
export function moveItem<T>(list: readonly T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return [...list];
  const out = [...list];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}
