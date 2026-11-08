import type { MessageKey } from "./i18n";

// YouTube audio tracks (auto-dubs): the «Аудио» choice of the TV and PWA
// players and the phone remote. The source lists the languages
// (PlaybackSource.audio_tracks, the server's order: VIDEO_LANG, the
// original, English…) and plays one (audio_track). A viewer's pick is kept
// per device — "original" or a language — and sent with every new source,
// so it is the default for the next videos; without a pick the server's
// default (the viewer's language, else the original) plays.

export interface VideoAudioTrackLike {
  id: string;
  language: string;
  original: boolean;
}

/** A device's choice: the video's own audio, or a language ("ru", "pt-br"). */
export type VideoAudioPref = "original" | (string & {});

export interface VideoAudioOption {
  id: string;
  language: string;
  original: boolean;
  selected: boolean;
}

/** The «Аудио» list: the original first, then the dubs in the server's order. Empty for one track. */
export function audioOptions(tracks: readonly VideoAudioTrackLike[] | null | undefined, current: string | null | undefined): VideoAudioOption[] {
  if (!tracks || tracks.length < 2) return [];
  const sel = current ?? tracks[0]!.id;
  const out = tracks.map((t) => ({ id: t.id, language: t.language, original: t.original, selected: t.id === sel }));
  return [...out.filter((o) => o.original), ...out.filter((o) => !o.original)];
}

/** What a pick remembers: the original stays «the original» on the next video (whatever its language). */
export function prefForTrack(t: Pick<VideoAudioTrackLike, "language" | "original">): VideoAudioPref {
  return t.original ? "original" : t.language.toLowerCase();
}

const base = (l: string) => l.toLowerCase().split("-")[0]!;

/**
 * The track a preference plays (the server's rule, for the remote's list
 * before the new source answers): the original, the language (exact, else
 * the same base language), else the first.
 */
export function resolveAudio<T extends VideoAudioTrackLike>(tracks: readonly T[], pref: VideoAudioPref | null | undefined): T | null {
  if (tracks.length === 0) return null;
  const p = (pref ?? "").toLowerCase();
  if (p === "original") return tracks.find((t) => t.original) ?? tracks[0]!;
  if (p) return tracks.find((t) => t.language === p) ?? tracks.find((t) => base(t.language) === base(p)) ?? tracks[0]!;
  return tracks[0]!;
}

/** A stored value that is still a valid preference (else null: the server's default). */
export function parseAudioPref(v: unknown): VideoAudioPref | null {
  return typeof v === "string" && (v === "original" || /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(v)) ? v : null;
}

/** Languages with a name in the locale files (ytaudio.lang.<code>); others use Intl or the code. */
export const AUDIO_LANGS = ["ru", "en", "kk", "uk", "de", "fr", "es", "pt", "it", "pl", "tr", "ja", "ko", "zh", "hi", "id", "ar", "nl", "vi", "th"] as const;

/** The base language code with a translated name, or null. */
export function knownAudioLang(lang: string): (typeof AUDIO_LANGS)[number] | null {
  const b = base(lang);
  return (AUDIO_LANGS as readonly string[]).includes(b) ? (b as (typeof AUDIO_LANGS)[number]) : null;
}

/** Name of a language without a locale string: Intl.DisplayNames where the engine has it (not old TVs), else the code. */
export function intlLangName(lang: string, locale: string): string {
  try {
    const DN = (Intl as unknown as { DisplayNames?: new (l: string[], o: { type: string }) => { of(c: string): string | undefined } }).DisplayNames;
    const n = DN ? new DN([locale], { type: "language" }).of(lang) : undefined;
    if (n) return n.charAt(0).toUpperCase() + n.slice(1);
  } catch {
    // unknown code / engine
  }
  return lang.toUpperCase();
}

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** «Русский», «Португальский (BR)», else Intl's name or the code. */
export function audioLangName(lang: string, t: Translate, locale: string): string {
  const k = knownAudioLang(lang);
  if (!k) return intlLangName(lang, locale);
  const region = lang.split("-")[1];
  const name = t(`ytaudio.lang.${k}` as MessageKey);
  return region ? `${name} (${region.toUpperCase()})` : name;
}

/** «Оригинал · Английский» / «Русский дубляж». */
export function audioLabel(o: Pick<VideoAudioTrackLike, "language" | "original">, t: Translate, locale: string): string {
  if (!o.language) return t("ytaudio.original_plain");
  const lang = audioLangName(o.language, t, locale);
  return o.original ? t("ytaudio.original", { lang }) : t("ytaudio.dub", { lang });
}

const PREF_KEY = "martytv.video.audio";
/** This session's choice when storage is off. */
let memPref: VideoAudioPref | null = null;

/** The device's audio choice for YouTube (localStorage; null = the server's default). */
export const videoAudioPref = {
  get(): VideoAudioPref | null {
    try {
      return parseAudioPref(localStorage.getItem(PREF_KEY)) ?? memPref;
    } catch {
      return memPref;
    }
  },
  set(p: VideoAudioPref | null): void {
    memPref = p;
    try {
      if (p) localStorage.setItem(PREF_KEY, p);
      else localStorage.removeItem(PREF_KEY);
    } catch {
      // private mode / storage off: this session only
    }
  },
};
