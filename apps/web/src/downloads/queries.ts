// Server downloads data: lists (mine / admin all), create / pin / pause / delete,
// admin storage + TorrServer torrents, and the realtime cache updates.
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { unwrap, type PlaybackSource } from "@martytv/contracts";
import { api, realtime } from "../api";
import { useCatalogLang } from "../catalog/queries";
import { sourceKey } from "../play/queries";
import { applyUpdate, briefOf, type Download, type ListFilter } from "./format";

type Scope = "mine" | "all";

export const downloadsKey = (scope: Scope, filter: ListFilter, lang: string) => ["downloads", scope, filter, lang] as const;

/** The caller's downloads (optionally for one title), kept live over realtime. */
export function useDownloads(filter: ListFilter = {}, enabled = true) {
  const lang = useCatalogLang();
  return useQuery({
    queryKey: downloadsKey("mine", filter, lang),
    queryFn: async () => (await unwrap(api.GET("/downloads", { params: { query: { ...filter, lang } } }))).items,
    enabled,
    staleTime: 30_000,
  });
}

/** Admin: every download with its requesters (others' progress isn't pushed: poll). */
export function useAllDownloads() {
  const lang = useCatalogLang();
  return useQuery({
    queryKey: downloadsKey("all", {}, lang),
    queryFn: async () => (await unwrap(api.GET("/downloads", { params: { query: { all: true, lang } } }))).items,
    refetchInterval: 5000,
  });
}

// ---------------------------------------------------------------- cache updates

/** Puts a download into every cached list (refetching the lists it is new to). */
export function applyDownload(qc: QueryClient, d: Download) {
  let missing = false;
  for (const q of qc.getQueryCache().findAll({ queryKey: ["downloads"] })) {
    const list = q.state.data as Download[] | undefined;
    if (!list) continue;
    const filter = (q.queryKey[2] ?? {}) as ListFilter;
    const scope = q.queryKey[1] as Scope;
    // Events reach requesters only, so for "mine" lists it is always the caller's.
    const next = applyUpdate(list, scope === "mine" ? { ...d, mine: true } : d, filter);
    if (next === null) missing = true;
    else if (next !== list) qc.setQueryData(q.queryKey, next);
  }
  if (missing) void qc.invalidateQueries({ queryKey: ["downloads"] });
  patchSources(qc, (s) => (s.download?.id === d.id || sameFile(s, d) ? briefOf(d) : undefined));
}

export function removeDownload(qc: QueryClient, id: string) {
  qc.setQueriesData<Download[]>({ queryKey: ["downloads"] }, (list) => list?.filter((x) => x.id !== id));
  patchSources(qc, (s) => (s.download?.id === id ? null : undefined));
}

function sameFile(s: PlaybackSource, d: Download): boolean {
  return !!s.file && !!s.release.info_hash && s.release.info_hash.toLowerCase() === d.info_hash.toLowerCase() && s.file.index === d.file_index;
}

/** Updates PlaybackSource.download in cached sources (no refetch: stream URLs stay put). */
function patchSources(qc: QueryClient, next: (s: PlaybackSource) => PlaybackSource["download"] | undefined) {
  for (const q of qc.getQueryCache().findAll({ queryKey: ["playback-source"] })) {
    const s = q.state.data as PlaybackSource | undefined;
    if (!s) continue;
    const d = next(s);
    if (d !== undefined) qc.setQueryData(q.queryKey, { ...s, download: d });
  }
}

/** `download.updated` / `download.removed` → caches; refetch after a reconnect. */
export function useDownloadsRealtime(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let wasOpen = realtime.state === "open";
    const offMsg = realtime.on((env) => {
      if (env.type === "download.updated" && env.payload) applyDownload(qc, env.payload as Download);
      else if (env.type === "download.removed") {
        const id = (env.payload as { id?: string } | undefined)?.id;
        if (id) removeDownload(qc, id);
      }
    });
    const offState = realtime.onState((s) => {
      if (s === "open" && !wasOpen) void qc.invalidateQueries({ queryKey: ["downloads"] });
      wasOpen = s === "open";
    });
    return () => {
      offMsg();
      offState();
    };
  }, [qc, enabled]);
}

// ---------------------------------------------------------------- mutations

export function createDownload(body: { source_id: string; season?: boolean }) {
  return unwrap(api.POST("/downloads", { body }));
}

/** POST /downloads for a ready torrent source; caches get the result right away. */
export function useCreateDownload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createDownload,
    onSuccess: (res, body) => {
      const items = res.items.map((d) => ({ ...d, mine: true }));
      items.forEach((d) => applyDownload(qc, d));
      // The source's own file: matched by hash + index, else the only item.
      const src = qc.getQueryData<PlaybackSource>(sourceKey(body.source_id));
      if (src && !src.download) {
        const own = items.find((d) => sameFile(src, d)) ?? (items.length === 1 ? items[0] : undefined);
        if (own) qc.setQueryData(sourceKey(body.source_id), { ...src, download: briefOf(own) });
      }
    },
  });
}

export function usePatchDownload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; pinned?: boolean; paused?: boolean }) =>
      unwrap(api.PATCH("/downloads/{id}", { params: { path: { id: v.id } }, body: { pinned: v.pinned, paused: v.paused } })),
    onSuccess: (d) => applyDownload(qc, d),
  });
}

export function useDeleteDownload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/downloads/{id}", { params: { path: { id } } })).then(() => id),
    onSuccess: (id) => {
      removeDownload(qc, id);
      void qc.invalidateQueries({ queryKey: ["admin", "storage"] });
    },
  });
}

// ---------------------------------------------------------------- admin

export const storageKey = ["admin", "storage"] as const;

export function useStorage() {
  return useQuery({ queryKey: storageKey, queryFn: () => unwrap(api.GET("/admin/storage")), refetchInterval: 10_000 });
}

export function useUpdateStorage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { reserve_gb?: number; max_library_gb?: number | null; keep_days?: number }) => unwrap(api.PATCH("/admin/storage", { body })),
    onSuccess: (s) => qc.setQueryData(storageKey, s),
  });
}

export const torrentsKey = ["admin", "torrserver", "torrents"] as const;

export function useTorrServerTorrents() {
  return useQuery({
    queryKey: torrentsKey,
    queryFn: async () => (await unwrap(api.GET("/admin/torrserver/torrents"))).items,
    refetchInterval: 15_000,
  });
}

export function removeTorrent(hash: string, force = false) {
  return unwrap(api.DELETE("/admin/torrserver/torrents/{hash}", { params: { path: { hash }, query: force ? { force: true } : {} } }));
}
