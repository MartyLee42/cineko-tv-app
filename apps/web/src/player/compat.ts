// Browser compatibility mode («Совместимый режим»): the server remuxes the
// torrent file to fragmented MP4 and converts one audio track to AAC
// (PlaybackSource.compat_url). Pure helpers here; the player wires them up.
//
// Timeline: the stream for `start=S` begins at the keyframe K ≤ S, reported
// by the server (HEAD → X-Stream-Start). The <video> element counts from 0
// at K, so absolute time = K + currentTime. Seeking outside what is buffered
// reloads the stream with a new start; switching audio does the same.
import type { MediaInfo, PlaybackSource } from "@martytv/contracts";

type MediaStream = MediaInfo["audio"][number];

// ---------------------------------------------------------------- preference

const PREF_KEY = "martytv.compat";
const SERVER_KEY = "martytv.compat_server";

export type CompatPref = "on" | "off" | null;

/** The user's choice in this browser: always on, always off, or automatic (null). */
export function readCompatPref(): CompatPref {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === "on" || v === "off" ? v : null;
  } catch {
    return null;
  }
}

export function writeCompatPref(v: CompatPref): void {
  try {
    if (v) localStorage.setItem(PREF_KEY, v);
    else localStorage.removeItem(PREF_KEY);
  } catch {
    // private mode
  }
}

/**
 * Whether this server offers compat streams, remembered from the last ready
 * torrent source (release lists are judged before any source exists).
 */
export function compatServerHint(): boolean {
  try {
    return localStorage.getItem(SERVER_KEY) === "1";
  } catch {
    return false;
  }
}

export function noteCompatServer(s: Pick<PlaybackSource, "status" | "kind" | "compat_url"> | null | undefined): void {
  if (!s || s.status !== "ready" || (s.kind ?? "torrent") !== "torrent") return;
  try {
    localStorage.setItem(SERVER_KEY, s.compat_url ? "1" : "0");
  } catch {
    // private mode
  }
}

// ---------------------------------------------------------------- when

/** Reason codes compat mode fixes: undecodable audio and containers (MKV on Safari, TS…). */
const FIXABLE = new Set(["no_audio", "container", "container_maybe"]);

interface SupportLike {
  verdict: "playable" | "maybe" | "unlikely";
  noAudio: boolean;
  reasons: readonly { code: string; severity: "info" | "maybe" | "unlikely" }[];
}

/** Compat mode would make this play (with sound): something is wrong and everything wrong is fixable. */
export function compatFixes(s: SupportLike): boolean {
  const problems = s.reasons.filter((r) => r.severity !== "info");
  return problems.length > 0 && problems.every((r) => FIXABLE.has(r.code));
}

/**
 * Start in compat mode? Needs a compat URL; the user's explicit choice wins;
 * otherwise only when the support check expects no sound / an unplayable
 * container that compat fixes.
 */
export function wantCompat(o: { compatUrl: string | null | undefined; pref: CompatPref; support: SupportLike | null }): boolean {
  if (!o.compatUrl) return false;
  if (o.pref === "on") return true;
  if (o.pref === "off") return false;
  return !!o.support && compatFixes(o.support);
}

// ---------------------------------------------------------------- flavour

/**
 * Which compat stream this browser gets. compat.mp4 is a progressive MP4
 * without byte ranges, which Safari / every iOS & iPadOS browser
 * (AVFoundation) won't play; they get the HLS variant (compat.m3u8: fMP4
 * segments with Range) through their native HLS. Everyone else: compat.mp4.
 */
export type CompatFormat = "hls" | "mp4";

export function compatFormat(env: { engine: string; ios: boolean }, probe: { canPlayType(type: string): string }): CompatFormat {
  if (env.ios) return "hls"; // all iOS / iPadOS engines are WebKit with native HLS (incl. WKWebViews like MSX)
  if (env.engine !== "safari") return "mp4";
  try {
    return probe.canPlayType("application/vnd.apple.mpegurl") !== "" ? "hls" : "mp4";
  } catch {
    return "mp4";
  }
}

/** The HLS variant's URL (compat_url names compat.mp4). */
export function compatHlsUrl(compatUrl: string): string {
  return compatUrl.replace(/compat\.mp4(?=$|\?)/, "compat.m3u8");
}

/**
 * HLS compat: the transcoder keeps ~10 min of segments behind the player
 * and generates up to ~3 min ahead (services/transcoder/hls.go). Seeks
 * inside [current − 5 min, end of the seekable range] stay in the session;
 * anything else restarts it at the target.
 */
export const HLS_KEEP_BACK = 300;

/** The HLS seekable ranges (relative) a local seek may use. */
export function hlsLocalRanges(seekable: readonly [number, number][], current: number, keepBack = HLS_KEEP_BACK): [number, number][] {
  const from = Math.max(0, current - keepBack);
  return seekable.filter(([, b]) => b > from).map(([a, b]): [number, number] => [Math.max(a, from), b]);
}

/**
 * A paused HLS session is dropped by the transcoder after 10 min without
 * segment requests: resuming after this long restarts it at the position.
 */
export const HLS_RESUME_RELOAD_MS = 8 * 60_000;

// ---------------------------------------------------------------- URLs

function withQuery(url: string, q: Record<string, string | number | null | undefined>): string {
  const parts = Object.entries(q)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  if (!parts.length) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${parts.join("&")}`;
}

const sec = (n: number) => Math.max(0, Math.round(n * 1000) / 1000);

/** compat.mp4 (or compat.m3u8 with format "hls") with the audio track (stream index) and start. */
export function compatSrc(compatUrl: string, o: { audio: number | null; start: number; format?: CompatFormat }): string {
  const base = o.format === "hls" ? compatHlsUrl(compatUrl) : compatUrl;
  return withQuery(base, { audio: o.audio, start: o.start > 0 ? sec(o.start) : null });
}

/** WebVTT of a text subtitle stream, timed like the compat stream at `start`. */
export function subsSrc(compatUrl: string, index: number, start: number, burst: number): string {
  const base = compatUrl.replace(/compat\.mp4(\?.*)?$/, `subs/${index}.vtt`);
  return withQuery(base, { start: start > 0 ? sec(start) : null, burst: burst > 0 ? Math.ceil(burst) : null });
}

/** HEAD compat.mp4?start=… → where that stream would really start (X-Stream-Start). */
export async function fetchStreamStart(url: string, requested: number, f: typeof fetch = fetch): Promise<number> {
  if (requested <= 0) return 0;
  try {
    const r = await f(url, { method: "HEAD", cache: "no-store", credentials: "omit" });
    const v = Number(r.headers.get("X-Stream-Start"));
    if (r.ok && Number.isFinite(v) && v >= 0 && v <= requested + 60) return v;
  } catch {
    // network: fall back to the requested time
  }
  return requested;
}

// ---------------------------------------------------------------- tracks

const TEXT_SUBS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text", "microdvd"]);

/** Subtitle streams the server can serve as WebVTT (no PGS/VOBSUB). */
export function textSubtitles(info: MediaInfo | null | undefined): MediaStream[] {
  return (info?.subtitles ?? []).filter((s) => TEXT_SUBS.has(s.codec.toLowerCase()));
}

/** ISO 639-2 → 639-1 for the languages users pick. */
const ISO3: Record<string, string> = {
  rus: "ru", eng: "en", ukr: "uk", bel: "be", ger: "de", deu: "de", fre: "fr", fra: "fr", spa: "es", ita: "it", jpn: "ja", kor: "ko", chi: "zh", zho: "zh",
};
const norm = (l: string | null | undefined) => {
  const s = (l ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return !s || s === "und" ? null : (ISO3[s] ?? s);
};

/**
 * The compat audio track (global stream index): the first preferred
 * voice-over studio found in a track title (profile order), else the first
 * track in a preferred language, else the file's default, else the first.
 */
export function pickCompatAudio(
  info: MediaInfo | null | undefined,
  prefs: { voiceovers?: readonly string[] | null; languages?: readonly string[] | null } = {},
): number | null {
  const audio = info?.audio ?? [];
  if (!audio.length) return null;
  for (const studio of prefs.voiceovers ?? []) {
    const s = studio.trim().toLowerCase();
    if (!s) continue;
    const hit = audio.find((a) => (a.title ?? "").toLowerCase().includes(s));
    if (hit) return hit.index;
  }
  for (const lang of prefs.languages ?? []) {
    const l = norm(lang);
    const hit = l ? audio.find((a) => norm(a.language) === l) : undefined;
    if (hit) return hit.index;
  }
  return (audio.find((a) => a.default) ?? audio[0]!).index;
}

// ---------------------------------------------------------------- seeking

/** Is relative time `t` playable from what's buffered (a small margin at the end)? */
export function inBuffered(t: number, ranges: readonly [number, number][], margin = 0.5): boolean {
  return t >= 0 && ranges.some(([a, b]) => t >= a - 0.05 && t <= b - margin);
}

/**
 * A seek to absolute `to` with the stream starting at `offset`: move within
 * the buffer when possible, else restart the stream at `to`.
 */
export function compatSeek(to: number, offset: number, ranges: readonly [number, number][]): { kind: "local"; at: number } | { kind: "reload"; at: number } {
  const rel = to - offset;
  return inBuffered(rel, ranges) ? { kind: "local", at: rel } : { kind: "reload", at: Math.max(0, to) };
}

/**
 * Status of a compat URL after a media error (503 = all conversion slots
 * busy). A GET (HEAD only probes keyframes), aborted once headers arrive.
 * HLS: HEAD (a GET would start another conversion; 403 is what matters).
 */
export async function compatStatus(url: string, f: typeof fetch = fetch, method: "GET" | "HEAD" = "GET"): Promise<number> {
  const ac = new AbortController();
  try {
    const r = await f(url, { method, signal: ac.signal, cache: "no-store", credentials: "omit" });
    ac.abort();
    return r.status;
  } catch {
    return 0;
  }
}
