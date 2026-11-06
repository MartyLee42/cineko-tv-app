// What a loading screen says while a stream starts (TV loader, web loader,
// the phone's «На ТВ» toast): the stage line and the live torrent numbers.
// Pure: callers translate the keys and pass their own formatters.
import type { MessageKey } from "./i18n";

export type LoadStatusStage = "resolving" | "searching" | "creating" | "metadata" | "preloading" | "starting" | "rebuffering" | "done";

/** PlaybackSource.torrent / PlaybackLoading numbers (optional fields may be absent on older servers). */
export interface LoadTorrent {
  peers: number;
  seeders: number;
  download_speed_bps: number;
  preloaded_bytes: number;
  total_peers?: number | null;
  preload_size?: number | null;
}

export interface LoadStatusInput {
  stage: LoadStatusStage;
  torrent: LoadTorrent | null | undefined;
  /** Bytes the client wants buffered before it starts (used when TorrServer reports no preload target). */
  target?: number | null;
  /** The server converts the audio / video for this device (compat stream starting). */
  compat?: "audio" | "video" | null;
  /** Online / IPTV / video: no torrent numbers to wait for. */
  online?: boolean;
}

export interface LoadLine {
  id: "status" | "peers" | "speed" | "buffer";
  key: MessageKey;
  vars: Record<string, string | number>;
}

export interface LoadFormat {
  bytes: (n: number) => string;
  speed: (bps: number) => string;
}

/** The buffer goal: TorrServer's preload size when it reports one, else the caller's target. */
function goal(t: LoadTorrent, target: number | null | undefined): number {
  return t.preload_size && t.preload_size > 0 ? t.preload_size : target && target > 0 ? target : 0;
}

/** «Буферизация 12 МБ из 20» while the preload fills (null when there's nothing to show). */
function bufferingLine(t: LoadTorrent | null | undefined, target: number | null | undefined, f: LoadFormat): LoadLine | null {
  if (!t || t.preloaded_bytes <= 0) return null;
  const of = goal(t, target);
  if (of > 0 && t.preloaded_bytes < of) {
    return { id: "status", key: "load.buffering_of", vars: { got: f.bytes(t.preloaded_bytes), of: f.bytes(of) } };
  }
  return null;
}

/** The status line for a stage. */
export function loadStatusLine(i: LoadStatusInput, f: LoadFormat): LoadLine {
  const t = i.torrent;
  const noPeers = !i.online && !!t && t.peers === 0;
  const line = (key: MessageKey, vars: Record<string, string | number> = {}): LoadLine => ({ id: "status", key, vars });
  switch (i.stage) {
    case "resolving":
      return line("load.resolving");
    case "searching":
      return line("load.searching");
    case "creating":
      return line(i.online ? "load.creating_online" : "load.creating");
    case "metadata":
      return line(noPeers ? "load.connecting" : "load.metadata");
    case "preloading":
      return bufferingLine(t, i.target, f) ?? line(noPeers ? "load.connecting" : "load.buffering");
    case "rebuffering":
      return line("load.buffering");
    case "starting":
      if (i.compat) return line(i.compat === "video" ? "load.converting_video" : "load.converting_audio");
      if (noPeers) return line("load.connecting");
      return bufferingLine(t, i.target, f) ?? line("load.starting");
    default:
      return line("load.starting");
  }
}

/**
 * The live numbers under the status: peers (of known) · seeders, speed, the
 * buffered amount. Before TorrServer reports anything on a torrent that is
 * still fetching, «Ищем пиров…» so the line is never empty.
 */
export function loadStatsLines(i: LoadStatusInput, f: LoadFormat): LoadLine[] {
  if (i.online || i.stage === "done" || i.stage === "resolving" || i.stage === "searching") return [];
  const t = i.torrent;
  if (!t) return i.stage === "metadata" || i.stage === "preloading" ? [{ id: "peers", key: "load.peers_wait", vars: {} }] : [];
  const out: LoadLine[] = [];
  const total = t.total_peers ?? 0;
  out.push(
    total > t.peers
      ? { id: "peers", key: "load.peers_of", vars: { peers: t.peers, total, seeders: t.seeders } }
      : { id: "peers", key: "load.peers", vars: { peers: t.peers, seeders: t.seeders } },
  );
  out.push({ id: "speed", key: "load.speed", vars: { speed: f.speed(t.download_speed_bps) } });
  // Not repeated when the status already says «Буферизация X из Y».
  if (t.preloaded_bytes > 0 && !bufferingLine(t, i.target, f)) out.push({ id: "buffer", key: "load.buffered", vars: { size: f.bytes(t.preloaded_bytes) } });
  return out;
}

/** Both at once. */
export function loadStatus(i: LoadStatusInput, f: LoadFormat): { status: LoadLine; stats: LoadLine[] } {
  return { status: loadStatusLine(i, f), stats: loadStatsLines(i, f) };
}
