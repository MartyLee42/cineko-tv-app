// "Rate what you watched": titles completed recently and not yet rated.
import type { HistoryItem, MediaSummary } from "@martytv/contracts";

const DISMISS_KEY = "martytv.rate_dismissed";
export const RATE_WINDOW_MS = 48 * 3600_000;

/**
 * Titles from history completed in the last 48 h that the profile hasn't
 * rated or dismissed — newest first, one entry per title (a series is asked
 * about once, after any finished episode). Rated = `me.rating` is set.
 */
export function pendingRatings(
  history: readonly HistoryItem[] | undefined,
  dismissed: ReadonlySet<string>,
  now = Date.now(),
): MediaSummary[] {
  const out: MediaSummary[] = [];
  const seen = new Set<string>();
  for (const h of history ?? []) {
    const m = h.media;
    if (seen.has(m.id)) continue;
    if (!h.progress.completed || !h.progress.completed_at) continue;
    if (now - Date.parse(h.progress.completed_at) > RATE_WINDOW_MS) continue;
    seen.add(m.id);
    if (m.me?.rating != null) continue;
    if (dismissed.has(m.id)) continue;
    out.push(m);
  }
  return out;
}

export function readDismissed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function dismissRating(mediaId: string): Set<string> {
  const s = readDismissed();
  s.add(mediaId);
  try {
    // Keep the list bounded.
    localStorage.setItem(DISMISS_KEY, JSON.stringify([...s].slice(-200)));
  } catch {
    // private mode
  }
  return s;
}
