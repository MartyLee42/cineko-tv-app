// Quick card actions (♥ «Нравится», «Буду смотреть», the 1–10 rating) shared
// by the TV app and the PWA: the optimistic `me` patch over cached data and
// the rating picker's arithmetic.

/** The profile's state on a title (MediaUserState). */
export interface MeState {
  progress_percent: number | null;
  completed: boolean;
  in_watchlist: boolean;
  favorite: boolean;
  rating: number | null;
}

export const EMPTY_ME: MeState = { progress_percent: null, completed: false, in_watchlist: false, favorite: false, rating: null };

/** A media summary/detail: string id + kind + tmdb_id (how cached data is recognised). */
const isMedia = (o: Record<string, unknown>) => typeof o.id === "string" && typeof o.kind === "string" && "tmdb_id" in o;

/**
 * Returns `data` with `me` patched on every copy of the title `mediaId`
 * (rows, grids, lists, details, nested `media` fields). Untouched branches
 * keep their identity; nothing matched → the same reference.
 */
export function patchMediaMe<T>(data: T, mediaId: string, patch: Partial<MeState>): T {
  const walk = (d: unknown): unknown => {
    if (!d || typeof d !== "object") return d;
    if (Array.isArray(d)) {
      let changed = false;
      const out = d.map((v) => {
        const nv = walk(v);
        if (nv !== v) changed = true;
        return nv;
      });
      return changed ? out : d;
    }
    const o = d as Record<string, unknown>;
    if (isMedia(o) && o.id === mediaId) return { ...o, me: { ...EMPTY_ME, ...(o.me as object | undefined), ...patch } };
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o)) {
      const v = o[k];
      const nv = v && typeof v === "object" ? walk(v) : v;
      if (nv !== v) changed = true;
      out[k] = nv;
    }
    return changed ? out : d;
  };
  return walk(data) as T;
}

export const RATING_MAX = 10;

/** The picker's position after ◀ / ▶ (0 = «Без оценки», 1–10). */
export function stepRating(sel: number, delta: number): number {
  return Math.max(0, Math.min(RATING_MAX, Math.round(sel) + delta));
}

/** Where the picker starts: the saved rating, else 7 (as the after-credits prompt). */
export function initialPick(current: number | null | undefined): number {
  return current != null && current >= 1 ? Math.min(RATING_MAX, current) : 7;
}

/**
 * What OK on the picker does: `{ rating: n }` saves, `{ rating: null }`
 * removes the saved one, null = nothing to change.
 */
export function ratingChange(sel: number, current: number | null | undefined): { rating: number | null } | null {
  const cur = current ?? null;
  if (sel <= 0) return cur == null ? null : { rating: null };
  const n = Math.min(RATING_MAX, Math.round(sel));
  return n === cur ? null : { rating: n };
}
