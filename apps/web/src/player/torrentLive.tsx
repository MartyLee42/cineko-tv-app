// Live torrent numbers for the in-browser player's loader and rebuffer
// overlay, and the «Раздача качается медленнее, чем нужно» hint. The page's
// source query stops polling once the source is ready — but the real loading
// (and every rebuffer) happens after that, so these poll on their own.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { unwrap, type PlaybackSource } from "@martytv/contracts";
import { releaseBitrate } from "@martytv/media-types";
import { loadStatsLines, useI18n, useSlowTorrent, type SlowTorrent } from "@martytv/ui";
import { api } from "../api";
import { formatSize, formatSpeed } from "../play/releases";

/** A torrent source still fetched from peers (not online, not a finished server download). */
export function isTorrentSource(src: PlaybackSource | null | undefined): src is PlaybackSource {
  return !!src && (src.kind ?? "torrent") === "torrent" && src.download?.status !== "done";
}

/** What the release needs to play without stalls, bits/s. */
export function needBits(src: PlaybackSource | null | undefined): number | null {
  if (!src) return null;
  const size = src.file?.size_bytes ?? src.release?.size_bytes ?? null;
  const dur = src.media_info?.duration_seconds ?? src.duration_seconds ?? null;
  return releaseBitrate(size, dur) ?? src.release?.est_bitrate_bps ?? null;
}

/** PlaybackSource.torrent refreshed every 2 s while `active` (falls back to the source's own snapshot). */
export function useLiveTorrent(source: PlaybackSource | null | undefined, active: boolean): PlaybackSource["torrent"] | null {
  const id = isTorrentSource(source) ? source.id : null;
  const q = useQuery({
    queryKey: ["source-live", id],
    queryFn: () => unwrap(api.GET("/playback/sources/{id}", { params: { path: { id: id! } } })),
    enabled: !!id && active,
    refetchInterval: active ? 2000 : false,
    staleTime: 1000,
    retry: false,
  });
  if (!id) return null;
  return (active && q.data?.torrent) || source?.torrent || null;
}

/**
 * The slow-torrent verdict for a source while `active` (loading / rebuffering),
 * with «Подождать» (dismissed until `resetKey` changes).
 */
export function useSlowSource(source: PlaybackSource | null | undefined, torrent: PlaybackSource["torrent"] | null, active: boolean, resetKey: string) {
  const [waited, setWaited] = useState<string | null>(null);
  const slow = useSlowTorrent(torrent, needBits(source), active && isTorrentSource(source) && waited !== resetKey);
  return { slow, wait: () => setWaited(resetKey) };
}

/** «Пиров 14 из 80 · сидов 9 · ↓ 2,4 МБ/с · Загружено 30 МБ» under «Буферизация…». */
export function RebufferTorrentLine({ source }: { source: PlaybackSource }) {
  const { t, locale } = useI18n();
  const tor = useLiveTorrent(source, true);
  if (!tor || !isTorrentSource(source)) return null;
  const lines = loadStatsLines({ stage: "rebuffering", torrent: tor }, { bytes: (n) => formatSize(n, locale), speed: (b) => formatSpeed(b, locale) });
  return (
    <span className="block text-xs text-white/70" data-testid="player-rebuffer-torrent">
      {lines.map((l) => t(l.key, l.vars)).join(" · ")}
    </span>
  );
}

/** «Раздача качается медленнее, чем нужно (0,4 из 0,6 МБ/с, 1 сид)» + «Другая раздача» / «Подождать». */
export function SlowTorrentBanner({ slow, onAnother, onWait }: { slow: SlowTorrent; onAnother?: () => void; onWait: () => void }) {
  const { t, locale } = useI18n();
  return (
    <div
      role="status"
      data-testid="slow-torrent"
      className="pointer-events-auto flex w-full max-w-lg flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-white/10 bg-neutral-900/95 px-4 py-2.5 text-left text-sm text-white shadow-2xl backdrop-blur"
    >
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">
          {t("load.slow", { speed: formatSpeed(slow.speedBps, locale), need: formatSpeed(slow.needBps, locale), seeders: slow.seeders })}
        </span>
        <span className="block text-xs text-white/70">{t("load.slow_hint")}</span>
      </span>
      <span className="flex gap-1">
        {onAnother && (
          <button type="button" data-testid="slow-torrent-another" onClick={onAnother} className="min-h-[36px] rounded-lg px-2.5 font-semibold text-accent hover:bg-white/10">
            {t("load.slow_another")}
          </button>
        )}
        <button type="button" data-testid="slow-torrent-wait" onClick={onWait} className="min-h-[36px] rounded-lg px-2.5 font-semibold text-accent hover:bg-white/10">
          {t("load.slow_wait")}
        </button>
      </span>
    </div>
  );
}
