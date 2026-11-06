// Audio/subtitle track naming and the preferred-voice-over choice (pure).
// Track labels read like "Русский · LostFilm" / "English · Original": the
// language's own name plus the stream title (studio) from ffprobe or the
// engine's track label.

/** ISO 639-2 (as ffprobe / engines report) → 639-1 for common languages. */
const ISO3: Record<string, string> = {
  rus: "ru", eng: "en", ukr: "uk", bel: "be", kaz: "kk", ger: "de", deu: "de", fre: "fr", fra: "fr", spa: "es", ita: "it",
  jpn: "ja", kor: "ko", chi: "zh", zho: "zh", por: "pt", pol: "pl", tur: "tr", cze: "cs", ces: "cs", heb: "he", ara: "ar",
  hin: "hi", swe: "sv", nor: "no", dan: "da", fin: "fi", dut: "nl", nld: "nl", hun: "hu", gre: "el", ell: "el", tha: "th",
  // English names engines use as track labels ("Russian").
  russian: "ru", english: "en", ukrainian: "uk", german: "de", french: "fr", spanish: "es", italian: "it", japanese: "ja",
  korean: "ko", chinese: "zh", polish: "pl", turkish: "tr", kazakh: "kk",
};

/** Native language names (no Intl.DisplayNames on old TV engines). */
const NAMES: Record<string, string> = {
  ru: "Русский", en: "English", uk: "Українська", be: "Беларуская", kk: "Қазақша", de: "Deutsch", fr: "Français", es: "Español",
  it: "Italiano", ja: "日本語", ko: "한국어", zh: "中文", pt: "Português", pl: "Polski", tr: "Türkçe", cs: "Čeština", he: "עברית",
  ar: "العربية", hi: "हिन्दी", sv: "Svenska", no: "Norsk", da: "Dansk", fi: "Suomi", nl: "Nederlands", hu: "Magyar", el: "Ελληνικά", th: "ไทย",
};

/** "rus" / "RU" / "ru-RU" → "ru"; "und" / empty → null. */
export function normLang(l: string | null | undefined): string | null {
  if (!l) return null;
  const s = l.trim().toLowerCase().split(/[-_]/)[0]!;
  if (!s || s === "und" || s === "unk" || s === "mis" || s === "zxx") return null;
  return ISO3[s] ?? s;
}

export function langName(l: string | null | undefined): string | null {
  const n = normLang(l);
  if (!n) return null;
  return NAMES[n] ?? n.toUpperCase();
}

const CODEC: Record<string, string> = { aac: "AAC", ac3: "AC3", eac3: "E-AC3", dts: "DTS", truehd: "TrueHD", flac: "FLAC", mp3: "MP3", opus: "Opus", subrip: "SRT", ass: "ASS", webvtt: "VTT" };

function channels(c: number | null | undefined): string {
  if (!c) return "";
  return c === 6 ? " 5.1" : c === 8 ? " 7.1" : c === 2 ? " 2.0" : c === 1 ? " 1.0" : ` ${c}ch`;
}

export interface StreamLike {
  language?: string | null;
  title?: string | null;
  codec?: string | null;
  channels?: number | null;
}

/**
 * "Русский · LostFilm". Without a title the codec tells same-language tracks
 * apart ("English · AC3 5.1"). `engineLabel` (audioTracks[i].label) wins over
 * the ffprobe title when the engine has one.
 */
export function trackLabel(s: StreamLike, n: number, engineLabel?: string | null): string {
  const lang = langName(s.language);
  // Engines often label a track with just its language ("rus", "Russian"):
  // then the ffprobe title (the studio: LostFilm, MovieDalen…) is the name.
  const langOnly = (x: string) =>
    !!lang && (x.toLowerCase() === lang.toLowerCase() || normLang(x) === normLang(s.language) || langName(x) === lang);
  const engine = (engineLabel ?? "").trim();
  let title = engine && !langOnly(engine) ? engine : (s.title ?? "").trim();
  if (title && langOnly(title)) title = "";
  const parts: string[] = [];
  if (lang) parts.push(lang);
  if (title) parts.push(title);
  else if (s.codec) parts.push(`${CODEC[s.codec.toLowerCase()] ?? s.codec.toUpperCase()}${channels(s.channels)}`);
  return parts.length > 0 ? parts.join(" · ") : `#${n + 1}`;
}

export interface AudioCandidate {
  /** Everything that may name the studio: engine label, ffprobe title. */
  label: string;
  language: string | null;
}

/**
 * The audio track to select at start: the first preferred studio (in the
 * profile's order) found in a track's label/title, case-insensitive; else
 * the first track in the most preferred audio language; else null (keep the
 * file's default).
 */
export function pickPreferredAudio(tracks: readonly AudioCandidate[], prefs: { voiceovers?: readonly string[]; languages?: readonly string[] }): number | null {
  for (const studio of prefs.voiceovers ?? []) {
    const s = studio.trim().toLowerCase();
    if (!s) continue;
    const i = tracks.findIndex((t) => t.label.toLowerCase().includes(s));
    if (i >= 0) return i;
  }
  for (const lang of prefs.languages ?? []) {
    const l = normLang(lang);
    if (!l) continue;
    const i = tracks.findIndex((t) => normLang(t.language) === l);
    if (i >= 0) return i;
  }
  return null;
}

const VO_KIND: Record<string, string> = { dub: "Dub", mvo: "MVO", dvo: "DVO", avo: "AVO", vo: "VO", original: "Original" };

/** Release voice-over chip: "MVO · LostFilm" / "Dub" / "LostFilm". */
export function voiceoverLabel(v: { kind: string | null; studio: string | null; language?: string }): string | null {
  const kind = v.kind ? (VO_KIND[v.kind] ?? v.kind.toUpperCase()) : null;
  const studio = v.studio?.trim() || null;
  if (kind && studio) return `${kind} · ${studio}`;
  return kind ?? studio;
}
