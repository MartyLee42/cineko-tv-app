// CDNVideoHub public player API (no key, CORS open for any origin).
//
//   GET {base}/playlist?pub=12&aggr=imdb&id=tt0133093 → {titleName, isSerial, items:[{vkId, voiceStudio, voiceType, season?, episode?}]}
//   GET {base}/video/<vkId>                          → {duration, sources:{hlsUrl, mpeg*Url…}}
//
// Every voice-over is a separate VK Video upload. The stream URLs are signed
// for the requesting client's IP + user agent and expire after ~24 h, so the
// browser that asks is the browser that plays: no proxy needed.
// Mirrors services/api/internal/sources/cdnvideohub/provider.go of the full app.

export const CVH_BASE = "https://plapi.cdnvideohub.com/api/v1/player/sv";

export interface CvhItem {
  vkId: string;
  voiceStudio?: string;
  voiceType?: string;
  season?: number;
  episode?: number;
  name?: string;
}

export interface Playlist {
  title: string;
  isSerial: boolean;
  items: CvhItem[];
}

export type VoiceKind = "dub" | "mvo" | "dvo" | "avo" | "vo" | "original" | "sub" | "";

export interface Voice {
  /** Stable id inside a title (the label; movies add the upload id). */
  key: string;
  label: string;
  kind: VoiceKind;
  vkId: string;
}

export interface Rendition {
  q: number;
  url: string;
}

export interface VideoInfo {
  duration: number;
  ladder: Rendition[];
  hls: string;
  /** Unix ms when the signed URLs stop working (0 = unknown). */
  expires: number;
}

/** Normalises the raw playlist JSON (vkId may come as a number or string). */
export function parsePlaylist(raw: unknown): Playlist {
  const r = (raw ?? {}) as { titleName?: unknown; isSerial?: unknown; items?: unknown };
  const items: CvhItem[] = [];
  if (Array.isArray(r.items)) {
    for (const x of r.items as Record<string, unknown>[]) {
      if (!x) continue;
      const vk = x.vkId == null ? "" : String(x.vkId).trim();
      if (!vk || vk === "0") continue;
      const it: CvhItem = { vkId: vk };
      if (typeof x.voiceStudio === "string") it.voiceStudio = x.voiceStudio;
      if (typeof x.voiceType === "string") it.voiceType = x.voiceType;
      if (typeof x.name === "string") it.name = x.name;
      if (typeof x.season === "number") it.season = x.season;
      if (typeof x.episode === "number") it.episode = x.episode;
      items.push(it);
    }
  }
  return { title: typeof r.titleName === "string" ? r.titleName.trim() : "", isSerial: r.isSerial === true, items };
}

export function voiceKind(label: string): VoiceKind {
  const t = label.toLowerCase();
  if (t.includes("дубл")) return "dub";
  if (t.includes("многоголос") || t.includes("багатоголос")) return "mvo";
  if (t.includes("двухголос") || t.includes("двоголос")) return "dvo";
  if (t.includes("авторск")) return "avo";
  if (t.includes("одноголос") || t.includes("закадров")) return "vo";
  if (t.includes("оригинал") || t.includes("original")) return "original";
  if (t.includes("субтитр")) return "sub";
  return "";
}

const GENERIC: Record<string, string> = {
  dub: "Дубляж",
  mvo: "Многоголосый",
  dvo: "Двухголосый",
  avo: "Авторский",
  vo: "Одноголосый",
  original: "Оригинал",
  sub: "Субтитры",
};

/** Display label + kind of an item's voice-over (studio, else the generic type). */
export function voiceOf(it: CvhItem): { label: string; kind: VoiceKind } {
  const kind = voiceKind(it.voiceType ?? "");
  let label = (it.voiceStudio ?? "").trim();
  if (!label) label = GENERIC[kind] || (it.voiceType ?? "").trim();
  return { label: label || "CDNVideoHub", kind };
}

/** Movie voices: every upload is its own entry (same label twice gets a number). */
export function movieVoices(pl: Playlist): Voice[] {
  const out: Voice[] = [];
  const seen = new Set<string>();
  const count = new Map<string, number>();
  for (const it of pl.items) {
    if (it.season != null || seen.has(it.vkId)) continue;
    seen.add(it.vkId);
    const { label, kind } = voiceOf(it);
    const n = (count.get(label) ?? 0) + 1;
    count.set(label, n);
    out.push({ key: n === 1 ? label : `${label} #${n}`, label: n === 1 ? label : `${label} (${n})`, kind, vkId: it.vkId });
  }
  return out;
}

export interface EpisodeEntry {
  episode: number;
  voices: Voice[];
}

export interface SeasonEntry {
  season: number;
  episodes: EpisodeEntry[];
  /** Every voice that has at least one episode of the season, in first-seen order. */
  voices: string[];
}

/** Series index: seasons → episodes → voices (first upload per voice wins). */
export function seriesIndex(pl: Playlist): SeasonEntry[] {
  const seasons = new Map<number, Map<number, Voice[]>>();
  const voiceOrder = new Map<number, string[]>();
  for (const it of pl.items) {
    if (it.season == null || it.episode == null || it.season < 0 || it.episode < 1) continue;
    const { label, kind } = voiceOf(it);
    let eps = seasons.get(it.season);
    if (!eps) {
      eps = new Map();
      seasons.set(it.season, eps);
      voiceOrder.set(it.season, []);
    }
    let vs = eps.get(it.episode);
    if (!vs) {
      vs = [];
      eps.set(it.episode, vs);
    }
    if (vs.some((v) => v.key === label)) continue;
    vs.push({ key: label, label, kind, vkId: it.vkId });
    const order = voiceOrder.get(it.season)!;
    if (!order.includes(label)) order.push(label);
  }
  return [...seasons.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([season, eps]) => ({
      season,
      voices: voiceOrder.get(season) ?? [],
      episodes: [...eps.entries()].sort((a, b) => a[0] - b[0]).map(([episode, voices]) => ({ episode, voices })),
    }));
}

/** The voice to play: the preferred label when present, else the first (dubbing first). */
export function pickVoice(voices: Voice[], preferred?: string | null): Voice | undefined {
  if (!voices.length) return undefined;
  if (preferred) {
    const exact = voices.find((v) => v.key === preferred) ?? voices.find((v) => v.label === preferred);
    if (exact) return exact;
  }
  return voices.find((v) => v.kind === "dub") ?? voices[0];
}

type RawSources = Partial<Record<string, string>>;

/** MP4 renditions, best first (the API swaps the 2K/4K names: mpeg2kUrl is 2160p). */
export function ladderOf(s: RawSources | undefined | null): Rendition[] {
  const src = s ?? {};
  const out: Rendition[] = [];
  const add = (q: number, u: string | undefined) => {
    if (!u || typeof u !== "string" || out.some((r) => r.q === q)) return;
    out.push({ q, url: u });
  };
  add(2160, src.mpeg2kUrl);
  add(1440, src.mpeg4kUrl);
  add(1440, src.mpegQhdUrl);
  add(1080, src.mpegFullHdUrl);
  add(720, src.mpegHighUrl);
  add(480, src.mpegMediumUrl);
  add(360, src.mpegLowUrl);
  add(240, src.mpegLowestUrl);
  add(144, src.mpegTinyUrl);
  return out;
}

/** Best quality ≤ want (0 = best); else the lowest there is; 0 when nothing. */
export function chooseQuality(have: number[], want: number): number {
  if (!have.length) return 0;
  if (want <= 0) return have[0];
  for (const q of have) if (q <= want) return q;
  return have[have.length - 1];
}

/** VK `expires` parameter (ms or s) → unix ms, 0 when absent. */
export function expiryOf(u: string): number {
  const m = /[?&]expires=(\d+)/.exec(u);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!n) return 0;
  return n > 1e12 ? n : n * 1000;
}

export function parseVideo(raw: unknown): VideoInfo {
  const r = (raw ?? {}) as { duration?: unknown; sources?: RawSources };
  const ladder = ladderOf(r.sources);
  const hls = typeof r.sources?.hlsUrl === "string" ? r.sources.hlsUrl : "";
  const first = ladder[0]?.url || hls;
  return { duration: typeof r.duration === "number" ? r.duration : 0, ladder, hls, expires: first ? expiryOf(first) : 0 };
}

// ---------------------------------------------------------------- network

const playlistCache = new Map<string, Promise<Playlist>>();
const videoCache = new Map<string, { at: number; v: Promise<VideoInfo> }>();

async function getJSON(url: string, timeoutMs = 12000): Promise<unknown> {
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = setTimeout(() => ctl?.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl?.signal, headers: { Accept: "application/json" } });
    // Unknown titles: 204 No Content (sometimes 404) — "not available", not an error.
    if (res.status === 404 || res.status === 204) return {};
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return text.trim() ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

/** The playlist of a title by IMDb id (cached for the session; misses too). */
export function fetchPlaylist(imdbId: string): Promise<Playlist> {
  const key = imdbId.trim();
  let p = playlistCache.get(key);
  if (!p) {
    p = getJSON(`${CVH_BASE}/playlist?pub=12&aggr=imdb&id=${encodeURIComponent(key)}`).then(parsePlaylist);
    p.catch(() => playlistCache.delete(key));
    playlistCache.set(key, p);
  }
  return p;
}

/** Signed stream URLs of one upload (re-fetched once they're close to expiring). */
export function fetchVideo(vkId: string, fresh = false): Promise<VideoInfo> {
  const hit = videoCache.get(vkId);
  const now = Date.now();
  if (hit && !fresh && now - hit.at < 3 * 3600_000) return hit.v;
  const v = getJSON(`${CVH_BASE}/video/${encodeURIComponent(vkId)}`).then((raw) => {
    const info = parseVideo(raw);
    if (!info.ladder.length && !info.hls) throw new Error("no stream");
    return info;
  });
  v.catch(() => videoCache.delete(vkId));
  videoCache.set(vkId, { at: now, v });
  return v;
}
