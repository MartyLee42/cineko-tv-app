// Live TV (IPTV) playback decisions shared by the PWA and the TV app: which
// engines to try for a channel and in what order, whether the browser can
// decode its codecs, and what a failure means for the viewer.

/** How a live stream_url is played. */
export type LiveEngine = "native" | "hlsjs" | "mpegts";

/** Why a channel doesn't play (each has its own message). */
export type LiveFailure = "geo" | "offline" | "timeout" | "format" | "codec" | "broken";

export interface LiveProbe {
  canPlayType(type: string): string;
}

const playable = (p: LiveProbe | null | undefined, type: string) => {
  try {
    const r = p?.canPlayType(type) ?? "";
    return r === "maybe" || r === "probably";
  } catch {
    return false;
  }
};

/**
 * The engines to try for a live source, in order. HLS: native first where
 * the engine plays HLS itself (Samsung/LG/Safari; not when preferMse —
 * Android), then hls.js over MSE. MPEG-TS: native where <video> plays
 * video/mp2t (most TVs), then mpegts.js over MSE (desktop browsers:
 * src=stream.ts ended in DEMUXER_ERROR_COULD_NOT_PARSE). A failing engine
 * falls through to the next.
 */
export function liveEngines(format: string | null | undefined, probe: LiveProbe | null | undefined, mse: boolean, preferMse = false): LiveEngine[] {
  const out: LiveEngine[] = [];
  if (format === "ts") {
    if (playable(probe, "video/mp2t")) out.push("native");
    if (mse) out.push("mpegts");
    return out;
  }
  const native = playable(probe, "application/vnd.apple.mpegurl") || playable(probe, "application/x-mpegURL");
  if (native && !(preferMse && mse)) out.push("native");
  if (mse) out.push("hlsjs");
  if (native && !out.includes("native")) out.push("native");
  return out;
}

/** MSE type strings for the codecs a health check reports. */
const MSE_TYPES: Record<string, string> = {
  hevc: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
  ac3: 'audio/mp4; codecs="ac-3"',
  eac3: 'audio/mp4; codecs="ec-3"',
};

/**
 * The codec this browser can't decode (MPEG-2 video never plays through
 * MSE; HEVC / AC-3 / E-AC-3 depend on the browser), or null. Native
 * playback (TVs) is not judged: their decoders usually cope.
 */
export function liveCodecProblem(
  src: { video_codec?: string | null; audio_codec?: string | null },
  isTypeSupported: ((type: string) => boolean) | null,
): string | null {
  const check = (c: string | null | undefined) => {
    if (!c) return null;
    if (c === "mpeg2") return c;
    const t = MSE_TYPES[c];
    if (!t) return null;
    try {
      return isTypeSupported && isTypeSupported(t) ? null : c;
    } catch {
      return c;
    }
  };
  return check(src.video_codec) ?? check(src.audio_codec);
}

/** MediaSource.isTypeSupported of this window, or null without MSE. */
export function mseTypeSupported(w: unknown = typeof window !== "undefined" ? window : undefined): ((t: string) => boolean) | null {
  const g = w as { MediaSource?: { isTypeSupported?(t: string): boolean }; ManagedMediaSource?: { isTypeSupported?(t: string): boolean } } | undefined;
  const ms = g?.MediaSource ?? g?.ManagedMediaSource;
  return ms?.isTypeSupported ? (t: string) => !!ms.isTypeSupported!(t) : null;
}

/** Maps a POST /playback/sources error code (kind iptv) to a failure. */
export function liveFailureFromCode(code: string | null | undefined): LiveFailure {
  switch (code) {
    case "channel_geo_blocked":
      return "geo";
    case "channel_timeout":
      return "timeout";
    case "channel_format_unsupported":
      return "format";
    case "channel_unavailable":
    case "not_found":
      return "offline";
  }
  return "broken";
}

/** The code of an ApiError (@martytv/contracts), if e is one. */
export function apiErrorCode(e: unknown): string | null {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? code : null;
}

/** Channels that work vs the «Нерабочие» ones (offline: dead/geo or failing). */
export function splitBroken<T extends { offline: boolean }>(items: readonly T[]): { working: T[]; broken: T[] } {
  const working: T[] = [];
  const broken: T[] = [];
  for (const c of items) (c.offline ? broken : working).push(c);
  return { working, broken };
}

/** The «Нерабочие» chip id (channels with offline = true). */
export const BROKEN_GROUP = "broken";

/**
 * Server groups recounted over the working channels only (broken ones sit
 * behind the «Нерабочие» chip); groups left empty are dropped.
 */
export function workingGroups<G extends { id: string; count: number }>(groups: readonly G[], items: readonly { group_id: string; offline: boolean }[]): G[] {
  const n = new Map<string, number>();
  for (const c of items) if (!c.offline) n.set(c.group_id, (n.get(c.group_id) ?? 0) + 1);
  return groups.map((g) => ({ ...g, count: n.get(g.id) ?? 0 })).filter((g) => g.count > 0);
}

/** The label of an offline channel: why it doesn't work, when the health check knows. */
export function offlineLabel(c: { health?: string | null }): "iptvplay.health.geo" | "iptvplay.health.dead" | "iptvplay.health.timeout" | "iptv.offline" {
  switch (c.health) {
    case "geo":
      return "iptvplay.health.geo";
    case "dead":
      return "iptvplay.health.dead";
    case "timeout":
      return "iptvplay.health.timeout";
  }
  return "iptv.offline";
}
