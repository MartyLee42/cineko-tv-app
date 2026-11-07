// The file's chapters (MediaInfo.chapters, from ffprobe): ticks on the seek
// bar, the chapter title near the position, and ◀▶ landing on chapter
// starts. Pure; shared by the TV and web players.

export interface ChapterLike {
  start_seconds: number;
  end_seconds: number;
  title: string;
}

export interface Chapter {
  start: number;
  end: number;
  /** null for generic titles («Chapter 01», «Глава 2», «00:05:00.000»): show «Глава N». */
  title: string | null;
}

/** Below this, a chapter start counts as «already there» (no jump of a second or two). */
const NEAR_S = 1.5;
/** A ◀▶ step stops at a chapter start only this far from where it starts (a 2 s «step» would feel broken). */
const MIN_SNAP_S = 5;

/** «Chapter 01», «Глава 2», «Part 3», «00:05:00.000», «1»: mkvmerge / ripper defaults that say nothing. */
const GENERIC = /^(?:(?:chapter|chap|ch\.?|глава|часть|part|kapitel|chapitre|capitolo|cap[ií]tulo)\s*#?\s*\d+|\d+|\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)$/i;

/**
 * The file's chapters, sorted, with generic titles dropped: null when fewer
 * than two (one chapter is the whole file) or the duration is unknown.
 * Chapters past the end are cut.
 */
export function fileChapters(list: readonly ChapterLike[] | null | undefined, duration: number | null | undefined): Chapter[] | null {
  if (!list || list.length < 2) return null;
  const d = duration && isFinite(duration) && duration > 0 ? duration : null;
  const out: Chapter[] = [];
  for (const c of [...list].sort((a, b) => a.start_seconds - b.start_seconds)) {
    const start = Math.max(0, c.start_seconds);
    if (!isFinite(start) || (d !== null && start >= d - NEAR_S)) continue;
    const prev = out[out.length - 1];
    if (prev && start - prev.start < NEAR_S) continue;
    const t = (c.title ?? "").trim();
    out.push({ start, end: Math.max(start, d !== null ? Math.min(c.end_seconds, d) : c.end_seconds), title: t && !GENERIC.test(t) ? t : null });
  }
  return out.length >= 2 ? out : null;
}

/** Tick positions on the seek bar (% of the duration), without the one at 0. */
export function chapterTicks(chapters: readonly Chapter[] | null, duration: number | null | undefined): number[] {
  if (!chapters || !duration || duration <= 0) return [];
  return chapters.filter((c) => c.start >= NEAR_S).map((c) => (c.start / duration) * 100);
}

/** Index of the chapter playing at `t` (the last one starting at or before it), or -1. */
export function chapterIndexAt(chapters: readonly Chapter[] | null, t: number): number {
  if (!chapters) return -1;
  let at = -1;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i]!.start <= t + 0.25) at = i;
    else break;
  }
  return at;
}

/** The next chapter's start after `t`, or null in the last chapter. */
export function nextChapterStart(chapters: readonly Chapter[] | null, t: number): number | null {
  if (!chapters) return null;
  const c = chapters.find((x) => x.start > t + NEAR_S);
  return c ? c.start : null;
}

/**
 * ⏮ / «previous chapter» like a CD player: back to the current chapter's
 * start, or — within the first 3 s of it — to the previous chapter's.
 */
export function prevChapterStart(chapters: readonly Chapter[] | null, t: number): number | null {
  if (!chapters) return null;
  const i = chapterIndexAt(chapters, t);
  if (i < 0) return null;
  if (t - chapters[i]!.start > 3) return chapters[i]!.start;
  return i > 0 ? chapters[i - 1]!.start : chapters[0]!.start < t - 0.5 ? chapters[0]!.start : null;
}

/**
 * ◀▶ with chapters: a seek step from `from` to `target` that passes a
 * chapter start stops there instead (the first one met in its direction).
 * Never moves further than the plain step; a start right at `from` (just
 * landed on it, or one a couple of seconds away) doesn't stop the press. Returns the snapped target or null.
 */
export function snapToChapter(chapters: readonly Chapter[] | null, from: number, target: number): number | null {
  if (!chapters || target === from) return null;
  if (target > from) {
    const c = chapters.find((x) => x.start >= from + MIN_SNAP_S && x.start <= target);
    return c ? c.start : null;
  }
  for (let i = chapters.length - 1; i >= 0; i--) {
    const s = chapters[i]!.start;
    if (s <= from - MIN_SNAP_S && s >= target) return s;
    if (s < target) break;
  }
  return null;
}
