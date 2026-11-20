// The stats panel under Up (buffer, peers, server load, link to the TV) and the
// «Показывать буфер» option. Pure: the player renders what this returns.
import type { MessageKey } from "@martytv/ui";

export interface NetStatsInput {
  /** Source kind (absent = torrent). */
  kind?: string;
  /** Live TorrServer numbers (null: not a torrent, or TorrServer didn't answer). */
  torrent: { peers: number; seeders: number; download_speed_bps: number } | null;
  /** The file plays from the server's own copy (a finished server download). */
  local: boolean;
  cpu: number | null | undefined;
  streams: number | null | undefined;
  /** Server → this TV: this session's estimate (measured) or the TV's usual rate. */
  device: { bps: number; measured: boolean } | null;
  /** Dropped frames of steady playback so far (smooth.ts), null when the engine doesn't count. */
  frames?: { pct: number } | null;
  /** Loaded ahead on this TV (seconds) and, for torrents, TorrServer's own preload (bytes); null when unknown. */
  buffer?: { ahead: number; preloaded: number } | null;
}

export interface StatItem {
  id: "buffer" | "peers" | "from_peers" | "local" | "server" | "device" | "frames";
  key: MessageKey;
  vars: Record<string, string | number>;
}

/** The panel's items; parts that don't apply are left out. `speed` formats bytes/s. */
export function netStats(
  i: NetStatsInput,
  speed: (bps: number) => string,
  mbit: (bps: number) => string,
  bytes: (n: number) => string = String,
): StatItem[] {
  const out: StatItem[] = [];
  const torrent = !i.kind || i.kind === "torrent";
  // «Буфер 42 с · TorrServer 120 МБ»: first, it's what answers "will it stall?".
  if (i.buffer) {
    const ahead = Math.floor(i.buffer.ahead);
    out.push(
      torrent && !i.local && i.buffer.preloaded > 0
        ? { id: "buffer", key: "pstats.buffer_torrent", vars: { ahead, size: bytes(i.buffer.preloaded) } }
        : { id: "buffer", key: "pstats.buffer", vars: { ahead } },
    );
  }
  if (torrent && i.local) out.push({ id: "local", key: "pstats.local", vars: {} });
  else if (torrent && i.torrent) {
    out.push({ id: "peers", key: "pstats.peers", vars: { peers: i.torrent.peers, seeders: i.torrent.seeders } });
    out.push({ id: "from_peers", key: "pstats.from_peers", vars: { speed: speed(i.torrent.download_speed_bps) } });
  }
  if (i.cpu != null) out.push({ id: "server", key: "pstats.server", vars: { cpu: Math.round(i.cpu), streams: i.streams ?? 0 } });
  else if (i.streams != null) out.push({ id: "server", key: "pstats.server_streams", vars: { streams: i.streams } });
  if (i.device && i.device.bps > 0) out.push({ id: "device", key: i.device.measured ? "pstats.device" : "pstats.device_usual", vars: { rate: mbit(i.device.bps) } });
  // Only once something drops (a clean 0 % chip is noise).
  if (i.frames && i.frames.pct >= 0.5) out.push({ id: "frames", key: "smooth.frames", vars: { pct: i.frames.pct < 10 ? i.frames.pct.toFixed(1) : Math.round(i.frames.pct) } });
  return out;
}

/** Where the buffered-ahead stripe ends on the progress bar (%), or null. */
export function bufferStripe(position: number, ahead: number | null, duration: number | null | undefined): number | null {
  if (ahead === null || !duration || duration <= 0) return null;
  return Math.max(0, Math.min(100, ((position + ahead) / duration) * 100));
}
