// «Семья советует» pure helpers shared by the PWA and the TV app: the "why"
// line of a family pick («Анна ★9 · Олег: посмотрено вчера»), «Понравилось
// двоим», and the members' taste match. Structurally typed (no contracts
// import), no React, no DOM.
import type { MessageKey } from "./i18n";

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

export interface FamilyPersonLike {
  profile_id: string;
  name: string;
  avatar: string;
  color: string;
}

export interface FamilyEndorsementLike extends FamilyPersonLike {
  rating: number | null;
  completed: boolean;
  completed_at: string | null;
  favorite: boolean;
  liked: boolean;
}

export interface FamilyWhyLike {
  people: FamilyEndorsementLike[];
  liked_by: number;
  text: string;
}

export interface FamilyMemberLike extends FamilyPersonLike {
  match: number | null;
  co_rated: number;
}

/** Whole calendar days between an ISO time and now (local time; never negative). */
export function calendarDaysAgo(iso: string, now: Date): number {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 0;
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/**
 * Russian plural form (one / few / many) for the "N days ago" keys. Only
 * used for 2…29 days, so the English keys are all plural ("21 days").
 */
export function daysPluralForm(n: number): "one" | "few" | "many" {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "one";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "few";
  return "many";
}

/** One member's part of the line: "Анна ★9", "Олег: посмотрено вчера", "Ира ♥". */
export function endorsementText(e: FamilyEndorsementLike, t: T, now: Date = new Date()): string {
  if (e.rating != null) return t("family.rated", { name: e.name, n: e.rating });
  if (e.completed) {
    if (!e.completed_at) return t("family.watched", { name: e.name });
    const n = calendarDaysAgo(e.completed_at, now);
    if (n === 0) return t("family.watched_today", { name: e.name });
    if (n === 1) return t("family.watched_yesterday", { name: e.name });
    if (n < 30) return t("family.watched_ago", { name: e.name, days: t(`family.days_${daysPluralForm(n)}` as MessageKey, { n }) });
    return t("family.watched", { name: e.name });
  }
  if (e.favorite) return t("family.favorite", { name: e.name });
  return e.name;
}

/** «Понравилось двоим» when two or more members liked it, else null. */
export function likedByText(n: number, t: T): string | null {
  if (n < 2) return null;
  if (n <= 4) return t(`family.liked_by.${n}` as MessageKey);
  return t("family.liked_by.n", { n });
}

/** The card's "why": up to `max` members (likers first, as the server orders them). */
export function familyWhyText(why: FamilyWhyLike, t: T, now: Date = new Date(), max = 2): string {
  const parts = why.people.slice(0, max).map((e) => endorsementText(e, t, now));
  if (parts.length === 0) return why.text;
  const rest = why.people.length - max;
  return parts.join(" · ") + (rest > 0 ? ` +${rest}` : "");
}

/** "Анна: совпадение вкусов 82 %" (null when unknown). */
export function matchText(m: FamilyMemberLike, t: T): string | null {
  return m.match == null ? null : t("family.match", { name: m.name, n: m.match });
}

/** Members with a known match, best first, for a row header or tooltip. */
export function membersWithMatch<M extends FamilyMemberLike>(members: readonly M[], max = 4): M[] {
  return members
    .filter((m) => m.match != null)
    .sort((a, b) => (b.match ?? 0) - (a.match ?? 0))
    .slice(0, max);
}
