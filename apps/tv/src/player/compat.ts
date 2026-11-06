// Compatible audio on the TV («Совместимый звук (AAC)»): the server remuxes
// the torrent file to fragmented MP4 and converts one audio track to AAC
// (PlaybackSource.compat_url, see docs «Browser compatibility stream»). The
// video is copied (HEVC stays HEVC) — except old codecs this TV can't decode
// (XviD / DivX, MPEG-2, VC-1 ≤ 1080p: PlaybackSource.compat_video), which
// the server re-encodes to H.264 (video=h264). Pure helpers; the controller
// wires them.
//
// Timeline: compat.mp4?start=S begins at the keyframe K ≤ S (HEAD answers
// X-Stream-Start: K). <video> counts from 0 at K, so the shown time is
// K + currentTime; the length comes from media_info. The stream has no
// Range support, so seeks outside the buffer restart it with a new start.
import type { MediaInfo, PlaybackSource } from "@martytv/contracts";
import { storage } from "../platform";
import { assessSource, codecKey, videoUndecodable, type Probe, type Support } from "./codecs";

// ---------------------------------------------------------------- preference

export type CompatPref = "auto" | "on" | "off";
const PREF_KEY = "martytv.tv_compat";

/** The panel choice on this TV (per device, localStorage). */
export const compatPrefStore = {
  get(): CompatPref {
    const v = storage.get(PREF_KEY);
    return v === "on" || v === "off" ? v : "auto";
  },
  set(v: CompatPref) {
    if (v === "auto") storage.remove(PREF_KEY);
    else storage.set(PREF_KEY, v);
  },
};

/** MP4 + H.264 High + AAC-LC: the pair old engines are most likely to play. */
export const COMPAT_TYPE = 'video/mp4; codecs="avc1.640028, mp4a.40.2"';

/** Whether this engine can play the compat stream (fMP4 with AAC). */
export function canPlayCompat(probe: Probe): boolean {
  try {
    if (probe.canPlayType(COMPAT_TYPE) !== "") return true;
    if (probe.canPlayType('audio/mp4; codecs="mp4a.40.2"') !== "" && probe.canPlayType("video/mp4") !== "") return true;
  } catch {
    // some engines throw on unknown types
  }
  return false;
}

/** Whether the main audio of the source is known-undecodable here (codecs.ts verdict). */
export function audioUndecodable(support: Support | null | undefined): boolean {
  return !!support?.parts.some((p) => p.kind === "audio" && p.ok === false);
}

/**
 * The server should re-encode the video (video=h264): this TV can't decode
 * it (codecs.ts verdict) and the server can convert it (compat_video).
 */
export function videoConvertNeeded(src: Pick<PlaybackSource, "compat_video"> | null | undefined, support: Support | null | undefined): boolean {
  return !!src?.compat_video && videoUndecodable(support);
}

/**
 * Start (or switch to) compat mode? Needs a compat URL and an engine that
 * plays MP4/AAC. The TV's choice wins (on/off); "auto" uses compat when the
 * audio can't be decoded (codec probe, the no-sound detector, or a track the
 * user picked that the engine can't switch to / decode), or when the video
 * can't be decoded but the server converts it (videoBad).
 */
export function wantCompat(o: {
  compatUrl: string | null | undefined;
  pref: CompatPref;
  canPlay: boolean;
  audioBad: boolean;
  noSound?: boolean;
  videoBad?: boolean;
}): boolean {
  if (!o.compatUrl || !o.canPlay) return false;
  if (o.pref === "on") return true;
  if (o.pref === "off") return false;
  return o.audioBad || !!o.noSound || !!o.videoBad;
}

/**
 * The first load of a torrent source: «compat» when the file's main audio
 * can't be decoded here (or the TV is set to always convert), «wait_info»
 * when that's unknown yet (no media_info: the server's ffprobe hasn't run —
 * the first play of a file) but a compat stream could be needed, else
 * «original». Only the source and this engine's probe decide: the remembered
 * «server has compat» flag (compatServer) feeds ranking and the device
 * report, never this.
 */
export function compatPlan(
  src: Parameters<typeof assessSource>[0] & Pick<PlaybackSource, "compat_url" | "kind" | "compat_video">,
  probe: Probe,
  pref: CompatPref,
): "compat" | "original" | "wait_info" {
  const compatUrl = compatUrlOf(src);
  const canPlay = canPlayCompat(probe);
  const support = assessSource(src, probe);
  const audioBad = audioUndecodable(support);
  const videoBad = videoConvertNeeded(src, support);
  if (wantCompat({ compatUrl, pref, canPlay, audioBad, videoBad })) return "compat";
  if (compatUrl && canPlay && pref === "auto" && !src.media_info) return "wait_info";
  return "original";
}

// ---------------------------------------------------------------- tracks

type Stream = MediaInfo["audio"][number];

/** Track id `a<i>` (position in media_info.audio) → ffprobe stream index for `audio=`. */
export function audioIndexOf(info: MediaInfo | null | undefined, id: string | null | undefined): number | null {
  const m = /^a(\d+)$/.exec(id ?? "");
  if (!m || !info) return null;
  return info.audio[Number(m[1])]?.index ?? null;
}

/** ffprobe stream index → track id `a<i>` (null when not an audio stream). */
export function trackIdOf(info: MediaInfo | null | undefined, index: number | null | undefined): string | null {
  if (!info || index == null) return null;
  const i = info.audio.findIndex((a) => a.index === index);
  return i < 0 ? null : `a${i}`;
}

/** The file's main audio (default, else first). */
export function mainAudio(info: MediaInfo | null | undefined): Stream | null {
  if (!info || info.audio.length === 0) return null;
  return info.audio.find((a) => a.default) ?? info.audio[0]!;
}

const ISO3: Record<string, string> = { rus: "ru", eng: "en", ukr: "uk", bel: "be", ger: "de", deu: "de", fre: "fr", fra: "fr", spa: "es", ita: "it", jpn: "ja" };
const norm = (l: string | null | undefined) => {
  const s = (l ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return !s || s === "und" ? null : (ISO3[s] ?? s);
};

/**
 * The compat audio stream index: the first preferred voice-over studio in a
 * track title (profile order), else the first track in a preferred
 * language, else the default, else the first.
 */
export function pickCompatAudio(info: MediaInfo | null | undefined, prefs: { voiceovers?: readonly string[] | null; languages?: readonly string[] | null } = {}): number | null {
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
  return mainAudio(info)!.index;
}

const LABEL: Record<string, string> = { ac3: "AC3", eac3: "E-AC3", dts: "DTS", truehd: "TrueHD", flac: "FLAC", aac: "AAC", mp3: "MP3", opus: "Opus", pcm: "PCM", vorbis: "Vorbis" };

/** «AC3» for the stats line «AAC (из AC3)»; null when the track is AAC already. */
export function sourceCodecLabel(info: MediaInfo | null | undefined, index: number | null): string | null {
  const s = info?.audio.find((a) => a.index === index);
  if (!s) return null;
  const k = codecKey(s.codec);
  if (!k || k === "aac") return null;
  return LABEL[k] ?? k.toUpperCase();
}

// ---------------------------------------------------------------- URLs / timeline

const sec = (n: number) => Math.max(0, Math.round(n * 1000) / 1000);

/** compat.mp4 with the audio stream index and start (seconds); `video`: re-encode the video to H.264. */
export function compatSrc(compatUrl: string, o: { audio: number | null; start: number; video?: boolean }): string {
  const q: string[] = [];
  if (o.audio != null) q.push(`audio=${o.audio}`);
  if (o.start > 0) q.push(`start=${sec(o.start)}`);
  if (o.video) q.push("video=h264");
  if (!q.length) return compatUrl;
  return `${compatUrl}${compatUrl.includes("?") ? "&" : "?"}${q.join("&")}`;
}

/** Parses X-Stream-Start against the requested start (keyframe ≤ start, sane). */
export function parseStreamStart(header: string | null | undefined, requested: number): number {
  const v = Number(header);
  if (header != null && header !== "" && Number.isFinite(v) && v >= 0 && v <= requested + 60) return v;
  return requested;
}

/**
 * HEAD compat.mp4?start=… → where that stream really starts. XHR (old TV
 * engines may lack fetch); any failure falls back to the requested time.
 */
export function fetchStreamStart(url: string, requested: number, timeoutMs = 8000): Promise<number> {
  if (requested <= 0) return Promise.resolve(0);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: number) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("HEAD", url, true);
      xhr.timeout = timeoutMs;
      xhr.onload = () => finish(xhr.status >= 200 && xhr.status < 300 ? parseStreamStart(xhr.getResponseHeader("X-Stream-Start"), requested) : requested);
      xhr.onerror = () => finish(requested);
      xhr.ontimeout = () => finish(requested);
      xhr.send();
    } catch {
      finish(requested);
    }
  });
}

/** Absolute (shown) time from the stream offset and the element's time. */
export function absTime(offset: number, currentTime: number): number {
  return offset + (Number.isFinite(currentTime) ? currentTime : 0);
}

/** A seek in compat mode: within the buffer (relative time) or a restart at the absolute target. */
export function compatSeek(to: number, offset: number, ranges: readonly [number, number][]): { kind: "local"; at: number } | { kind: "reload"; at: number } {
  const rel = to - offset;
  const ok = rel >= 0 && ranges.some(([a, b]) => rel >= a - 0.05 && rel <= b - 0.5);
  return ok ? { kind: "local", at: rel } : { kind: "reload", at: Math.max(0, to) };
}

/** <video>.buffered as pairs. */
export function rangesOf(v: { buffered?: TimeRanges } | null | undefined): [number, number][] {
  const out: [number, number][] = [];
  const b = v?.buffered;
  if (!b) return out;
  try {
    for (let i = 0; i < b.length; i++) out.push([b.start(i), b.end(i)]);
  } catch {
    // detached
  }
  return out;
}

/** Torrent sources only (online/iptv/video have no compat stream). */
export function compatUrlOf(src: Pick<PlaybackSource, "compat_url" | "kind"> | null | undefined): string | null {
  if (!src || (src.kind && src.kind !== "torrent")) return null;
  return src.compat_url || null;
}

// ---------------------------------------------------------------- server hint

const SERVER_KEY = "martytv.tv_compat_server";

/**
 * Whether this server offers compat streams, remembered from the last ready
 * torrent source (release lists are ranked before any source exists).
 */
export const compatServer = {
  get(): boolean {
    return storage.get(SERVER_KEY) === "1";
  },
  note(s: Pick<PlaybackSource, "status" | "kind" | "compat_url"> | null | undefined) {
    if (!s || s.status !== "ready" || (s.kind ?? "torrent") !== "torrent") return;
    storage.set(SERVER_KEY, s.compat_url ? "1" : "0");
  },
};
