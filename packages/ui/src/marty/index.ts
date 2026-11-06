// Marty: the neon robot-cat mascot (brand refresh, Oct 2026). Static moods
// cut from the sticker pack, plus the idle loop (animated WebP, ~170 KB —
// only used where the mascot is big).
import idle from "./idle.webp";
import idleAnim from "./idle-anim.webp";
import happy from "./happy.webp";
import excited from "./excited.webp";
import love from "./love.webp";
import music from "./music.webp";
import sleepy from "./sleepy.webp";
import thinking from "./thinking.webp";
import surprised from "./surprised.webp";
import error from "./error.webp";
import loading from "./loading.webp";
import popcorn from "./popcorn.webp";
import laptop from "./laptop.webp";
import rain from "./rain.webp";
import run from "./run.webp";
import sly from "./sly.webp";
import favicon from "./favicon.png";
import mayakovsky from "./mayakovsky.webp";
import popcornAnim from "./popcorn-anim.webp";
import sleepyAnim from "./sleepy-anim.webp";
import loadingAnim from "./loading-anim.webp";
import thinkingAnim from "./thinking-anim.webp";
import happyAnim from "./happy-anim.webp";

export const MARTY_MOODS = {
  idle,
  happy,
  excited,
  love,
  music,
  sleepy,
  thinking,
  surprised,
  error,
  loading,
  popcorn,
  laptop,
  rain,
  run,
  sly,
} as const;

export type MascotMood = keyof typeof MARTY_MOODS;

export const MARTY_IDLE_ANIMATED = idleAnim;

/** Moods with a looping animation (~100–170 KB each; loaded only when shown animated). */
export const MARTY_ANIMATED: Partial<Record<MascotMood, string>> = {
  idle: idleAnim,
  popcorn: popcornAnim,
  sleepy: sleepyAnim,
  loading: loadingAnim,
  thinking: thinkingAnim,
  happy: happyAnim,
};
export const MARTY_FAVICON = favicon;

/**
 * «Конструктивизм»'s mascot: a Rodchenko-style stencil portrait of
 * Mayakovsky (cream on the design's red, 378×499, ~6 KB lossless WebP).
 */
export const MAYAKOVSKY = mayakovsky;
