// Interface sounds («Звуки интерфейса»): a short synthesised tick on a
// focus move and a click on OK / activation, with a character per design
// (a Win95 click, a VHS clunk, a terminal beep…). Off by default; the
// choice is per device. Pure parts here (recipes, throttle, the stored
// preference); the Web Audio player is uiSoundsAudio.ts.
import { useSyncExternalStore } from "react";
import type { DesignSetting } from "./designs";

export type UiSoundKind = "tick" | "click";

/** One oscillator voice: a pitch sweep with a fast attack and decay. */
export interface ToneVoice {
  wave: OscillatorType;
  /** Hz at the start and the end of the sweep. */
  from: number;
  to: number;
  /** Seconds (from the sound's start). */
  at: number;
  dur: number;
  /** Peak gain before the master volume. */
  gain: number;
}

/** A noise burst through a filter (clunks, clicks, typewriter strikes). */
export interface NoiseVoice {
  filter: BiquadFilterType;
  freq: number;
  q: number;
  at: number;
  dur: number;
  gain: number;
}

export interface SoundRecipe {
  tones: ToneVoice[];
  noise: NoiseVoice[];
}

/** Master volume of interface sounds: quiet, under the TV's speech level. */
export const UI_SOUND_VOLUME = 0.18;
/** Every recipe ends within this (seconds). */
export const UI_SOUND_MAX = 0.12;
/** Holding an arrow key repeats it: at most one tick this often (ms). */
export const UI_TICK_EVERY_MS = 60;

const tone = (wave: OscillatorType, from: number, to: number, dur: number, gain: number, at = 0): ToneVoice => ({ wave, from, to, at, dur, gain });
const noise = (filter: BiquadFilterType, freq: number, dur: number, gain: number, q = 1, at = 0): NoiseVoice => ({ filter, freq, q, at, dur, gain });

/** Each design's character; the tick is the quieter, shorter variant of the click. */
const RECIPES: Record<DesignSetting, Record<UiSoundKind, SoundRecipe>> = {
  // Soft neutral tick.
  kinozal: {
    tick: { tones: [tone("sine", 1800, 1500, 0.025, 0.35)], noise: [] },
    click: { tones: [tone("sine", 1200, 900, 0.05, 0.6)], noise: [noise("highpass", 3000, 0.012, 0.25)] },
  },
  projector: {
    tick: { tones: [tone("sine", 1500, 1300, 0.025, 0.35)], noise: [] },
    click: { tones: [tone("triangle", 1000, 760, 0.05, 0.55)], noise: [noise("highpass", 2500, 0.012, 0.2)] },
  },
  // Terminal beep.
  terminal: {
    tick: { tones: [tone("square", 1760, 1760, 0.022, 0.18)], noise: [] },
    click: { tones: [tone("square", 880, 880, 0.06, 0.22)], noise: [] },
  },
  cyberpunk: {
    tick: { tones: [tone("square", 2093, 2400, 0.022, 0.16)], noise: [] },
    click: { tones: [tone("sawtooth", 660, 1320, 0.06, 0.2), tone("square", 1320, 1320, 0.03, 0.12, 0.03)], noise: [] },
  },
  // The terminal beep, a little lower and rounder («greener»).
  matrix: {
    tick: { tones: [tone("square", 1318, 1318, 0.022, 0.15), tone("sine", 2636, 2636, 0.015, 0.08)], noise: [] },
    click: { tones: [tone("square", 659, 659, 0.07, 0.2), tone("sine", 1318, 988, 0.05, 0.12, 0.02)], noise: [] },
  },
  // Synth blip.
  wireframe: {
    tick: { tones: [tone("sawtooth", 880, 1320, 0.03, 0.14)], noise: [] },
    click: { tones: [tone("sawtooth", 440, 880, 0.07, 0.18), tone("triangle", 880, 1760, 0.05, 0.12, 0.02)], noise: [] },
  },
  // Soft bell-ish ping (a fifth and an octave of a high partial).
  deco: {
    tick: { tones: [tone("sine", 2637, 2637, 0.06, 0.18), tone("sine", 3951, 3951, 0.04, 0.08)], noise: [] },
    click: { tones: [tone("sine", 1760, 1760, 0.11, 0.3), tone("sine", 2637, 2637, 0.09, 0.15), tone("sine", 3520, 3520, 0.06, 0.08)], noise: [] },
  },
  // VHS clunk: a low thud and a noise burst.
  retro80: {
    tick: { tones: [tone("sine", 160, 90, 0.04, 0.5)], noise: [noise("lowpass", 900, 0.03, 0.25)] },
    click: { tones: [tone("sine", 120, 55, 0.09, 0.8)], noise: [noise("bandpass", 600, 0.06, 0.45, 0.8), noise("highpass", 2500, 0.02, 0.2, 1, 0.05)] },
  },
  // Win95 click: a short square blip and a noise transient.
  retro90: {
    tick: { tones: [tone("square", 1000, 1000, 0.012, 0.18)], noise: [noise("highpass", 4000, 0.008, 0.3)] },
    click: { tones: [tone("square", 700, 700, 0.018, 0.22)], noise: [noise("bandpass", 3000, 0.015, 0.45, 1.5)] },
  },
  // Cartoon pop: a fast upward sweep.
  popart: {
    tick: { tones: [tone("sine", 600, 1400, 0.035, 0.35)], noise: [] },
    click: { tones: [tone("sine", 300, 1600, 0.06, 0.55), tone("triangle", 1600, 2200, 0.03, 0.15, 0.04)], noise: [] },
  },
  // Typewriter: a dry strike, a carriage tock on OK.
  constructivism: {
    tick: { tones: [], noise: [noise("bandpass", 2400, 0.018, 0.5, 2)] },
    click: { tones: [tone("triangle", 320, 220, 0.04, 0.25)], noise: [noise("bandpass", 1800, 0.025, 0.6, 2), noise("highpass", 3500, 0.012, 0.3, 1, 0.03)] },
  },
  // A soft paper «flick» and a sticker press (projector's sine, softer).
  stickerbook: {
    tick: { tones: [tone("sine", 1200, 1000, 0.02, 0.25)], noise: [noise("highpass", 3000, 0.01, 0.12)] },
    click: { tones: [tone("sine", 700, 520, 0.05, 0.45)], noise: [noise("highpass", 2200, 0.015, 0.18)] },
  },
  // A toy LCD chirp.
  pocketpet: {
    tick: { tones: [tone("square", 2637, 2637, 0.018, 0.12)], noise: [] },
    click: { tones: [tone("square", 1568, 2093, 0.05, 0.16)], noise: [] },
  },
  // A typewriter: a dry key strike; OK adds the carriage bell.
  noir: {
    tick: { tones: [], noise: [noise("bandpass", 3200, 0.014, 0.45, 3), noise("lowpass", 500, 0.02, 0.25)] },
    click: { tones: [tone("sine", 2350, 2330, 0.09, 0.22, 0.02)], noise: [noise("bandpass", 2600, 0.016, 0.55, 3), noise("lowpass", 420, 0.025, 0.35)] },
  },
  // A splice on the editing table: a short snap, OK a firmer cut.
  vague: {
    tick: { tones: [], noise: [noise("highpass", 4200, 0.008, 0.35)] },
    click: { tones: [tone("triangle", 240, 140, 0.035, 0.3)], noise: [noise("highpass", 3800, 0.01, 0.4), noise("bandpass", 1400, 0.02, 0.3, 2, 0.025)] },
  },
};

/** The recipe of `kind` for a design (unknown designs → Кинозал). */
export function uiSoundRecipe(design: string | null | undefined, kind: UiSoundKind): SoundRecipe {
  const r = RECIPES[(design ?? "kinozal") as DesignSetting] ?? RECIPES.kinozal;
  return r[kind];
}

/** Length of a recipe in seconds (the last voice's end). */
export function recipeLength(r: SoundRecipe): number {
  let end = 0;
  for (const v of [...r.tones, ...r.noise]) end = Math.max(end, v.at + v.dur);
  return end;
}

/** A gate letting one event through per `everyMs` (key repeat while holding an arrow). */
export function makeThrottle(everyMs: number): (now: number) => boolean {
  let last = -Infinity;
  return (now) => {
    if (now - last < everyMs) return false;
    last = now;
    return true;
  };
}

/** Which key on a remote / keyboard makes which sound (null: none). */
export function uiSoundForKey(key: string): UiSoundKind | null {
  if (key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight") return "tick";
  if (key === "Enter" || key === " ") return "click";
  return null;
}

// ---------------------------------------------------------------- the device-local choice

const KEY = "martytv.uiSounds";
const listeners = new Set<() => void>();

/** Interface sounds on this device (default off). */
export const uiSoundsPref = {
  get(): boolean {
    try {
      return localStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  },
  set(on: boolean) {
    try {
      localStorage.setItem(KEY, on ? "1" : "0");
    } catch {
      /* private mode */
    }
    listeners.forEach((l) => l());
  },
};

export function useUiSoundsPref(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => uiSoundsPref.get(),
    () => false,
  );
}
