// «На устройстве»: films and episodes saved in this browser for offline play.
//
// The video is streamed straight into Cache Storage (cache.put with the
// network response — never buffered in memory) under /offline-video/<id>,
// and the service worker (public/offline-video-sw.js) answers that path with
// HTTP Range support, so a plain <video> plays and seeks it offline. The
// list (title, poster, size…) lives in localStorage.
//
// What is saved is what this browser can play: the original file when the
// player plays it natively (MP4/H.264…), otherwise the server's compat
// stream (fragmented MP4, audio → AAC) from the start.
import { useEffect, useState } from "react";

export const VIDEO_CACHE = "martytv-offline-video-v1";
const META_KEY = "martytv.offline.v1";

export interface DeviceItem {
  id: string; // `${media_id}:${episode_id ?? "movie"}`
  mediaId: string | null;
  episodeId: string | null;
  title: string;
  subtitle: string | null;
  poster: string | null;
  mode: "original" | "compat";
  size: number;
  duration: number | null;
  at: number;
  position?: number; // offline resume (seconds)
}

export interface DeviceJob {
  id: string;
  bytes: number;
  total: number | null; // null: unknown (compat stream has no length)
  duration: number | null;
  error?: string;
}

export interface DownloadRequest {
  mediaId: string | null;
  episodeId: string | null;
  title: string;
  subtitle: string | null;
  poster: string | null;
  url: string;
  mode: "original" | "compat";
  duration: number | null;
}

export const deviceSupported = typeof caches !== "undefined" && typeof navigator !== "undefined" && "serviceWorker" in navigator;

export function deviceId(mediaId: string | null, episodeId: string | null, fallback: string): string {
  return mediaId ? `${mediaId}:${episodeId ?? "movie"}` : fallback;
}

export function offlineVideoUrl(id: string): string {
  return `/offline-video/${encodeURIComponent(id)}`;
}

function readMeta(): Record<string, DeviceItem> {
  try {
    return JSON.parse(localStorage.getItem(META_KEY) || "{}") as Record<string, DeviceItem>;
  } catch {
    return {};
  }
}

const meta = readMeta();
const jobs = new Map<string, DeviceJob & { abort: AbortController }>();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function saveMeta() {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    /* quota: the list is small; ignore */
  }
  emit();
}

export function deviceItem(id: string): DeviceItem | null {
  return meta[id] ?? null;
}

export function deviceJob(id: string): DeviceJob | null {
  return jobs.get(id) ?? null;
}

export function saveOfflinePosition(id: string, position: number) {
  const it = meta[id];
  if (!it) return;
  it.position = position;
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    /* ignore */
  }
}

/** Starts a download (no-op when already saved or running). Resolves when done. */
export async function downloadToDevice(req: DownloadRequest): Promise<void> {
  const id = deviceId(req.mediaId, req.episodeId, req.url);
  if (meta[id] || jobs.has(id) || !deviceSupported) return;
  const abort = new AbortController();
  const job = { id, bytes: 0, total: null as number | null, duration: req.duration, abort };
  jobs.set(id, job);
  emit();
  // Ask the browser to keep downloads under storage pressure.
  void navigator.storage?.persist?.().catch(() => false);
  try {
    const res = await fetch(req.url, { signal: abort.signal, credentials: "same-origin", cache: "no-store" });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers.get("Content-Length"));
    job.total = Number.isFinite(len) && len > 0 ? len : null;
    let last = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        job.bytes += chunk.byteLength;
        const now = Date.now();
        if (now - last > 500) {
          last = now;
          emit();
        }
        ctrl.enqueue(chunk);
      },
    });
    const type = res.headers.get("Content-Type")?.split(";")[0] || "video/mp4";
    const cache = await caches.open(VIDEO_CACHE);
    // Streams to disk; resolves once the whole body is stored.
    await cache.put(new Request(offlineVideoUrl(id)), new Response(res.body.pipeThrough(counter), { headers: { "Content-Type": type } }));
    if (job.bytes < 1_000_000) {
      await cache.delete(offlineVideoUrl(id));
      throw new Error("empty");
    }
    if (req.poster) void fetch(req.poster, { mode: "no-cors" }).catch(() => undefined); // warms the image cache
    meta[id] = {
      id,
      mediaId: req.mediaId,
      episodeId: req.episodeId,
      title: req.title,
      subtitle: req.subtitle,
      poster: req.poster,
      mode: req.mode,
      size: job.bytes,
      duration: req.duration,
      at: Date.now(),
    };
    jobs.delete(id);
    saveMeta();
  } catch (e) {
    jobs.delete(id);
    if (abort.signal.aborted) {
      emit();
      return;
    }
    const err = e as Error;
    const quota = err.name === "QuotaExceededError";
    jobs.set(id, { ...job, error: quota ? "quota" : "failed" });
    emit();
    setTimeout(() => {
      jobs.delete(id);
      emit();
    }, 15_000);
  }
}

export function cancelDownload(id: string) {
  jobs.get(id)?.abort.abort();
  jobs.delete(id);
  void caches.open(VIDEO_CACHE).then((c) => c.delete(offlineVideoUrl(id)));
  emit();
}

export async function removeFromDevice(id: string) {
  const c = await caches.open(VIDEO_CACHE);
  await c.delete(offlineVideoUrl(id));
  delete meta[id];
  saveMeta();
}

/** Re-renders on changes; returns the saved items (newest first) and running jobs. */
export function useDevice() {
  const [, setN] = useState(0);
  useEffect(() => {
    const l = () => setN((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  const items = Object.values(meta).sort((a, b) => b.at - a.at);
  return {
    items,
    jobs: [...jobs.values()],
    totalBytes: items.reduce((s, i) => s + i.size, 0),
  };
}

/** Whether a failed session request means "no connection" (show the offline screen). */
export function looksOffline(err: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  const status = (err as { status?: number } | null)?.status;
  return status === 0 || status === 502 || status === 503 || status === 504;
}
