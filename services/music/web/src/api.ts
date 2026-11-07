// Types and calls for the music service (/music/api) and Cineko login (/api/v1/auth).

export interface ArtistRef {
  id: number;
  name: string;
}

export interface TorrentSrc {
  hash: string;
  file: number;
  start?: number; // ms (CUE tracks)
  end?: number;
  ext: string;
  lossless?: boolean;
}

export interface Track {
  id: string; // "dz:<id>" | "t:<hash>:<file>[:<start>]"
  title: string;
  version?: string;
  artist: string;
  artistId?: number;
  artists?: ArtistRef[];
  album?: string;
  albumId?: number;
  cover?: string;
  coverBig?: string;
  duration: number;
  explicit?: boolean;
  position?: number;
  disk?: number;
  src?: TorrentSrc;
}

export interface Album {
  id: number;
  title: string;
  artist: string;
  artistId?: number;
  artists?: ArtistRef[];
  cover?: string;
  coverBig?: string;
  year?: string;
  date?: string;
  type?: string;
  nbTracks?: number;
  duration?: number;
  label?: string;
  genres?: string[];
  fans?: number;
  explicit?: boolean;
  tracks?: Track[];
}

export interface Artist {
  id: number;
  name: string;
  picture?: string;
  pictureBig?: string;
  fans?: number;
  albums?: number;
}

export interface DzPlaylist {
  id: number;
  title: string;
  description?: string;
  picture?: string;
  pictureBig?: string;
  count?: number;
  fans?: number;
  owner?: string;
  tracks?: Track[];
}

export interface Chart {
  tracks: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: DzPlaylist[];
}

export type SearchResultT = Chart;

export interface Home {
  recent: Track[];
  chart: Chart;
  mixes: Artist[];
  recentAlbums: Album[];
}

export interface ArtistPage {
  artist: Artist;
  top: Track[];
  albums: Album[];
  related: Artist[];
  playlists: DzPlaylist[];
}

export interface Genre {
  id: number;
  name: string;
  picture: string;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: string;
  csrfToken?: string;
}

export interface Me {
  user: User;
  features: { youtube: boolean; torrents: boolean; ai?: boolean };
  /** The main Cineko site (PUBLIC_BASE_URL), for links from Music's own host. */
  cinekoUrl?: string;
}

export interface MyPlaylist {
  id: number;
  name: string;
  description: string;
  count: number;
  covers: string[] | null;
  createdAt: number;
  updatedAt: number;
}

export interface PlaylistEntry {
  entryId: number;
  track: Track;
  addedAt: number;
}

export interface SavedItem {
  kind: "album" | "artist" | "playlist";
  id: string;
  data: Album & Artist & DzPlaylist;
  addedAt: number;
}

export interface Library {
  likes: string[];
  saved: SavedItem[];
  playlists: MyPlaylist[];
}

export interface Release {
  id: string;
  title: string;
  size: number;
  seeders: number;
  leechers: number;
  indexer: string;
  format: string;
  lossless: boolean;
  discography: boolean;
  date?: string;
  score: number;
}

export interface TorrentTrack extends Track {
  dir: string;
  number?: number;
  size?: number;
  native: boolean;
}

export interface TorrentInfo {
  hash: string;
  title: string;
  ready: boolean;
  peers: number;
  seeders: number;
  speed: number;
  tracks: TorrentTrack[];
  matched?: (Track | null)[];
}

export interface Candidate {
  videoId: string;
  title: string;
  author: string;
  duration: number;
  views: number;
  score: number;
}

/** A zaycev.net upload offered next to the YouTube ones. */
export interface ZvCandidate {
  id: string; // "zv:<n>"
  title: string;
  artist: string;
  duration: number;
  bitrate?: number;
  score: number;
}

export interface Lyrics {
  plain: string;
  synced: string;
  instrumental: boolean;
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const BASE = "/music/api";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["X-Requested-With"] = "marty-music";
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // A connection without internet can hang for minutes: the session check
  // gives up after 8 s so the app can open in offline mode.
  const timeout = path === "/me" ? AbortSignal.timeout(8000) : undefined;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
    signal: timeout,
  });
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const e = (data ?? {}) as { code?: string; message?: string };
    if (res.status === 401) window.dispatchEvent(new Event("music:unauthorized"));
    throw new ApiError(res.status, e.code ?? "error", e.message ?? `Ошибка ${res.status}`);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  del: <T>(path: string) => request<T>("DELETE", path),
};

// ---- Cineko account ----

export async function login(username: string, password: string): Promise<void> {
  const res = await fetch("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    let msg = "Не удалось войти";
    if (res.status === 401) msg = "Неверное имя пользователя или пароль";
    if (res.status === 429) msg = "Слишком много попыток, подождите немного";
    throw new Error(msg);
  }
}

export async function logout(csrf?: string): Promise<void> {
  await fetch("/api/v1/auth/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
    credentials: "same-origin",
    body: "{}",
  });
}

// ---- helpers ----

/** Deezer images go through the service (cached on its disk). */
export function img(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("/")) return url;
  return `${BASE}/img?u=${encodeURIComponent(url)}`;
}

/** A Deezer image URL at another square size (250 → 500 etc). */
export function sized(url: string | undefined, size: number): string | undefined {
  if (!url) return undefined;
  return url.replace(/\/(\d+)x\1-/, `/${size}x${size}-`);
}

export function dzId(t: Track): number | null {
  return t.id.startsWith("dz:") ? Number(t.id.slice(3)) : null;
}

export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtTotal(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} мин`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

export function fmtSize(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} ГБ`;
  return `${Math.round(b / 1e6)} МБ`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export function tracksWord(n: number): string {
  return `${n} ${plural(n, "трек", "трека", "треков")}`;
}

export function albumType(t?: string): string {
  switch (t) {
    case "single":
      return "Сингл";
    case "ep":
      return "EP";
    case "compile":
      return "Сборник";
    default:
      return "Альбом";
  }
}
