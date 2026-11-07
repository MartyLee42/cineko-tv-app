// Live TV (IPTV) helpers: EPG progress, group chips, channel switching and the
// number-key input buffer. Pure, so they are unit-tested without React.
import type { IptvChannel, IptvGroup, IptvProgramme } from "@martytv/contracts";
import { BROKEN_GROUP, workingGroups } from "@martytv/media-types";

export { offlineLabel } from "@martytv/media-types";

/** Fraction (0…1) of a programme that has aired at `now`; null when unknown. */
export function epgProgress(p: Pick<IptvProgramme, "start" | "stop"> | null | undefined, now: number): number | null {
  if (!p) return null;
  const a = Date.parse(p.start);
  const b = Date.parse(p.stop);
  if (!isFinite(a) || !isFinite(b) || b <= a) return null;
  return Math.max(0, Math.min(1, (now - a) / (b - a)));
}

/** Whole minutes left in a programme (≥ 0), or null. */
export function minutesLeft(p: Pick<IptvProgramme, "stop"> | null | undefined, now: number): number | null {
  if (!p) return null;
  const b = Date.parse(p.stop);
  if (!isFinite(b)) return null;
  return Math.max(0, Math.ceil((b - now) / 60_000));
}

/** "HH:MM" in local time. */
export function hhmm(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A group chip: "all", "favorites" or a server group. */
export interface Chip {
  id: string;
  /** i18n key when the id is a known category, else null (use `name`). */
  key: string | null;
  name: string;
  count: number;
}

/** Categories with an `iptv.group.<id>` string. */
export const KNOWN_GROUPS: readonly string[] = [
  "news", "movies", "series", "sports", "kids", "music", "entertainment", "documentary", "general", "education", "science",
  "culture", "lifestyle", "travel", "religious", "business", "comedy", "cooking", "auto", "outdoor", "shop", "animation",
  "classic", "family", "legislative", "weather", "relax", "other",
];

/**
 * Chips for the channel screen: Все, Избранное (when there are favorites),
 * then the server's groups in its order.
 */
export function buildChips(groups: readonly IptvGroup[], total: number, favorites: number, broken = 0): Chip[] {
  const out: Chip[] = [{ id: "all", key: "iptv.group.all", name: "", count: total }];
  if (favorites > 0) out.push({ id: "favorites", key: "iptv.group.favorites", name: "", count: favorites });
  for (const g of groups) {
    if (g.id === "all" || g.id === "favorites" || g.id === BROKEN_GROUP) continue;
    out.push({ id: g.id, key: KNOWN_GROUPS.includes(g.id) ? `iptv.group.${g.id}` : null, name: g.name || g.id, count: g.count });
  }
  if (broken > 0) out.push({ id: BROKEN_GROUP, key: "iptvplay.broken", name: "", count: broken });
  return out;
}

/**
 * Chips over the working channels (counts recounted), «Нерабочие» last
 * when some channels are offline.
 */
export function channelChips(groups: readonly IptvGroup[], items: readonly IptvChannel[]): Chip[] {
  const working = items.filter((c) => !c.offline);
  return buildChips(workingGroups(groups, items), working.length, working.filter((c) => c.favorite).length, items.length - working.length);
}

/** Channels of one chip (client-side filter of the full list); broken channels only under their own chip. */
export function filterGroup(items: readonly IptvChannel[], group: string): IptvChannel[] {
  if (group === BROKEN_GROUP) return items.filter((c) => c.offline);
  const working = items.filter((c) => !c.offline);
  if (group === "all") return working;
  if (group === "favorites") return working.filter((c) => c.favorite);
  return working.filter((c) => c.group_id === group);
}

/** The next/previous channel in `list` (wraps around); the first when `currentId` isn't there. */
export function stepChannel<T extends { id: string }>(list: readonly T[], currentId: string | null, dir: 1 | -1): T | null {
  if (list.length === 0) return null;
  const i = currentId ? list.findIndex((c) => c.id === currentId) : -1;
  if (i < 0) return list[0]!;
  return list[(i + dir + list.length) % list.length]!;
}


/**
 * The channel with this number, else the nearest higher one, else the
 * highest (what a TV does for a number that doesn't exist).
 */
export function channelByNumber<T extends { number: number }>(list: readonly T[], n: number): T | null {
  if (list.length === 0 || !(n > 0)) return null;
  let exact: T | null = null;
  let above: T | null = null;
  let max: T | null = null;
  for (const c of list) {
    if (c.number === n) exact = c;
    if (c.number > n && (!above || c.number < above.number)) above = c;
    if (!max || c.number > max.number) max = c;
  }
  return exact ?? above ?? max;
}

/** Digits typed on the remote while watching: at most 4, committed after a pause. */
export const NUMBER_COMMIT_MS = 1500;
export const NUMBER_MAX_DIGITS = 4;

export class NumberInput {
  private digits = "";
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onCommit: (n: number) => void,
    private readonly onChange: (digits: string) => void,
    private readonly delay = NUMBER_COMMIT_MS,
  ) {}

  get value(): string {
    return this.digits;
  }

  /** A digit key: appended; a full buffer commits at once. */
  push(d: number) {
    if (!(d >= 0 && d <= 9)) return;
    if (this.digits === "" && d === 0) return; // no channel 0
    this.digits += String(d);
    this.onChange(this.digits);
    this.clearTimer();
    if (this.digits.length >= NUMBER_MAX_DIGITS) this.commit();
    else this.timer = setTimeout(() => this.commit(), this.delay);
  }

  /** OK while typing: commit now. Returns whether there was input. */
  commit(): boolean {
    this.clearTimer();
    if (!this.digits) return false;
    const n = parseInt(this.digits, 10);
    this.digits = "";
    this.onChange("");
    this.onCommit(n);
    return true;
  }

  /** Back while typing: drop the input. Returns whether there was input. */
  cancel(): boolean {
    this.clearTimer();
    if (!this.digits) return false;
    this.digits = "";
    this.onChange("");
    return true;
  }

  dispose() {
    this.clearTimer();
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** The digit of a key event (top row, numpad, TV remotes), or null. */
export function digitKey(e: Pick<KeyboardEvent, "key" | "keyCode">): number | null {
  if (e.key && /^[0-9]$/.test(e.key)) return Number(e.key);
  if (e.keyCode >= 48 && e.keyCode <= 57) return e.keyCode - 48;
  if (e.keyCode >= 96 && e.keyCode <= 105) return e.keyCode - 96;
  return null;
}

/** The text of the now-programme for the device state. */
export function programmeTitle(c: Pick<IptvChannel, "now"> | null | undefined): string | null {
  return c?.now?.title ?? null;
}

/** Up to two initials for a channel without a (working) logo; ES5-safe (no \p{…}). */
export function channelInitials(name: string): string {
  const words = name.replace(/[^0-9A-Za-zА-Яа-яЁё ]+/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return "TV";
  const w0 = words[0] as string;
  return (words.length === 1 ? w0.slice(0, 2) : w0.charAt(0) + (words[1] as string).charAt(0)).toUpperCase();
}

/** Local midnight of `now`'s day and of the next day (the «Программа на сегодня» window). */
export function dayWindow(now: number): { from: Date; to: Date } {
  const d = new Date(now);
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const to = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return { from, to };
}

export type DayStatus = "past" | "now" | "later";

/** Each programme's status at `now`, and the index to focus first (the current one, else the next, else the last). */
export function dayStatuses(items: readonly Pick<IptvProgramme, "start" | "stop">[], now: number): { status: DayStatus[]; focus: number } {
  const status = items.map((p): DayStatus => {
    const a = Date.parse(p.start);
    const b = Date.parse(p.stop);
    if (b <= now) return "past";
    if (a <= now) return "now";
    return "later";
  });
  let focus = status.indexOf("now");
  if (focus < 0) focus = status.indexOf("later");
  if (focus < 0) focus = Math.max(0, items.length - 1);
  return { status, focus };
}

/** Rows shown in the live programme panel. */
export const PROGRAM_ROWS = 9;

/** Visible window start for a selection in the live programme panel (keeps it ~3 rows from the top). */
export function programWindow(sel: number, count: number, rows = PROGRAM_ROWS): number {
  return Math.max(0, Math.min(Math.max(0, count - rows), sel - 3));
}
