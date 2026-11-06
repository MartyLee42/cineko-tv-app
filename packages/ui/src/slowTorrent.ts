// «Раздача качается медленнее, чем нужно»: the torrent's download speed stays
// below what the release needs to play (size × 8 / duration) for a while,
// during the first load or a rebuffer. Then waiting won't help much — the
// loading screen / rebuffer overlay offers another release (or waiting on).
// The judgement is pure; useSlowTorrent samples it once a second.
import { useEffect, useRef, useState } from "react";

/** How long the speed must stay too low before the hint shows. */
export const SLOW_TORRENT_HOLD_MS = 12_000;

export interface SlowTorrent {
  /** TorrServer's download speed, bytes/s. */
  speedBps: number;
  /** What the release needs, bytes/s. */
  needBps: number;
  seeders: number;
  peers: number;
}

interface Numbers {
  download_speed_bps: number;
  seeders: number;
  peers: number;
}

/**
 * When the speed first dropped below the need (kept while it stays below),
 * null when it's fast enough or unknown. `needBits`: bits/s.
 */
export function slowSince(prev: number | null, speedBps: number | null | undefined, needBits: number | null | undefined, now: number): number | null {
  if (speedBps == null || !needBits || needBits <= 0) return null;
  if (speedBps * 8 >= needBits) return null;
  return prev ?? now;
}

export function isSlowFor(since: number | null, now: number, holdMs = SLOW_TORRENT_HOLD_MS): boolean {
  return since !== null && now - since >= holdMs;
}

/**
 * The slow-torrent verdict for live numbers: sampled every second while
 * `active` (loading / rebuffering), null when it's fine, unknown or inactive.
 */
export function useSlowTorrent(torrent: Numbers | null | undefined, needBits: number | null | undefined, active: boolean, holdMs = SLOW_TORRENT_HOLD_MS): SlowTorrent | null {
  const latest = useRef({ torrent, needBits });
  useEffect(() => {
    latest.current = { torrent, needBits };
  });
  const [verdict, setVerdict] = useState<SlowTorrent | null>(null);
  useEffect(() => {
    if (!active) return;
    // A fresh window for every activation (a new load / another rebuffer).
    let since: number | null = null;
    const id = setInterval(() => {
      const now = Date.now();
      const { torrent: t, needBits: need } = latest.current;
      since = slowSince(since, t?.download_speed_bps, need, now);
      const slow = t && need && isSlowFor(since, now, holdMs) ? { speedBps: t.download_speed_bps, needBps: need / 8, seeders: t.seeders, peers: t.peers } : null;
      setVerdict((prev) =>
        prev === slow || (prev && slow && prev.speedBps === slow.speedBps && prev.needBps === slow.needBps && prev.seeders === slow.seeders && prev.peers === slow.peers) ? prev : slow,
      );
    }, 1000);
    return () => clearInterval(id);
  }, [active, holdMs]);
  return active ? verdict : null;
}
