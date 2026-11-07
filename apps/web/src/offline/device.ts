// «На устройстве»: films and episodes saved in this browser for offline play.
//
// A job prepares the release (offline/prepare.ts: the release the player
// would pick, a playback source, original file or compat MP4), then streams
// the video into Cache Storage as 8 MB chunks (/offline-video/<id>/c/<n>)
// and finally writes a manifest (/offline-video/<id>/m). The service worker
// (public/offline-video-sw.js) answers /offline-video/<id> from the chunks,
// with HTTP Range support, so a plain <video> plays and seeks it offline.
//
// Chunks keep memory bounded (WebKit buffers a whole Response body before
// storing it) and let original files resume after a dropped connection,
// a reload or a stall (Range: bytes=<done>-). The compat stream has no byte
// ranges: it restarts. One job runs at a time; the rest wait in a queue.
// The list (title, poster, status…) lives in localStorage.
import { useEffect, useState } from "react";
import { reportError } from "@martytv/ui";
import { CHUNK, NEW_JOB, classifyError, checkSpace, httpError, isRunning, jobReducer, resumeCheck, retryDelay, shouldAutoRetry, type DeviceError, type JobEvent, type SaveMode } from "./logic";
import { DeviceFail, prepareDownload, type Prepared } from "./prepare";
import { interruptItem, migrateItem, type DeviceItem, type Stored } from "./items";

export type { DeviceItem };

export const VIDEO_CACHE = "martytv-offline-video-v1";
const META_KEY = "martytv.offline.v1";

export interface DeviceRequest {
  mediaId: string;
  episodeId: string | null;
  season: number | null;
  episode: number | null;
  title: string;
  subtitle: string | null;
  poster: string | null;
  releaseId?: string | null;
  sourceId?: string | null;
  profileId?: string | null;
  lang: "ru" | "en";
  /** The player's choice ("save what plays here"). */
  mode?: SaveMode | null;
  audio?: number | null;
}

/** Why device downloads are off in this browser (null: they work). */
export type Unsupported = "insecure" | "no_storage" | null;

export function unsupportedReason(): Unsupported {
  if (typeof window === "undefined") return "no_storage";
  if (window.isSecureContext === false) return "insecure";
  if (typeof caches === "undefined" || !("serviceWorker" in navigator)) return "no_storage";
  return null;
}

export const deviceSupported = unsupportedReason() === null;

export function deviceId(mediaId: string | null, episodeId: string | null, fallback = ""): string {
  return mediaId ? `${mediaId}:${episodeId ?? "movie"}` : fallback;
}

export function offlineVideoUrl(id: string): string {
  return `/offline-video/${encodeURIComponent(id)}`;
}
const chunkUrl = (id: string, n: number) => `${offlineVideoUrl(id)}/c/${n}`;
const manifestUrl = (id: string) => `${offlineVideoUrl(id)}/m`;

// ---------------------------------------------------------------- store

function readMeta(): Record<string, DeviceItem> {
  try {
    const raw = JSON.parse(localStorage.getItem(META_KEY) || "{}") as Record<string, Stored>;
    const out: Record<string, DeviceItem> = {};
    for (const [k, v] of Object.entries(raw)) if (v && typeof v === "object") out[k] = interruptItem(migrateItem({ ...v, id: v.id ?? k }));
    return out;
  } catch {
    return {};
  }
}

const meta: Record<string, DeviceItem> = typeof localStorage !== "undefined" ? readMeta() : {};
const aborts = new Map<string, AbortController>();
const listeners = new Set<() => void>();
let running: string | null = null;

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

function apply(id: string, e: JobEvent, extra: Partial<DeviceItem> = {}) {
  const it = meta[id];
  if (!it) return;
  meta[id] = { ...it, ...jobReducer(it, e), ...extra };
  saveMeta();
}

export function deviceItem(id: string): DeviceItem | null {
  return meta[id] ?? null;
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

// ---------------------------------------------------------------- cache

async function openCache(): Promise<Cache> {
  try {
    return await caches.open(VIDEO_CACHE);
  } catch (e) {
    throw new DeviceFail(classifyError(e) === "quota" ? "quota" : "storage");
  }
}

/** Drops an item's chunks / manifest / legacy entry. */
async function dropEntries(id: string, keepChunks = false): Promise<void> {
  try {
    const c = await caches.open(VIDEO_CACHE);
    const base = offlineVideoUrl(id);
    await c.delete(manifestUrl(id));
    if (keepChunks) return;
    await c.delete(base);
    const keys = await c.keys();
    await Promise.all(keys.filter((k) => new URL(k.url).pathname.startsWith(`${base}/c/`)).map((k) => c.delete(k)));
  } catch {
    /* storage gone: nothing to drop */
  }
}

// Partial compat bytes from an interrupted session can't be resumed.
if (deviceSupported) {
  for (const it of Object.values(meta)) if (it.status === "paused" && it.mode !== "original" && it.chunks === 0) void dropEntries(it.id);
}

// ---------------------------------------------------------------- queue

/** Adds a download (or retries a failed / paused one). No-op when saved or running. */
export function startDeviceDownload(req: DeviceRequest): string {
  const id = deviceId(req.mediaId, req.episodeId);
  const old = meta[id];
  if (old && (old.status === "saved" || isRunning(old.status))) return id;
  if (old) {
    // A retry: keep stored chunks of the same release; a new pick starts over.
    const same = !req.releaseId || req.releaseId === old.releaseId;
    meta[id] = {
      ...old,
      ...jobReducer(old, { type: "retry" }),
      ...(same ? {} : { releaseId: req.releaseId ?? null, sourceId: req.sourceId ?? null, mode: req.mode ?? null, audio: req.audio ?? null, chunks: 0, bytes: 0, total: null }),
      autoResume: false,
      retryAt: undefined,
    };
    if (!same) void dropEntries(id);
  } else {
    meta[id] = {
      ...NEW_JOB,
      id,
      mediaId: req.mediaId,
      episodeId: req.episodeId,
      season: req.season,
      episode: req.episode,
      title: req.title,
      subtitle: req.subtitle,
      poster: req.poster,
      releaseId: req.releaseId ?? null,
      sourceId: req.sourceId ?? null,
      profileId: req.profileId ?? null,
      lang: req.lang,
      mode: req.mode ?? null,
      audio: req.audio ?? null,
      size: 0,
      duration: null,
      at: Date.now(),
    };
  }
  saveMeta();
  pump();
  return id;
}

/** Retry / resume an item from the list. */
export function retryDeviceDownload(id: string) {
  const it = meta[id];
  if (!it || it.status === "saved" || isRunning(it.status)) return;
  apply(id, { type: "retry" }, { autoResume: false, retryAt: undefined });
  pump();
}

export function cancelDownload(id: string) {
  aborts.get(id)?.abort();
  void removeFromDevice(id);
}

export async function removeFromDevice(id: string) {
  aborts.get(id)?.abort();
  delete meta[id];
  saveMeta();
  await dropEntries(id);
}

function pump() {
  if (running) return;
  const next = Object.values(meta)
    .filter((x) => x.status === "queued")
    .sort((a, b) => a.at - b.at)[0];
  if (!next) {
    void wake(false);
    return;
  }
  running = next.id;
  void wake(true);
  void run(next.id).finally(() => {
    running = null;
    pump();
  });
}

let persistAsked = false;
let persisted: boolean | null = null;
/** Whether the browser promised to keep the files under storage pressure (null: unknown). */
export function storagePersisted(): boolean | null {
  return persisted;
}

async function run(id: string) {
  const abort = new AbortController();
  aborts.set(id, abort);
  let mode: SaveMode = meta[id]?.mode ?? "original";
  try {
    apply(id, { type: "prepare" });
    const it = meta[id]!;
    const p: Prepared = await prepareDownload(it, abort.signal);
    if (abort.signal.aborted || !meta[id]) return;
    // A different file than the stored chunks (another mode / size): start over.
    const sameFile = it.mode === p.mode && (it.total == null || p.total == null || it.total === p.total) && it.releaseId === p.releaseId;
    const keep = sameFile && p.mode === "original" ? it.chunks : 0;
    mode = p.mode;
    meta[id] = {
      ...meta[id]!,
      mode: p.mode,
      releaseId: p.releaseId,
      sourceId: p.sourceId,
      audio: p.audio ?? null,
      video: p.video,
      duration: p.duration ?? meta[id]!.duration,
      type: p.type,
      chunks: keep,
    };
    saveMeta();
    if (!keep) await dropEntries(id);

    const est = await navigator.storage?.estimate?.().catch(() => null);
    const space = checkSpace(est ?? null, p.expected != null ? p.expected - keep * CHUNK : null);
    if (!space.ok) throw new DeviceFail("quota", undefined, { need: space.need, free: space.free });
    if (!persistAsked) {
      persistAsked = true;
      persisted = (await navigator.storage?.persist?.().catch(() => false)) ?? null;
    }
    const cache = await openCache();
    await download(id, p, keep, cache, abort.signal);
  } catch (e) {
    if (abort.signal.aborted || !meta[id]) return;
    fail(id, e, mode);
  } finally {
    aborts.delete(id);
  }
}

async function download(id: string, p: Prepared, keep: number, cache: Cache, signal: AbortSignal) {
  const offset = keep * CHUNK;
  if (offset > 0 && p.total === offset) {
    // Every byte was stored before the interruption: only the manifest is missing.
    apply(id, { type: "start", total: p.total, restart: false });
    return finish(id, p, cache, keep, offset);
  }
  let res: Response;
  try {
    res = await fetch(p.url, {
      signal,
      credentials: "same-origin",
      cache: "no-store",
      ...(offset > 0 && { headers: { Range: `bytes=${offset}-` } }),
    });
  } catch (e) {
    throw new DeviceFail(classifyError(e, navigator.onLine));
  }
  if (!res.ok || !res.body) throw new DeviceFail(httpError(res.status), await errorCodeOf(res));
  const len = Number(res.headers.get("Content-Length"));
  const rc = resumeCheck({
    offset,
    status: res.status,
    contentRange: res.headers.get("Content-Range"),
    contentLength: Number.isFinite(len) && len > 0 ? len : null,
    expectedTotal: p.total,
  });
  if (rc.kind === "mismatch") {
    void res.body.cancel();
    meta[id] = { ...meta[id]!, chunks: 0, bytes: 0 };
    await dropEntries(id);
    throw new DeviceFail("incomplete");
  }
  const restart = rc.kind === "restart";
  if (restart && offset > 0) await dropEntries(id);
  const total = p.mode === "original" ? (rc.total ?? p.total) : null;
  apply(id, { type: "start", total, restart });

  let n = restart ? 0 : keep;
  let parts: Uint8Array[] = [];
  let partBytes = 0;
  let last = 0;
  let lastSize = restart ? 0 : CHUNK; // kept chunks are full ones
  const put = async () => {
    lastSize = partBytes;
    await cache.put(new Request(chunkUrl(id, n)), new Response(new Blob(parts as BlobPart[]), { headers: { "Content-Type": "application/octet-stream" } }));
    n += 1;
    parts = [];
    partBytes = 0;
  };
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let off = 0;
      while (off < value.byteLength) {
        const take = Math.min(CHUNK - partBytes, value.byteLength - off);
        parts.push(value.subarray(off, off + take));
        partBytes += take;
        off += take;
        if (partBytes === CHUNK) {
          await put();
          apply(id, { type: "chunk", chunks: n, bytes: n * CHUNK });
        }
      }
      const now = Date.now();
      if (now - last > 700) {
        last = now;
        const it = meta[id];
        if (it) {
          it.bytes = n * CHUNK + partBytes;
          emit();
        }
      }
    }
    if (partBytes > 0) await put();
  } catch (e) {
    if (e instanceof DeviceFail) throw e;
    throw new DeviceFail(classifyError(e, navigator.onLine));
  }
  const got = n > 0 ? (n - 1) * CHUNK + lastSize : 0;
  if (total != null && got !== total) throw new DeviceFail("incomplete");
  if (got < 1_000_000) {
    await dropEntries(id);
    throw new DeviceFail("incomplete");
  }
  return finish(id, p, cache, n, got);
}

/** All bytes are stored: the manifest makes the video playable. */
async function finish(id: string, p: Prepared, cache: Cache, n: number, got: number) {
  await cache.put(
    new Request(manifestUrl(id)),
    new Response(JSON.stringify({ v: 2, size: got, chunk: CHUNK, count: n, type: p.type || "video/mp4" }), { headers: { "Content-Type": "application/json" } }),
  );
  if (meta[id]?.poster) void fetch(meta[id]!.poster!, { mode: "no-cors" }).catch(() => undefined); // warms the image cache
  apply(id, { type: "done", bytes: got }, { size: got, autoResume: false, retryAt: undefined });
}

async function errorCodeOf(res: Response): Promise<string | undefined> {
  try {
    const j = (await res.json()) as { error?: { code?: string }; code?: string };
    return j.error?.code ?? j.code;
  } catch {
    return undefined;
  }
}

function fail(id: string, e: unknown, mode: SaveMode) {
  const f = e instanceof DeviceFail ? e : new DeviceFail(classifyError(e, typeof navigator === "undefined" || navigator.onLine));
  const it = meta[id];
  if (!it) return;
  const keepChunks = mode === "original";
  if (f.error === "offline") {
    apply(id, { type: "pause", keepChunks }, { autoResume: true });
    if (!keepChunks) void dropEntries(id);
    return;
  }
  const attempts = it.attempts + 1;
  const auto = shouldAutoRetry(f.error, mode, it.attempts);
  apply(id, { type: "fail", error: f.error, code: f.code, vars: f.vars, keepChunks }, { attempts, ...(auto && { retryAt: Date.now() + retryDelay(attempts) }) });
  if (!keepChunks) void dropEntries(id);
  if (auto) {
    // The link may have expired: prepare again (the source is refreshed on GET).
    setTimeout(() => {
      const cur = meta[id];
      if (!cur || cur.status !== "failed" || !cur.retryAt) return;
      meta[id] = { ...cur, ...jobReducer(cur, { type: "retry" }), attempts, retryAt: undefined };
      saveMeta();
      pump();
    }, retryDelay(attempts));
  } else if (f.error !== "quota") {
    // Admin → Errors: why a download failed on this device.
    reportError("player", `device download failed: ${f.error}${f.code ? ` (${f.code})` : ""}`, {
      component: "device-download",
      extra: { mode, bytes: it.bytes, total: it.total, chunks: it.chunks, release: it.releaseId },
    });
  }
}

// ---------------------------------------------------------------- environment

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    for (const it of Object.values(meta)) if (it.status === "paused" && it.autoResume) retryDeviceDownload(it.id);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && running) void wake(true);
  });
}

// Keeps a phone's screen on while a download runs (a locked phone stops it).
let lock: { release(): Promise<void> } | null = null;
async function wake(on: boolean) {
  const wl = (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
  try {
    if (on && wl && !lock && document.visibilityState === "visible") {
      lock = await wl.request("screen");
      (lock as unknown as EventTarget).addEventListener?.("release", () => {
        lock = null;
      });
    } else if (!on && lock) {
      const l = lock;
      lock = null;
      await l.release();
    }
  } catch {
    lock = null;
  }
}

// ---------------------------------------------------------------- hooks

/** Re-renders on changes; returns every item (newest first) and the saved total. */
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
    saved: items.filter((i) => i.status === "saved"),
    totalBytes: items.reduce((s, i) => s + (i.status === "saved" ? i.size : i.chunks * CHUNK), 0),
  };
}

/** One item, live (null when not on the device). */
export function useDeviceItem(id: string): DeviceItem | null {
  useDevice();
  return meta[id] ?? null;
}

/** Whether a failed session request means "no connection" (show the offline screen). */
export function looksOffline(err: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  const status = (err as { status?: number } | null)?.status;
  return status === 0 || status === 502 || status === 503 || status === 504;
}

export type { DeviceError };
