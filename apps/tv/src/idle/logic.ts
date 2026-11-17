// Home's idle extras (pure): when the déjà-vu cat walks and the screensaver
// starts, the secret remote code, the DVD logo's bounce, and this TV's
// screensaver choice (Settings → «Заставка», device-local).
import { storage } from "../platform";

/** No key on Home this long: the black cat walks by (twice — a déjà vu). */
export const CAT_AFTER_MS = 2 * 60_000;
/** No key on Home this long: the screensaver. */
export const SAVER_AFTER_MS = 10 * 60_000;

/** A video paused this long (no key either): the screensaver over the player. */
export const PAUSED_SAVER_MS = 5 * 60_000;

export type IdlePhase = "none" | "cat" | "saver";

/**
 * Whether the paused-player screensaver is due: paused since `pausedAt`
 * (null while playing), no key since `lastKey`.
 */
export function pausedSaverDue(pausedAt: number | null, lastKey: number, now: number, after = PAUSED_SAVER_MS): boolean {
  return pausedAt !== null && now - Math.max(pausedAt, lastKey) >= after;
}

/** PAUSED_SAVER_MS (e2e tests may shorten it). */
export function pausedSaverMs(): number {
  const o = (globalThis as { __martytvPausedSaverMs?: number }).__martytvPausedSaverMs;
  return typeof o === "number" ? o : PAUSED_SAVER_MS;
}

/**
 * What Home shows after `idleMs` without a key. The cat walks once per idle
 * period (`catDone` once it has); the screensaver wins from SAVER_AFTER_MS.
 */
export function idlePhase(idleMs: number, catDone: boolean, o: { cat: boolean; saver: boolean }): IdlePhase {
  if (o.saver && idleMs >= SAVER_AFTER_MS) return "saver";
  if (o.cat && !catDone && idleMs >= CAT_AFTER_MS) return "cat";
  return "none";
}

// ---------------------------------------------------------------- screensaver choice

export type SaverStyle = "sleep" | "dvd" | "fireworks" | "posters" | "snow" | "random" | "off";
export const SAVER_STYLES: SaverStyle[] = ["sleep", "dvd", "fireworks", "posters", "snow", "random", "off"];
/** What can actually be on screen («Случайная» picks one of these). */
export type ShownSaver = Exclude<SaverStyle, "random" | "off">;
export const SHOWN_SAVERS: readonly ShownSaver[] = ["sleep", "dvd", "fireworks", "posters", "snow"];
const SAVER_KEY = "martytv.screensaver";
const LAST_KEY = "martytv.screensaver_last";

/** This TV's screensaver (default: the sleeping Cineko). */
export const saverPref = {
  get(): SaverStyle {
    const v = storage.get(SAVER_KEY);
    return (SAVER_STYLES as readonly string[]).includes(v ?? "") ? (v as SaverStyle) : "sleep";
  },
  set(v: SaverStyle) {
    storage.set(SAVER_KEY, v);
  },
};

/** The saver a setting shows: «Случайная» never repeats the previous one (`r` in [0, 1)). */
export function resolveSaver(pref: SaverStyle, last: string | null, r: number): ShownSaver {
  if (pref !== "random") return pref === "off" ? "sleep" : pref;
  const pool = SHOWN_SAVERS.filter((s) => s !== last);
  return pool[Math.min(pool.length - 1, Math.floor(Math.max(0, r) * pool.length))]!;
}

/** Picks the saver for this time and remembers it (for «Случайная»). */
export function nextSaver(): ShownSaver {
  const s = resolveSaver(saverPref.get(), storage.get(LAST_KEY), Math.random());
  storage.set(LAST_KEY, s);
  return s;
}

// ---------------------------------------------------------------- secret code

export type CodeKey = "up" | "down" | "left" | "right" | "ok";
/** ↑↑↓↓←→←→ OK. */
export const SECRET: readonly CodeKey[] = ["up", "up", "down", "down", "left", "right", "left", "right", "ok"];

/** A remote key as a code step (arrows, OK / Enter), null for anything else. */
export function codeKey(e: { key?: string; keyCode?: number }): CodeKey | null {
  switch (e.key) {
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "Enter":
      return "ok";
  }
  switch (e.keyCode) {
    case 38:
      return "up";
    case 40:
      return "down";
    case 37:
      return "left";
    case 39:
      return "right";
    case 13:
      return "ok";
  }
  return null;
}

/** Feeds keys; `push` returns true when the last keys spell the code. */
export class CodeMatcher {
  private seq: CodeKey[] = [];
  push(k: CodeKey | null): boolean {
    if (k === null) {
      this.seq = [];
      return false;
    }
    this.seq = [...this.seq, k].slice(-SECRET.length);
    if (this.seq.length === SECRET.length && this.seq.every((x, i) => x === SECRET[i])) {
      this.seq = [];
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------- DVD logo

/** The colours the DVD logo cycles through, one per bounce. */
export const DVD_COLORS = ["#ff4f4f", "#ffd23a", "#4fff8a", "#3ce8ff", "#7a6bff", "#ff4fd8", "#ffffff"];

// ---------------------------------------------------------------- «Салют»

/** The firework colours (bright on black). */
export const FIREWORK_COLORS = ["#ff4f6d", "#ffd23a", "#5cff8f", "#46d9ff", "#a77bff", "#ff8a3d", "#ffffff"];

export interface Burst {
  /** Where it bursts (px, 1920 × 1080; kept over the skyline and off the edges). */
  x: number;
  y: number;
  color: string;
  /** Spark ring radius (px). */
  r: number;
  /** «CINEKO» in sparks instead of a ring. */
  word: boolean;
}

/** The `n`-th burst of a slot from a random source (pure for given numbers; every 7th of slot 0 spells the name). */
export function burstOf(slot: number, n: number, rand: () => number): Burst {
  const x = Math.round(260 + rand() * 1400);
  const y = Math.round(150 + rand() * 430);
  const color = FIREWORK_COLORS[Math.floor(rand() * FIREWORK_COLORS.length)]!;
  const r = Math.round(150 + rand() * 110);
  return { x, y, color, r, word: slot === 0 && n % 7 === 6 };
}

// ---------------------------------------------------------------- «Афиша»

export interface PosterItem {
  id: string;
  title: string;
  poster_path: string | null;
  backdrop_path?: string | null;
  year?: number | null;
  /** The object as cached (Details gets it as its preview). */
  media?: unknown;
}

/**
 * The titles «Афиша» shows: everything with a poster found in what the TV
 * already loaded (rows, lists, watchlist…), deduped, at most `max`, shuffled
 * by `rand` — no extra requests.
 */
export function posterPool(data: unknown[], rand: () => number, max = 60): PosterItem[] {
  const seen = new Set<string>();
  const out: PosterItem[] = [];
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 5 || out.length >= 400) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const m = v as Partial<PosterItem>;
    if (typeof m.id === "string" && typeof m.title === "string" && typeof m.poster_path === "string" && m.poster_path) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        out.push({ id: m.id, title: m.title, poster_path: m.poster_path, backdrop_path: m.backdrop_path ?? null, year: m.year ?? null, media: v });
      }
      return;
    }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  for (const d of data) walk(d, 0);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out.slice(0, max);
}
