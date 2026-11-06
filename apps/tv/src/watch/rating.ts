// "How was it?" after watching: which completed items get a rating prompt.
// Rules (don't nag): each movie/episode is offered at most once; nothing
// is asked for a title this TV already rated; a series stops asking after
// two "Not now"s. The prompt is shown when the player closes (never over
// playback or the next-episode countdown). Pure apart from the store.

export interface RateItem {
  profile_id: string;
  media_id: string;
  episode_id: string | null;
  kind: "movie" | "series";
  title: string;
  poster_path: string | null;
}

export interface KV {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

interface Memory {
  /** profile:media:episode keys already offered. */
  asked: string[];
  /** profile:media → "Not now" count. */
  skips: Record<string, number>;
  /** profile:media rated from this TV. */
  rated: string[];
}

const KEY = "martytv.rating";
const MAX_ASKED = 300;
export const MAX_SERIES_SKIPS = 2;

/** Completed by the server's rule: ≥ 90 %, or within the last 3 min (movies) / 90 s (episodes). */
export function isCompleted(position: number, duration: number | null, kind: "movie" | "series"): boolean {
  if (!duration || !isFinite(duration) || duration <= 0) return false;
  const tail = kind === "movie" ? 180 : 90;
  return position >= duration * 0.9 || (duration > tail * 2 && position >= duration - tail);
}

export class RatingQueue {
  pending: RateItem | null = null;
  private mem: Memory;
  private listeners = new Set<() => void>();

  constructor(private readonly kv: KV) {
    this.mem = load(kv);
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  private changed() {
    this.listeners.forEach((l) => l());
  }

  /** Whether `item` would be asked about (without queueing it). */
  wouldAsk(item: RateItem, alreadyRated = false): boolean {
    const m = `${item.profile_id}:${item.media_id}`;
    if (alreadyRated || this.mem.rated.includes(m)) return false;
    if (this.mem.asked.includes(`${m}:${item.episode_id ?? ""}`)) return false;
    if (item.kind === "series" && (this.mem.skips[m] ?? 0) >= MAX_SERIES_SKIPS) return false;
    return true;
  }

  /** A movie/episode was completed: queue the prompt (latest wins). */
  offer(item: RateItem, alreadyRated = false): boolean {
    if (!this.wouldAsk(item, alreadyRated)) return false;
    this.pending = item;
    this.changed();
    return true;
  }

  /** The prompt is shown now: it counts as asked. */
  shown(item: RateItem) {
    const k = `${item.profile_id}:${item.media_id}:${item.episode_id ?? ""}`;
    if (!this.mem.asked.includes(k)) this.mem.asked = [...this.mem.asked, k].slice(-MAX_ASKED);
    this.save();
  }

  skip(item: RateItem) {
    const m = `${item.profile_id}:${item.media_id}`;
    this.mem.skips = { ...this.mem.skips, [m]: (this.mem.skips[m] ?? 0) + 1 };
    this.done(item);
  }

  rated(item: RateItem) {
    const m = `${item.profile_id}:${item.media_id}`;
    if (!this.mem.rated.includes(m)) this.mem.rated = [...this.mem.rated, m].slice(-MAX_ASKED);
    this.done(item);
  }

  private done(item: RateItem) {
    this.shown(item);
    if (this.pending && this.pending.media_id === item.media_id && this.pending.episode_id === item.episode_id) this.pending = null;
    this.save();
    this.changed();
  }

  private save() {
    try {
      this.kv.set(KEY, JSON.stringify(this.mem));
    } catch {
      // storage full / disabled: memory only
    }
  }
}

function load(kv: KV): Memory {
  try {
    const m = JSON.parse(kv.get(KEY) ?? "null") as Partial<Memory> | null;
    return { asked: Array.isArray(m?.asked) ? m.asked : [], skips: m?.skips && typeof m.skips === "object" ? m.skips : {}, rated: Array.isArray(m?.rated) ? m.rated : [] };
  } catch {
    return { asked: [], skips: {}, rated: [] };
  }
}

/** Star (1–5) → API rating (1–10). */
/** Stars on the TV prompt (1–10) → the rating (same scale as the web and Kinopoisk). */
export const starsToRating = (stars: number) => Math.max(1, Math.min(10, Math.round(stars)));
