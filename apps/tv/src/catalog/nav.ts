// Screen stack for the signed-in TV area (Home / Search / Browse / Details).
import type { IptvChannel, MediaKind, MediaSummary } from "@martytv/contracts";

export type Route =
  | { name: "home" }
  /** «ТВ»: live channels (IPTV). */
  | { name: "tv" }
  /** «Программа на сегодня» of a live channel. */
  | { name: "tv-day"; channel: IptvChannel }
  /** «Видео» (YouTube): rows, its search and a channel's page. */
  | { name: "video" }
  | { name: "video-search" }
  | { name: "video-channel"; id: string; title: string }
  | { name: "search" }
  | { name: "mine" }
  | { name: "messages" }
  | { name: "browse"; kind: MediaKind }
  | { name: "explore" }
  | { name: "surprise" }
  /** «Спросить ИИ». */
  | { name: "ask" }
  | { name: "history" }
  /** «Новые серии»: new episodes of the profile's series (nightly check). */
  | { name: "new-episodes" }
  /** An Explore tile's titles (`/foryou/browse?tile=`). */
  | { name: "tile"; tile: string; title: string }
  /** An AI collection (подборка). */
  | { name: "collection"; id: string; title?: string }
  /** A curated list («Подборки»: GET /curated/{id}). */
  | { name: "curated"; id: string; title?: string }
  /** An actor's / director's films and series (OK on a cast card). */
  | { name: "person"; tmdbId: number; title: string }
  | {
      name: "details";
      id: string;
      preview?: MediaSummary;
      /** Series: season to preselect / episode to focus (remote media.open). */
      season?: number;
      episode?: number;
      /** Where Details was opened from (Кинозал's «Назад — к ряду …», Терминал's breadcrumb). */
      from?: string;
    };

/**
 * Per-entry memory a screen uses to restore itself when it becomes the top
 * of the stack again: the focused element, row/grid indexes, typed query…
 * Kept outside React state on purpose: writing it must not re-render.
 */
export class RouteMemory {
  private values = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  set(key: string, value: unknown): void {
    this.values.set(key, value);
  }
  /** Focus key to restore when the screen is shown again. */
  get focusKey(): string | undefined {
    return this.get<string>("focusKey");
  }
}

export interface StackEntry {
  key: number;
  route: Route;
  mem: RouteMemory;
}

let nextKey = 1;

export function entry(route: Route): StackEntry {
  return { key: nextKey++, route, mem: new RouteMemory() };
}

export function initialStack(): StackEntry[] {
  return [entry({ name: "home" })];
}

export function push(stack: StackEntry[], route: Route): StackEntry[] {
  return [...stack, entry(route)];
}

/** Pops one entry; the root (Home) is never popped. */
export function pop(stack: StackEntry[]): StackEntry[] {
  return stack.length > 1 ? stack.slice(0, -1) : stack;
}

/**
 * Opens Details from outside the catalog (a phone's media.open): pushed on
 * top so Back returns to where the user was. If Details for the same title is
 * already on top it is replaced (fresh entry, new season/episode) instead of
 * stacking a duplicate.
 */
export function openDetails(stack: StackEntry[], req: { id: string; season?: number; episode?: number }): StackEntry[] {
  const route: Route = { name: "details", id: req.id };
  if (req.season !== undefined) route.season = req.season;
  if (req.episode !== undefined) route.episode = req.episode;
  const top = stack[stack.length - 1]!;
  if (top.route.name === "details" && top.route.id === req.id) {
    if (top.route.preview) route.preview = top.route.preview;
    return [...stack.slice(0, -1), entry(route)];
  }
  const next = push(stack, route);
  // Many remote opens in a row: keep Home plus the most recent screens.
  return next.length > MAX_DEPTH ? [next[0]!, ...next.slice(next.length - MAX_DEPTH + 1)] : next;
}

const MAX_DEPTH = 20;

/** Opening a menu section: Home is always the root so Back returns to it. */
export function openSection(stack: StackEntry[], route: Route): StackEntry[] {
  const top = stack[stack.length - 1]!;
  if (sameRoute(top.route, route)) return stack;
  if (route.name === "home") return [stack[0]!];
  return [stack[0]!, entry(route)];
}

export function sameRoute(a: Route, b: Route): boolean {
  if (a.name !== b.name) return false;
  if (a.name === "browse" && b.name === "browse") return a.kind === b.kind;
  if (a.name === "details" && b.name === "details") return a.id === b.id;
  if (a.name === "tile" && b.name === "tile") return a.tile === b.tile;
  if (a.name === "collection" && b.name === "collection") return a.id === b.id;
  if (a.name === "curated" && b.name === "curated") return a.id === b.id;
  if (a.name === "video-channel" && b.name === "video-channel") return a.id === b.id;
  return true;
}
