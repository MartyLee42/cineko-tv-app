import { useEffect, useState } from "react";
import { dzId, img, sized, type Track } from "./api";
import { toast } from "./toast";

// Tracks saved on this device for offline play. Audio lives in Cache Storage
// under <base>offline/<id> (served with Range support by public/sw.js);
// the track list is in localStorage.

const AUDIO_CACHE = "mm-audio-v1";
const IMG_CACHE = "mm-img-v1";
const META_KEY = "mm.offline.v1";

export interface OfflineItem {
  track: Track;
  size: number;
  at: number;
}

type Meta = Record<string, OfflineItem>;

function readMeta(): Meta {
  try {
    return JSON.parse(localStorage.getItem(META_KEY) || "{}") as Meta;
  } catch {
    return {};
  }
}

let meta: Meta = readMeta();
const progress = new Map<string, number>(); // id → 0..1
let queue: Track[] = [];
let running = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function saveMeta() {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    toast("Не хватает места для списка загрузок");
  }
  emit();
}

export const offlineSupported = typeof caches !== "undefined" && "serviceWorker" in navigator;

export function offlineUrl(id: string) {
  return `${import.meta.env.BASE_URL}offline/${encodeURIComponent(id)}`;
}

export function isDownloaded(id: string) {
  return !!meta[id];
}

/** Where the full audio file comes from (MP3 for files browsers can't play). */
function sourceUrl(t: Track): string | null {
  const id = dzId(t);
  if (id !== null) return `/music/api/play/${id}`;
  if (t.id.startsWith("yt:")) return `/music/api/yt/${t.id.slice(3)}`;
  if (t.id.startsWith("zv:")) return `/music/api/zv/${t.id.slice(3)}`;
  if (t.id.startsWith("yq:")) return `/music/api/ytq?${new URLSearchParams({ id: t.id, artist: t.artist, title: t.title, duration: String(t.duration || 0) })}`;
  if (!t.src) return null;
  const base = `/music/api/stream/${t.src.hash}/${t.src.file}`;
  const native = ["flac", "mp3", "m4a", "aac", "ogg", "opus", "wav"].includes(t.src.ext);
  if (native && !t.src.start && !t.src.end) return `${base}?ext=${encodeURIComponent(t.src.ext)}`;
  const q = new URLSearchParams({ tc: "1" });
  if (t.src.start) q.set("start", String(t.src.start));
  if (t.src.end) q.set("end", String(t.src.end));
  return `${base}?${q}`;
}

async function saveImages(t: Track) {
  try {
    const c = await caches.open(IMG_CACHE);
    for (const u of [img(sized(t.cover, 120)), img(sized(t.cover, 250)), img(sized(t.coverBig ?? t.cover, 500)), img(sized(t.coverBig ?? t.cover, 1000))]) {
      if (!u || (await c.match(u))) continue;
      const r = await fetch(u);
      if (r.ok) await c.put(u, r);
    }
  } catch {
    /* covers are optional */
  }
}

async function downloadOne(t: Track) {
  const url = sourceUrl(t);
  if (!url) throw new Error("Нельзя скачать этот трек");
  // Never from the HTTP cache: after a source change it held the old recording.
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok || !res.body) throw new Error(`Ошибка ${res.status}`);
  const total = Number(res.headers.get("Content-Length")) || 0;
  const type = res.headers.get("Content-Type") || "audio/mpeg";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    progress.set(t.id, total ? got / total : Math.min(0.95, got / 8e6));
    emit();
  }
  if (got < 10_000) throw new Error("Пустой файл");
  const blob = new Blob(chunks as BlobPart[], { type });
  const c = await caches.open(AUDIO_CACHE);
  await c.put(
    new Request(offlineUrl(t.id)),
    new Response(blob, { headers: { "Content-Type": type, "Content-Length": String(blob.size) } }),
  );
  await saveImages(t);
  meta[t.id] = { track: t, size: blob.size, at: Date.now() };
  saveMeta();
}

async function run() {
  if (running) return;
  running = true;
  // Ask the browser not to evict downloads under storage pressure.
  navigator.storage?.persist?.().catch(() => undefined);
  let ok = 0;
  let failed = 0;
  while (queue.length) {
    const t = queue.shift()!;
    if (meta[t.id]) continue;
    progress.set(t.id, 0);
    emit();
    try {
      await downloadOne(t);
      ok++;
    } catch {
      failed++;
    }
    progress.delete(t.id);
    emit();
  }
  running = false;
  if (ok + failed > 1 || failed) toast(failed ? `Скачано ${ok}, не удалось ${failed}` : `Скачано треков: ${ok}`);
  else if (ok === 1) toast("Трек скачан");
}

export function download(tracks: Track[]) {
  if (!offlineSupported) {
    toast("Этот браузер не поддерживает офлайн-режим");
    return;
  }
  const fresh = tracks.filter((t) => !meta[t.id] && !progress.has(t.id) && !queue.some((q) => q.id === t.id));
  if (!fresh.length) {
    toast("Уже скачано");
    return;
  }
  queue.push(...fresh);
  toast(fresh.length === 1 ? "Скачиваем…" : `Скачиваем ${fresh.length} треков…`);
  emit();
  void run();
}

export async function removeDownloads(ids: string[]) {
  const c = await caches.open(AUDIO_CACHE);
  for (const id of ids) {
    await c.delete(offlineUrl(id));
    delete meta[id];
  }
  queue = queue.filter((t) => !ids.includes(t.id));
  saveMeta();
}

/** Downloads a track again (its source was changed). */
export async function redownload(t: Track) {
  await removeDownloads([t.id]);
  emit();
  download([t]);
}

export function useOffline() {
  const [, setN] = useState(0);
  useEffect(() => {
    const l = () => setN((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  const items = Object.entries(meta)
    .map(([, v]) => v)
    .sort((a, b) => b.at - a.at);
  return {
    items,
    totalBytes: items.reduce((s, i) => s + i.size, 0),
    pending: queue.length + progress.size,
    progress,
    isDownloaded,
  };
}

/** Install prompt (Android / desktop Chrome); iOS installs from the Share menu. */
let installEvent: (Event & { prompt: () => Promise<void> }) | null = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvent = e as Event & { prompt: () => Promise<void> };
  emit();
});

export function canPromptInstall() {
  return !!installEvent;
}

export async function promptInstall(): Promise<boolean> {
  if (!installEvent) return false;
  await installEvent.prompt();
  installEvent = null;
  emit();
  return true;
}

export const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
