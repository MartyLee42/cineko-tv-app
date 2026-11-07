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
export function pausedSaverDue(pausedAt: number | null, lastKey: number, now: number): boolean {
  return pausedAt !== null && now - Math.max(pausedAt, lastKey) >= PAUSED_SAVER_MS;
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

export type SaverStyle = "sleep" | "dvd" | "off";
export const SAVER_STYLES: SaverStyle[] = ["sleep", "dvd", "off"];
const SAVER_KEY = "martytv.screensaver";

/** This TV's screensaver (default: the sleeping Cineko). */
export const saverPref = {
  get(): SaverStyle {
    const v = storage.get(SAVER_KEY);
    return v === "dvd" || v === "off" ? v : "sleep";
  },
  set(v: SaverStyle) {
    storage.set(SAVER_KEY, v);
  },
};

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
