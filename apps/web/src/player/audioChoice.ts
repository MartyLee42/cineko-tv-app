// Which audio track (voice-over / language) to play, from the file's ffprobe
// tracks: the track picked for this title last time, else the profile's
// voice-over studios, else its languages, else the file's default.
// Pure except the small per-title memory in localStorage.
import type { MediaInfo } from "@martytv/contracts";

type Track = MediaInfo["audio"][number];

export interface AudioPrefs {
  voiceovers?: readonly string[] | null;
  languages?: readonly string[] | null;
}

/** What was picked for a title: track indexes differ between releases, names don't. */
export interface RememberedAudio {
  language: string | null;
  title: string | null;
}

export type AudioReason = "remembered" | "voiceover" | "language" | "default";

/** ISO 639-2 → 639-1 for the languages users pick. */
const ISO3: Record<string, string> = {
  rus: "ru", eng: "en", ukr: "uk", bel: "be", kaz: "kk", ger: "de", deu: "de", fre: "fr", fra: "fr", spa: "es", ita: "it", jpn: "ja", kor: "ko", chi: "zh", zho: "zh",
};

export const normLang = (l: string | null | undefined): string | null => {
  const s = (l ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return !s || s === "und" ? null : (ISO3[s] ?? s);
};

const normTitle = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** The track the file plays by default (what the server's compat stream uses without audio=). */
export function defaultAudioIndex(info: MediaInfo | null | undefined): number | null {
  const audio = info?.audio ?? [];
  if (!audio.length) return null;
  return (audio.find((a) => a.default) ?? audio[0]!).index;
}

function rememberedTrack(audio: readonly Track[], r: RememberedAudio | null | undefined): Track | undefined {
  if (!r) return undefined;
  const lang = normLang(r.language);
  const title = normTitle(r.title);
  if (title) {
    const same = audio.find((a) => normTitle(a.title) === title && (!lang || normLang(a.language) === lang));
    if (same) return same;
    const named = audio.find((a) => normTitle(a.title) === title);
    if (named) return named;
  }
  return lang ? audio.find((a) => normLang(a.language) === lang) : undefined;
}

/** The track to play and why (a non-default reason may be worth switching streams for). */
export function chooseAudio(
  info: MediaInfo | null | undefined,
  prefs: AudioPrefs = {},
  remembered?: RememberedAudio | null,
): { index: number; reason: AudioReason } | null {
  const audio = info?.audio ?? [];
  if (!audio.length) return null;
  const mem = rememberedTrack(audio, remembered);
  if (mem) return { index: mem.index, reason: "remembered" };
  for (const studio of prefs.voiceovers ?? []) {
    const s = studio.trim().toLowerCase();
    if (!s) continue;
    const hit = audio.find((a) => (a.title ?? "").toLowerCase().includes(s));
    if (hit) return { index: hit.index, reason: "voiceover" };
  }
  // The default track first when it already speaks a preferred language.
  const def = audio.find((a) => a.default) ?? audio[0]!;
  for (const lang of prefs.languages ?? []) {
    const l = normLang(lang);
    if (!l) continue;
    if (normLang(def.language) === l) return { index: def.index, reason: "language" };
    const hit = audio.find((a) => normLang(a.language) === l);
    if (hit) return { index: hit.index, reason: "language" };
  }
  return { index: def.index, reason: "default" };
}

/**
 * Direct play can't change the track (no `audioTracks`, e.g. Chrome), yet a
 * preferred one isn't the file's default: worth playing through the server
 * (compat) for the right voice.
 */
export function audioNeedsSwitch(info: MediaInfo | null | undefined, choice: { index: number; reason: AudioReason } | null, nativeTracks: boolean): boolean {
  if (nativeTracks || !choice || choice.reason === "default") return false;
  return choice.index !== defaultAudioIndex(info);
}

/** Position of a stream index among the file's audio tracks (= the element's audioTracks order). */
export function audioPosition(info: MediaInfo | null | undefined, index: number): number {
  return (info?.audio ?? []).findIndex((a) => a.index === index);
}

/** The profile's languages, else the UI language. */
export function audioLanguages(profile: readonly string[] | null | undefined, locale: string): string[] {
  return profile && profile.length > 0 ? [...profile] : [locale];
}

// ---------------------------------------------------------------- memory

const KEY = "martytv.audio_choice";
const MAX = 200;

type Store = Record<string, RememberedAudio & { at: number }>;

function load(): Store {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Store) : {};
  } catch {
    return {};
  }
}

export function readAudioChoice(mediaId: string | null | undefined): RememberedAudio | null {
  if (!mediaId) return null;
  const v = load()[mediaId];
  return v && (v.language || v.title) ? { language: v.language ?? null, title: v.title ?? null } : null;
}

/** Remembers the picked track for a title (newest 200 titles). */
export function writeAudioChoice(mediaId: string | null | undefined, track: Pick<Track, "language" | "title"> | null | undefined, now = Date.now()): void {
  if (!mediaId || !track) return;
  const s = load();
  s[mediaId] = { language: track.language ?? null, title: track.title ?? null, at: now };
  const keys = Object.keys(s);
  if (keys.length > MAX) {
    keys
      .sort((a, b) => (s[a]!.at ?? 0) - (s[b]!.at ?? 0))
      .slice(0, keys.length - MAX)
      .forEach((k) => delete s[k]);
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // private mode
  }
}
