// The steps of «Поезд прибывает» and «Журавлик» (pure; metroLoaders.test.ts).
import type { LoadStage } from "./loading";

/** Which station a load stage has reached (0…3). */
export function stationOf(stage: LoadStage): number {
  switch (stage) {
    case "resolving":
    case "searching":
      return 0;
    case "creating":
    case "metadata":
      return 1;
    case "preloading":
      return 2;
    default:
      return 3;
  }
}

/** Lamp speeds, slow to a blur: few steps on purpose (a new duration restarts the loop, so it changes rarely). */
const LAMP_SECONDS = [1.6, 1.2, 0.85, 0.55, 0.32] as const;

/** Seconds one lamp period takes to rush past the window at progress `p`. */
export function lampSeconds(p: number): number {
  const i = Math.floor(Math.min(0.999, Math.max(0, p)) * LAMP_SECONDS.length);
  return LAMP_SECONDS[i]!;
}

/** Progress at which each fold is reached: square → triangle → square base → bird base → crane. */
const FOLDS = [0, 0.2, 0.4, 0.62, 0.85] as const;

/** The fold shown at progress `p` (0…4); the crane once done. */
export function foldOf(p: number, done: boolean): number {
  if (done) return FOLDS.length - 1;
  let f = 0;
  for (let i = 0; i < FOLDS.length; i++) if (p >= FOLDS[i]!) f = i;
  return f;
}

/** «Спектральный скан»: how many of `steps` equal slices of the spectral band are lit at progress `p` (all once done). */
export function scanReveal(p: number, done: boolean, steps = 24): number {
  if (done) return 1;
  return Math.floor(Math.min(1, Math.max(0, p)) * steps) / steps;
}

/** «Спектральный скан»: the oscilloscope's bloom grows a little with progress and opens fully at 100 %. */
export function scanBloom(p: number, done: boolean): number {
  if (done) return 1;
  return +(0.12 + scanReveal(p, false, 8) * 0.38).toFixed(3);
}
