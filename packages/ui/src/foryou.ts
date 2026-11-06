// Phase 6 pure helpers shared by the PWA and the TV app: localized row titles
// and reasons from typed reason payloads, history grouping / filtering, and
// the «Удиви меня!» form → request mapping. No React, no DOM.
import type { MessageKey } from "./i18n";
import { familyWhyText, type FamilyWhyLike } from "./family";

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** The fields of `ForYouReason` the client uses (structurally typed: no contracts import). */
export interface ReasonLike {
  type: string;
  text: string;
  media_title: string | null;
  person_name: string | null;
  genre_names: string[];
  collection_title: string | null;
  mood: string | null;
  /** type "family": who in the family liked it (optional in the contract). */
  family?: FamilyWhyLike | null;
}

export interface RowLike {
  kind: string;
  title: string;
  reason: ReasonLike;
  /** kind "curated": the list and the profile's progress (optional in the contract). */
  curated?: { title: string; watched: number; count: number } | null;
}

const MOODS = ["cozy", "tense", "funny", "thoughtful", "scary", "romantic", "family"] as const;
export type Mood = (typeof MOODS)[number];
export const SURPRISE_MOODS: readonly Mood[] = MOODS;

export function moodLabel(mood: string, t: T): string {
  return (MOODS as readonly string[]).includes(mood) ? t(`fy.mood.${mood}` as MessageKey) : mood;
}

function genres(r: ReasonLike, max = 2): string {
  return r.genre_names.slice(0, max).join(", ");
}

/**
 * One card's "why": built from the reason type and its typed fields. Falls
 * back to the server's localized `text` only for unknown types or when a
 * required field is missing.
 */
export function reasonText(r: ReasonLike, t: T): string {
  switch (r.type) {
    case "because_you_rated":
      return r.media_title ? t("fy.reason.because_you_rated", { title: r.media_title }) : r.text;
    case "director":
      return r.person_name ? t("fy.reason.director", { name: r.person_name }) : r.text;
    case "actor":
      return r.person_name ? t("fy.reason.actor", { name: r.person_name }) : r.text;
    case "genre":
      return r.genre_names.length ? t("fy.reason.genre", { genres: genres(r) }) : t("fy.reason.genre_plain");
    case "hidden_gem":
      return t("fy.reason.hidden_gem");
    case "something_different":
      return r.genre_names.length ? t("fy.reason.something_different", { genres: genres(r) }) : t("fy.reason.something_different_plain");
    case "trending_for_you":
      return t("fy.reason.trending_for_you");
    case "ai_collection":
      return r.collection_title ? t("fy.reason.ai_collection", { title: r.collection_title }) : t("fy.reason.ai_collection_plain");
    case "rewatch":
      return r.media_title ? t("fy.reason.rewatch_title", { title: r.media_title }) : t("fy.reason.rewatch");
    case "popular":
      return t("fy.reason.popular");
    case "mood":
      return r.mood ? t("fy.reason.mood", { mood: moodLabel(r.mood, t) }) : r.text;
    case "family":
      return r.family ? familyWhyText(r.family, t) : r.text;
    default:
      return r.text;
  }
}

/** A «Для вас» row's heading from its kind and reason (server `title` only as a fallback). */
export function rowTitle(row: RowLike, t: T): string {
  const r = row.reason;
  switch (row.kind) {
    case "top_picks":
      return t("fy.row.top_picks");
    case "because_you_rated":
      return r.media_title ? t("fy.row.because_you_rated", { title: r.media_title }) : row.title;
    case "director":
      return r.person_name ? t("fy.row.director", { name: r.person_name }) : row.title;
    case "actor":
      return r.person_name ? t("fy.row.actor", { name: r.person_name }) : row.title;
    case "genre":
      return r.genre_names.length ? t("fy.row.genre_named", { genres: genres(r) }) : t("fy.row.genre");
    case "hidden_gems":
      return t("fy.row.hidden_gems");
    case "something_different":
      return t("fy.row.something_different");
    case "trending":
      return t("fy.row.trending");
    case "rewatch":
      return t("fy.row.rewatch");
    case "popular":
      return t("fy.row.popular");
    case "ai_collection":
      return r.collection_title ? t("fy.row.ai_collection", { title: r.collection_title }) : row.title;
    case "family":
      return t("family.row");
    case "curated":
      return row.curated ? t("curated.row", { title: row.curated.title, watched: row.curated.watched, count: row.curated.count }) : row.title;
    default:
      return row.title;
  }
}

/**
 * Rows worth showing on Home: non-empty, and not the cold-start "popular"
 * fallback (Home already has popular / trending rows of its own).
 */
export function visibleRows<R extends { kind: string; items: unknown[] }>(rows: readonly R[] | undefined, coldStart: boolean): R[] {
  return (rows ?? []).filter((r) => r.items.length > 0 && !(coldStart && r.kind === "popular"));
}

/** Removes a dismissed title from every row (optimistic «Не интересно»). */
export function withoutMedia<R extends { items: { media: { id: string } }[] }>(rows: readonly R[], mediaId: string): R[] {
  return rows.map((r) => (r.items.some((i) => i.media.id === mediaId) ? { ...r, items: r.items.filter((i) => i.media.id !== mediaId) } : r)).filter((r) => r.items.length > 0);
}

// ---------------------------------------------------------------- history

export interface HistoryLike {
  media: { id: string; kind: string; title: string; original_title: string; me?: { rating: number | null } | null };
  progress: { completed: boolean; completed_at: string | null; updated_at: string; episode_id: string | null };
}

export type HistoryKind = "all" | "movie" | "series" | "rated";

export interface HistoryFilter {
  kind: HistoryKind;
  q: string;
}

/** When the entry happened: completion, else the last progress update. */
export function historyDate(h: HistoryLike): string {
  return h.progress.completed_at ?? h.progress.updated_at;
}

/** "2026-10" in UTC (the server's diary uses UTC dates too). */
export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

export function monthLabel(key: string, t: T): string {
  const [y, m] = key.split("-");
  const n = Number(m);
  return n >= 1 && n <= 12 ? `${t(`fy.month.${n}` as MessageKey)} ${y}` : key;
}

/** Lower-case, ё → е, trimmed (Russian search). */
export function normalizeSearch(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").trim();
}

export function isFiltered(f: HistoryFilter): boolean {
  return f.kind !== "all" || normalizeSearch(f.q) !== "";
}

export function matchesHistory(h: HistoryLike, f: HistoryFilter): boolean {
  if (f.kind === "movie" && h.media.kind !== "movie") return false;
  if (f.kind === "series" && h.media.kind !== "series") return false;
  if (f.kind === "rated" && h.media.me?.rating == null) return false;
  const q = normalizeSearch(f.q);
  if (!q) return true;
  return normalizeSearch(h.media.title).includes(q) || normalizeSearch(h.media.original_title).includes(q);
}

/**
 * Series episodes repeat the show in the history: keep the newest entry per
 * title (the list is newest first) so thousands of rows stay readable.
 */
export function dedupeHistory<H extends HistoryLike>(items: readonly H[]): H[] {
  const seen = new Set<string>();
  const out: H[] = [];
  for (const h of items) {
    if (seen.has(h.media.id)) continue;
    seen.add(h.media.id);
    out.push(h);
  }
  return out;
}

export interface MonthGroup<H> {
  key: string;
  items: H[];
}

/** Groups newest-first items by month, keeping order. */
export function groupByMonth<H extends HistoryLike>(items: readonly H[]): MonthGroup<H>[] {
  const groups: MonthGroup<H>[] = [];
  for (const h of items) {
    const key = monthKey(historyDate(h));
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(h);
    else groups.push({ key, items: [h] });
  }
  return groups;
}

/** Filter → dedupe → group: what the History screens show. */
export function historyView<H extends HistoryLike>(items: readonly H[], f: HistoryFilter): MonthGroup<H>[] {
  return groupByMonth(dedupeHistory(items).filter((h) => matchesHistory(h, f)));
}

/** A flat list of month headers and items (TV's virtualized list, web's windowing). */
export type HistoryLine<H> = { type: "month"; key: string; count: number } | { type: "item"; key: string; item: H };

export function historyLines<H extends HistoryLike>(groups: readonly MonthGroup<H>[]): HistoryLine<H>[] {
  const out: HistoryLine<H>[] = [];
  for (const g of groups) {
    out.push({ type: "month", key: g.key, count: g.items.length });
    for (const h of g.items) out.push({ type: "item", key: `${g.key}:${h.media.id}`, item: h });
  }
  return out;
}

// ---------------------------------------------------------------- surprise

export type RuntimeBucket = "any" | "short" | "medium" | "long";
export type SurpriseKind = "movie" | "series" | "any";

export interface SurpriseForm {
  mood: Mood | null;
  genres: number[];
  runtime: RuntimeBucket;
  decade: number | null;
  minRating: number | null;
  includeWatched: boolean;
  kind: SurpriseKind;
}

export const EMPTY_SURPRISE: SurpriseForm = { mood: null, genres: [], runtime: "any", decade: null, minRating: null, includeWatched: false, kind: "movie" };

export const RUNTIME_BUCKETS: Record<Exclude<RuntimeBucket, "any">, { min?: number; max?: number }> = {
  short: { max: 90 },
  medium: { min: 90, max: 150 },
  long: { min: 150 },
};

export interface SurpriseRequestBody {
  profile_id: string;
  mood?: Mood;
  genres?: number[];
  runtime_min?: number;
  runtime_max?: number;
  decade?: number;
  min_rating?: number;
  include_watched?: boolean;
  kind?: SurpriseKind;
  exclude_ids?: string[];
}

/** The request for POST /foryou/surprise (only set filters are sent). */
export function surpriseRequest(f: SurpriseForm, profileId: string, exclude: readonly string[] = []): SurpriseRequestBody {
  const body: SurpriseRequestBody = { profile_id: profileId, kind: f.kind };
  if (f.mood) body.mood = f.mood;
  if (f.genres.length) body.genres = f.genres.slice(0, 10);
  if (f.runtime !== "any") {
    const b = RUNTIME_BUCKETS[f.runtime];
    if (b.min !== undefined) body.runtime_min = b.min;
    if (b.max !== undefined) body.runtime_max = b.max;
  }
  if (f.decade) body.decade = f.decade;
  if (f.minRating) body.min_rating = f.minRating;
  if (f.includeWatched) body.include_watched = true;
  if (exclude.length) body.exclude_ids = exclude.slice(-200);
  return body;
}

/** Toggles a value in a small list (genre chips). */
export function toggleIn<V>(list: readonly V[], v: V): V[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

/** «✨ Заполнить по моим фильмам»: the line shown after a generation. */
export function quizGenSummary(r: { basis: { titles: number }; state: { answers: Record<string, string[]> } }, t: T): string {
  const names = (q: string) => (r.state.answers[q] ?? []).map((g) => t(`quiz.g.${g}` as MessageKey).toLowerCase()).join(", ");
  const parts = [t("quiz.gen.done", { n: r.basis.titles })];
  const like = names("genres_like");
  const dislike = names("genres_dislike");
  if (like) parts.push(t("quiz.gen.likes", { list: like }));
  if (dislike) parts.push(t("quiz.gen.dislikes", { list: dislike }));
  return parts.join(" ");
}
