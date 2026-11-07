// Pure live-TV helpers (no React, no I/O) so they can be unit tested.
import { BROKEN_GROUP, workingGroups } from "@martytv/media-types";
import type { IptvChannel, IptvGroup, IptvProgramme } from "@martytv/contracts";

/** Group ids the server assigns to known categories; each has an `iptv.group.<id>` string. */
export const KNOWN_GROUPS = [
  "news",
  "movies",
  "sports",
  "kids",
  "series",
  "music",
  "entertainment",
  "documentary",
  "general",
  "education",
  "science",
  "culture",
  "lifestyle",
  "travel",
  "religious",
  "business",
  "comedy",
  "cooking",
  "auto",
  "outdoor",
  "shop",
  "animation",
  "classic",
  "family",
  "legislative",
  "weather",
  "relax",
  "other",
] as const;
export type KnownGroup = (typeof KNOWN_GROUPS)[number];

export const ALL = "all";
export const FAVORITES = "favorites";

export function isKnownGroup(id: string): id is KnownGroup {
  return (KNOWN_GROUPS as readonly string[]).includes(id);
}

export interface Chip {
  id: string;
  /** Known group (localize via iptv.group.<id>) or the playlist's own title. */
  known: boolean;
  name: string;
  count: number;
}

/**
 * Chips: Все, Избранное, then the groups — known categories in a fixed,
 * viewer-friendly order (news, movies, sports, kids…), the playlist's own
 * groups by size, «Другое» last.
 */
export function buildChips(groups: IptvGroup[], total: number, favorites: number, broken = 0): Chip[] {
  const rank = (g: IptvGroup) => {
    if (g.id === "other") return 10_000;
    const i = (KNOWN_GROUPS as readonly string[]).indexOf(g.id);
    return i >= 0 ? i : 1_000;
  };
  const sorted = [...groups]
    .filter((g) => g.count > 0)
    .sort((a, b) => rank(a) - rank(b) || b.count - a.count || a.name.localeCompare(b.name));
  return [
    { id: ALL, known: true, name: ALL, count: total },
    { id: FAVORITES, known: true, name: FAVORITES, count: favorites },
    ...sorted.map((g) => ({ id: g.id, known: isKnownGroup(g.id), name: g.name, count: g.count })),
    ...(broken > 0 ? [{ id: BROKEN_GROUP, known: false, name: "", count: broken }] : []),
  ];
}

/** Chips over the working channels (counts recounted), «Нерабочие» last when some are offline. */
export function channelChips(groups: IptvGroup[], items: IptvChannel[]): Chip[] {
  const working = items.filter((c) => !c.offline);
  return buildChips(workingGroups(groups, items), working.length, working.filter((c) => c.favorite).length, items.length - working.length);
}

/** Lowercase, ё → е, collapsed spaces: for name search. */
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

/**
 * Client-side filter of the full list: group chip + search (name or number
 * prefix). Broken (offline) channels show only under «Нерабочие» — or when
 * searched for.
 */
export function filterChannels(items: IptvChannel[], group: string, q: string): IptvChannel[] {
  const query = normalizeName(q);
  const byNumber = /^\d{1,4}$/.test(query);
  return items.filter((c) => {
    const outside = group === FAVORITES ? !c.favorite : group !== ALL && c.group_id !== group;
    if (group === BROKEN_GROUP ? !c.offline : (c.offline && !query) || outside) return false;
    if (!query) return true;
    if (byNumber && String(c.number).startsWith(query)) return true;
    return normalizeName(c.name).includes(query);
  });
}

// ---------------------------------------------------------------- programmes

const ms = (iso: string) => Date.parse(iso);

/** 0…1 through the programme at `now` (clamped). */
export function programmeProgress(p: Pick<IptvProgramme, "start" | "stop"> | null | undefined, now: number): number {
  if (!p) return 0;
  const a = ms(p.start);
  const b = ms(p.stop);
  if (!(b > a)) return 0;
  return Math.min(1, Math.max(0, (now - a) / (b - a)));
}

/** Whole minutes left (≥ 0, rounded up). */
export function minutesLeft(p: Pick<IptvProgramme, "stop"> | null | undefined, now: number): number {
  if (!p) return 0;
  return Math.max(0, Math.ceil((ms(p.stop) - now) / 60_000));
}

/** The programme on air at `now` among a channel's schedule. */
export function onAir<P extends Pick<IptvProgramme, "start" | "stop">>(items: P[], now: number): P | null {
  return items.find((p) => ms(p.start) <= now && now < ms(p.stop)) ?? null;
}

/** HH:MM in the viewer's time zone. */
export function clock(iso: string, locale: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

/** today / tomorrow / yesterday relative to `now` (local calendar days), else null. */
export function dayOffset(iso: string, now: number): number {
  const a = new Date(iso);
  const b = new Date(now);
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((day(a) - day(b)) / 86_400_000);
}

// ---------------------------------------------------------------- guide grid

/** Floors a time to the previous step (minutes), in local time. */
export function floorTo(t: number, stepMinutes: number): number {
  const d = new Date(t);
  d.setSeconds(0, 0);
  d.setMinutes(Math.floor(d.getMinutes() / stepMinutes) * stepMinutes);
  return d.getTime();
}

export const GUIDE_HOURS = 3;

/** The guide window: from = now − 30 min floored to 30 min, `hours` long. */
export function guideWindow(now: number, hours = GUIDE_HOURS, shift = 0): { from: number; to: number } {
  const from = floorTo(now - 30 * 60_000, 30) + shift * hours * 3_600_000;
  return { from, to: from + hours * 3_600_000 };
}

/** Tick times every `step` minutes inside [from, to). */
export function timeTicks(from: number, to: number, step = 30): number[] {
  const out: number[] = [];
  for (let t = floorTo(from, step); t < to; t += step * 60_000) if (t >= from) out.push(t);
  return out;
}

/** Position of a programme inside the window in percent, clipped; null when it doesn't overlap. */
export function blockSpan(p: Pick<IptvProgramme, "start" | "stop">, from: number, to: number): { left: number; width: number } | null {
  const a = Math.max(ms(p.start), from);
  const b = Math.min(ms(p.stop), to);
  if (!(b > a)) return null;
  const span = to - from;
  return { left: ((a - from) / span) * 100, width: ((b - a) / span) * 100 };
}

// ---------------------------------------------------------------- player

/** Next/previous channel in list order (wraps around). dir +1 = higher number. */
export function neighbour<T extends { id: string }>(items: T[], currentId: string, dir: 1 | -1): T | null {
  if (!items.length) return null;
  const i = items.findIndex((c) => c.id === currentId);
  if (i < 0) return items[0]!;
  return items[(i + dir + items.length) % items.length]!;
}

/** Digit entry for "type a channel number": appends a digit (max 4), returns the new buffer. */
export function typeDigit(buffer: string, digit: string): string {
  if (!/^\d$/.test(digit)) return buffer;
  const next = (buffer + digit).replace(/^0+/, "");
  return next.length > 4 ? next.slice(-4) : next;
}

/** The channel a typed number selects: exact number, else null. */
export function channelByNumber<T extends { number: number }>(items: T[], buffer: string): T | null {
  const n = Number(buffer);
  if (!buffer || !Number.isFinite(n)) return null;
  return items.find((c) => c.number === n) ?? null;
}

/** Seconds behind the live edge (0 when unknown). */
export function liveLag(currentTime: number, liveEdge: number | null | undefined): number {
  if (liveEdge == null || !Number.isFinite(liveEdge) || !Number.isFinite(currentTime)) return 0;
  return Math.max(0, liveEdge - currentTime);
}

/** "Behind live" threshold: show «В эфир» as active beyond it. */
export const BEHIND_LIVE_SECONDS = 12;

/** 0:45, 3:05, 1:02:09 */
export function formatLag(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Initials for a missing logo. */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return "TV";
  return (words.length === 1 ? words[0]!.slice(0, 2) : words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** The profile's iptv_playlists setting toggled for one playlist (all → explicit list). */
export function togglePlaylist(current: "all" | string[], allIds: string[], id: string, on: boolean): "all" | string[] {
  const set = new Set(current === "all" ? allIds : current);
  if (on) set.add(id);
  else set.delete(id);
  return allIds.every((x) => set.has(x)) ? "all" : allIds.filter((x) => set.has(x));
}

/** EPG coverage in percent: channels with programmes / channels. */
export function coverage(s: { channels: number; with_programmes: number }): number {
  return s.channels > 0 ? Math.round((s.with_programmes / s.channels) * 100) : 0;
}
