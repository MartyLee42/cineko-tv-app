// «Cineko TV»: the channel's clock and programme bookkeeping (pure). The
// server sends an ordered list with estimated runtimes; the TV turns it into
// «Сейчас … · до 21:40», «Далее в 21:40 …», «Затем в 23:15 …».
import type { Schemas } from "@martytv/contracts";

export type ChannelItem = Schemas["ChannelItem"];

export interface Slot {
  /** Index in the programme. */
  index: number;
  start: number;
  end: number;
}

/** What the player knows about the current item (seconds; null = not yet). */
export interface NowPlaying {
  position: number | null;
  duration: number | null;
  /** When the current item was tuned in (ms). */
  startedAt: number;
}

/** Below this many picks after the current one, more are fetched. */
export const LOW_WATER = 3;
/** The programme shown in the OSD: now + next + then. */
export const GUIDE_SLOTS = 3;

/**
 * Slots from the current item on. The current one runs from (now − position)
 * for the file's duration once the player knows them, else from the moment
 * it was tuned in for its runtime estimate (never ending in the past); each
 * next one starts when the previous ends.
 */
export function buildClock(runtimes: number[], index: number, now: number, cur: NowPlaying, n = GUIDE_SLOTS): Slot[] {
  if (index < 0 || index >= runtimes.length) return [];
  let start: number;
  let end: number;
  if (cur.duration && cur.duration > 0 && cur.position !== null) {
    start = now - cur.position * 1000;
    end = start + cur.duration * 1000;
  } else {
    start = cur.startedAt;
    end = start + minutes(runtimes[index]!) * 60_000;
  }
  end = Math.max(end, now + 60_000);
  const out: Slot[] = [{ index, start, end }];
  for (let i = index + 1; i < runtimes.length && out.length < n; i++) {
    const s = out[out.length - 1]!.end;
    out.push({ index: i, start: s, end: s + minutes(runtimes[i]!) * 60_000 });
  }
  return out;
}

function minutes(m: number): number {
  return m > 0 ? m : 100;
}

/** Fraction of the current slot already played (0…1). */
export function slotProgress(s: Slot | undefined, now: number): number {
  if (!s || s.end <= s.start) return 0;
  return Math.min(1, Math.max(0, (now - s.start) / (s.end - s.start)));
}

/** HH:MM in the TV's local time. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Channel up / down: the index to tune to (null = stay; up past the end waits for more). */
export function stepIndex(index: number, dir: 1 | -1, length: number): number | null {
  const to = index + dir;
  if (to < 0 || to >= length) return null;
  return to;
}

/** Whether to ask the server for more picks. */
export function runningLow(index: number, length: number): boolean {
  return length - index - 1 < LOW_WATER;
}

/** Appends fresh picks, dropping any already on the programme (or dismissed). */
export function appendFresh(items: ChannelItem[], more: ChannelItem[], gone: ReadonlySet<string> = new Set()): ChannelItem[] {
  const have = new Set(items.map(keyOf));
  const out = items.slice();
  for (const it of more) {
    const k = keyOf(it);
    if (have.has(k) || gone.has(it.media.id)) continue;
    have.add(k);
    out.push(it);
  }
  return out;
}

/** A programme entry's identity (a series appears once per episode). */
export function keyOf(it: ChannelItem): string {
  return it.episode ? `${it.media.id}:${it.episode.id}` : it.media.id;
}

/** The media ids to send as `exclude` (≤ 200, the newest kept). */
export function excludeIds(items: ChannelItem[], gone: Iterable<string> = []): string[] {
  const all = [...new Set([...items.map((i) => i.media.id), ...gone])];
  return all.slice(Math.max(0, all.length - 200));
}
