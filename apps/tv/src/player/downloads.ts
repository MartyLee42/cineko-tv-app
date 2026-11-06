// Server downloads: which releases/episodes of a title the server has (or is
// fetching) on disk. Display only — playback goes through the same stream_url.
import { useQuery } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@martytv/contracts";
import { useI18n } from "@martytv/ui";
import { api } from "../api";

type Download = Schemas["Download"];
type Status = Schemas["DownloadStatus"];

/** The caller's downloads of a title; any error → none (the label is optional). */
export function useMediaDownloads(mediaId: string | null) {
  return useQuery({
    queryKey: ["downloads", "media", mediaId],
    enabled: !!mediaId,
    staleTime: 30_000,
    retry: false,
    queryFn: () =>
      unwrap(api.GET("/downloads", { params: { query: { media_id: mediaId! } } }))
        .then((r) => r.items)
        .catch((): Download[] => []),
  });
}

const RANK: Record<Status, number> = { done: 0, downloading: 1, queued: 2, waiting_space: 3, paused: 4, failed: 5 };

/**
 * The most relevant download for an episode (by episode_id) and/or a release
 * (by info_hash): done beats in progress beats the rest.
 */
export function findDownload(items: readonly Download[] | undefined, m: { episodeId?: string | null; infoHash?: string | null }): Download | null {
  if (!items) return null;
  const hash = m.infoHash ? m.infoHash.toLowerCase() : null;
  let best: Download | null = null;
  for (const d of items) {
    if (m.episodeId && d.episode_id !== m.episodeId) continue;
    if (m.infoHash !== undefined && (!hash || d.info_hash.toLowerCase() !== hash)) continue;
    if (!best || RANK[d.status] < RANK[best.status]) best = d;
  }
  return best;
}

/** «На сервере ✓» / «Загружается 42%» / short status; null when nothing to show. */
export function useDownloadLabel() {
  const { t } = useI18n();
  return (d: { status: Status; progress: number } | null): string | null => {
    if (!d) return null;
    switch (d.status) {
      case "done":
        return t("downloads.on_server");
      case "downloading":
        return t("downloads.status.downloading_short", { percent: Math.floor(d.progress * 100) });
      case "queued":
        return t("downloads.status.queued");
      case "waiting_space":
        return t("downloads.status.waiting_space");
      case "paused":
        return t("downloads.status.paused");
      case "failed":
        return t("downloads.status.failed");
    }
    return null;
  };
}
