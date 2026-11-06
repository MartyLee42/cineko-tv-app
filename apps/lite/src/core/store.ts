// Everything the app remembers lives in this browser's localStorage:
// settings, favourites, watch history and per-episode resume positions.
// No accounts, no sync.
import { useSyncExternalStore } from "react";
import type { DesignId } from "./designs";

const P = "cineko.";

export function lsGet<T = string>(k: string): T | null {
  try {
    const raw = localStorage.getItem(k);
    if (raw == null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  } catch {
    return null;
  }
}

export function lsSet(k: string, v: unknown): void {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* private mode / quota: keep going in memory */
  }
}

// ---------------------------------------------------------------- tiny reactive slots

type Listener = () => void;

function slot<T>(key: string, init: T, normalize: (v: T) => T = (v) => v) {
  const read = (): T => {
    const raw = lsGet<unknown>(P + key);
    try {
      if (Array.isArray(init)) return normalize((Array.isArray(raw) ? raw : init) as T);
      const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      return normalize({ ...(init as object), ...obj } as T);
    } catch {
      return init;
    }
  };
  let value: T = read();
  const listeners = new Set<Listener>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      lsSet(P + key, next);
      listeners.forEach((l) => l());
    },
    subscribe(l: Listener) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    /** Storage changed elsewhere (another tab, an import). */
    reload() {
      value = read();
      listeners.forEach((l) => l());
    },
  };
}

// ---------------------------------------------------------------- settings

export type Lang = "ru" | "kk" | "en";
export const LANGS: Lang[] = ["ru", "kk", "en"];
export const LANG_NAMES: Record<Lang, string> = { ru: "Русский", kk: "Қазақша", en: "English" };
/** BCP 47 locale for dates/numbers and the TMDB `language` parameter. */
export const LOCALE: Record<Lang, string> = { ru: "ru-RU", kk: "kk-KZ", en: "en-US" };
export type HostMode = "auto" | "direct" | "mirror" | "custom";

export interface Settings {
  lang: Lang;
  design: DesignId;
  light: boolean;
  tmdbKey: string;
  tmdbApi: HostMode;
  tmdbApiCustom: string;
  tmdbImg: HostMode;
  tmdbImgCustom: string;
  /** Preferred quality (0 = best available). */
  quality: number;
  autoNext: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  lang: "ru",
  design: "kinozal",
  light: false,
  tmdbKey: "",
  tmdbApi: "auto",
  tmdbApiCustom: "",
  tmdbImg: "auto",
  tmdbImgCustom: "",
  quality: 1080,
  autoNext: true,
};

const settingsSlot = slot<Settings>("settings", DEFAULT_SETTINGS, (v) => ({
  ...v,
  lang: (["ru", "kk", "en"] as string[]).includes(v.lang) ? v.lang : "ru",
  quality: typeof v.quality === "number" ? v.quality : DEFAULT_SETTINGS.quality,
}));

export function getSettings(): Settings {
  return settingsSlot.get();
}

export function setSettings(patch: Partial<Settings>): void {
  settingsSlot.set({ ...settingsSlot.get(), ...patch });
}

export function useSettings(): Settings {
  return useSyncExternalStore(settingsSlot.subscribe, settingsSlot.get, settingsSlot.get);
}

// ---------------------------------------------------------------- library

export interface TitleRef {
  type: "movie" | "tv";
  id: number;
  title: string;
  poster?: string | null;
  backdrop?: string | null;
  year?: string;
  rating?: number;
}

export interface HistoryEntry extends TitleRef {
  season?: number;
  episode?: number;
  voice?: string;
  position: number;
  duration: number;
  updatedAt: number;
}

export interface Position {
  pos: number;
  dur: number;
  at: number;
}

const favSlot = slot<TitleRef[]>("favorites", []);
const histSlot = slot<HistoryEntry[]>("history", []);
const posSlot = slot<Record<string, Position>>("positions", {});
const voiceSlot = slot<Record<string, string>>("voices", {});
const qualitySlot = slot<Record<string, number>>("qualities", {});

export const refKey = (r: { type: string; id: number }) => `${r.type}:${r.id}`;
export const posKey = (type: string, id: number, season?: number, episode?: number) =>
  type === "tv" && season != null && episode != null ? `tv:${id}:${season}:${episode}` : `${type}:${id}`;

export function useFavorites(): TitleRef[] {
  return useSyncExternalStore(favSlot.subscribe, favSlot.get, favSlot.get);
}

export function isFavorite(r: { type: string; id: number }): boolean {
  return favSlot.get().some((x) => refKey(x) === refKey(r));
}

export function toggleFavorite(r: TitleRef): boolean {
  const list = favSlot.get();
  const k = refKey(r);
  if (list.some((x) => refKey(x) === k)) {
    favSlot.set(list.filter((x) => refKey(x) !== k));
    return false;
  }
  favSlot.set([r, ...list].slice(0, 500));
  return true;
}

export function useHistory(): HistoryEntry[] {
  return useSyncExternalStore(histSlot.subscribe, histSlot.get, histSlot.get);
}

export function lastWatched(r: { type: string; id: number }): HistoryEntry | undefined {
  return histSlot.get().find((x) => refKey(x) === refKey(r));
}

export function removeHistory(r: { type: string; id: number }): void {
  histSlot.set(histSlot.get().filter((x) => refKey(x) !== refKey(r)));
}

export function clearHistory(): void {
  histSlot.set([]);
  posSlot.set({});
}

/** Records progress: resume position (per episode) + the title's history entry. */
export function saveProgress(entry: Omit<HistoryEntry, "updatedAt">): void {
  const now = Date.now();
  const pk = posKey(entry.type, entry.id, entry.season, entry.episode);
  const positions = { ...posSlot.get(), [pk]: { pos: Math.floor(entry.position), dur: Math.floor(entry.duration), at: now } };
  // Keep the newest 2000 positions.
  const keys = Object.keys(positions);
  if (keys.length > 2000) {
    keys.sort((a, b) => positions[a].at - positions[b].at);
    for (const k of keys.slice(0, keys.length - 2000)) delete positions[k];
  }
  posSlot.set(positions);
  const k = refKey(entry);
  histSlot.set([{ ...entry, updatedAt: now }, ...histSlot.get().filter((x) => refKey(x) !== k)].slice(0, 300));
}

export function getPosition(type: string, id: number, season?: number, episode?: number): Position | undefined {
  return posSlot.get()[posKey(type, id, season, episode)];
}

export function usePositions(): Record<string, Position> {
  return useSyncExternalStore(posSlot.subscribe, posSlot.get, posSlot.get);
}

/** Watched = past 90 % (or under 3 min left). */
export function isWatched(p: Position | undefined): boolean {
  return !!p && p.dur > 0 && (p.pos / p.dur > 0.9 || p.dur - p.pos < 180);
}

export function preferredVoice(r: { type: string; id: number }): string | undefined {
  return voiceSlot.get()[refKey(r)];
}

export function setPreferredVoice(r: { type: string; id: number }, voice: string): void {
  voiceSlot.set({ ...voiceSlot.get(), [refKey(r)]: voice });
}

/** The quality last picked for this title (0/undefined = the global default). */
export function preferredQuality(r: { type: string; id: number }): number | undefined {
  return qualitySlot.get()[refKey(r)];
}

export function setPreferredQuality(r: { type: string; id: number }, q: number): void {
  qualitySlot.set({ ...qualitySlot.get(), [refKey(r)]: q });
}

/** Titles to resume on Home: started, not finished (series always, until removed). */
export function continueList(h: HistoryEntry[]): HistoryEntry[] {
  return h.filter((e) => e.type === "tv" || !(e.duration > 0 && e.position / e.duration > 0.93)).slice(0, 30);
}

const SLOTS = { settings: settingsSlot, favorites: favSlot, history: histSlot, positions: posSlot, voices: voiceSlot, qualities: qualitySlot };

// ---------------------------------------------------------------- export / import

export const EXPORT_FORMAT = "cineko-lite-backup";

/** Everything this device remembers, as one JSON document. */
export function exportData(): string {
  const data: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(SLOTS)) data[name] = s.get();
  return JSON.stringify({ format: EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(), data }, null, 2);
}

/** Restores a backup made by exportData (replaces what's here). Throws on a foreign file. */
export function importData(json: string): number {
  let doc: { format?: unknown; data?: Record<string, unknown> };
  try {
    doc = JSON.parse(json);
  } catch {
    throw new Error("bad json");
  }
  if (!doc || doc.format !== EXPORT_FORMAT || !doc.data || typeof doc.data !== "object") throw new Error("not a Cineko Lite backup");
  let n = 0;
  for (const [name, s] of Object.entries(SLOTS)) {
    const v = doc.data[name];
    if (v == null) continue;
    const isArr = Array.isArray(s.get());
    if (isArr !== Array.isArray(v) || typeof v !== "object") continue;
    lsSet(P + name, v);
    s.reload();
    n++;
  }
  return n;
}

/** Forgets everything stored on this device. */
export function resetData(): void {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(P))
      .forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
  for (const s of Object.values(SLOTS)) s.reload();
}

/** Offers `text` as a file download (works in desktop/mobile browsers; most TV web views ignore it). */
export function downloadText(name: string, text: string): void {
  try {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch {
    /* ignore */
  }
}

/** Opens a file picker and resolves with the chosen file's text. */
export function pickTextFile(): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json,.json";
      input.onchange = () => {
        const f = input.files?.[0];
        if (!f) return reject(new Error("no file"));
        const r = new FileReader();
        r.onload = () => resolve(String(r.result ?? ""));
        r.onerror = () => reject(new Error("read failed"));
        r.readAsText(f);
      };
      input.click();
    } catch (e) {
      reject(e);
    }
  });
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (!e.key || !e.key.startsWith(P)) return;
    const name = e.key.slice(P.length);
    (SLOTS as Record<string, { reload(): void }>)[name]?.reload();
  });
}
