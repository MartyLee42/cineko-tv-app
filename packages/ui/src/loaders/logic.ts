// Pure parts of the drawn loading styles (paws, aquarium, 88 mph, odyssey,
// balloons): how progress (monotonic 0..1, see the TV's loading.ts) maps
// onto steps, fish, the needle and balloons. Tested in logic.test.ts.
import type { SoundRecipe } from "../uiSounds";

/** The odyssey's single quiet note at 100 % (only with «Звуки интерфейса» on): a soft sine with its fifth, ~1.6 s. */
export const ODYSSEY_NOTE: SoundRecipe = {
  tones: [
    { wave: "sine", from: 261.6, to: 261.6, at: 0, dur: 1.6, gain: 0.5 },
    { wave: "sine", from: 392, to: 392, at: 0.05, dur: 1.4, gain: 0.18 },
  ],
  noise: [],
};

const clamp01 = (p: number) => (Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 0);

/** Whole steps of `total` reached at `p` (never more than total; 1 → all). */
export function stepsAt(p: number, total: number): number {
  return Math.min(total, Math.floor(clamp01(p) * total + 1e-9));
}

// ---------------------------------------------------------------- paws

/** One paw print per 5 %. */
export const PAW_STEPS = 20;

/** Paw prints on the ground at `p`. */
export function pawSteps(p: number): number {
  return stepsAt(p, PAW_STEPS);
}

/** No increase for this long: the last paw taps impatiently. */
export const STALL_MS = 4000;

/** Tracks when progress last rose (pure: feed it values, ask whether it stalls). */
export interface StallState {
  p: number;
  at: number;
}

export function stallStep(s: StallState | null, p: number, now: number): StallState {
  if (!s || p > s.p || now < s.at) return { p, at: now };
  return s;
}

/** Stalled: no rise for STALL_MS (and not finished). */
export function isStalled(s: StallState | null, now: number, ms = STALL_MS): boolean {
  return !!s && s.p < 1 && now - s.at >= ms;
}

// ---------------------------------------------------------------- aquarium

/** Fish in the bowl when it's full. */
export const FISH_TOTAL = 18;
/** At most this many fish fall at once (the rest are already swimming). */
export const FISH_FALLING = 3;

export interface Fish {
  i: number;
  /** Where it swims in the bowl, 0..1 across / up (deterministic per fish). */
  x: number;
  y: number;
  hue: number;
  /** Swims to the right (else mirrored). */
  right: boolean;
}

function hash(i: number): number {
  let h = (i + 1) * 2654435761;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** The fish that fell in by `p` (one per 1/FISH_TOTAL), placed inside the bowl. */
export function fishAt(p: number): Fish[] {
  const n = stepsAt(p, FISH_TOTAL);
  const out: Fish[] = [];
  for (let i = 0; i < n; i++) {
    const a = hash(i);
    const b = hash(i + 100);
    out.push({ i, x: 0.18 + 0.64 * a, y: 0.12 + 0.62 * b, hue: [18, 42, 190, 330, 160, 275][i % 6]!, right: hash(i + 200) > 0.5 });
  }
  return out;
}

/** The newest fish (the one the cat watches), or null. */
export function latestFish(p: number): Fish | null {
  const f = fishAt(p);
  return f.length ? f[f.length - 1]! : null;
}

/** Pupil offset (-1..1 each way) looking from an eye at (ex, ey) towards (x, y). */
export function lookAt(ex: number, ey: number, x: number, y: number): { dx: number; dy: number } {
  const vx = x - ex;
  const vy = y - ey;
  const d = Math.sqrt(vx * vx + vy * vy);
  if (d < 1e-6) return { dx: 0, dy: 0 };
  return { dx: vx / d, dy: vy / d };
}

// ---------------------------------------------------------------- 88 mph

export const MPH_TOP = 88;
/** The dial's scale: 0..DIAL_MAX mph over -120°..+120°. */
export const DIAL_MAX = 100;

export function mphAt(p: number): number {
  return Math.round(clamp01(p) * MPH_TOP);
}

/** Needle angle (degrees, 0 = straight up) for a speed. */
export function needleAngle(mph: number): number {
  const m = Math.max(0, Math.min(DIAL_MAX, mph));
  return -120 + (240 * m) / DIAL_MAX;
}

// ---------------------------------------------------------------- odyssey

/** How far the monolith has risen (0 = under the horizon, 1 = standing) — it stands before the end. */
export function monolithRise(p: number): number {
  return Math.min(1, clamp01(p) / 0.85);
}

/** 0..1 how aligned the three bodies are (1 at 100 %). */
export function alignment(p: number): number {
  const x = clamp01(p);
  return x * x;
}

// ---------------------------------------------------------------- balloons

/** Balloons tied when the house can fly (one per ~7 %). */
export const BALLOONS_TOTAL = 14;

export function balloonsAt(p: number): number {
  return stepsAt(p, BALLOONS_TOTAL);
}

/** Where balloon i sits in the bunch: x/y offsets (px, around the knot), deterministic. */
export function balloonSpot(i: number): { x: number; y: number } {
  // A dome (bottom row first, from the middle outwards), a little jitter.
  const [x, y] = BUNCH[i % BUNCH.length]!;
  return { x: x + (hash(i + 7) - 0.5) * 14, y: y + (hash(i + 9) - 0.5) * 12 };
}

const BUNCH: [number, number][] = [
  [0, 0], [64, 6], [-64, 6], [128, 22], [-128, 22],
  [32, -56], [-32, -56], [96, -42], [-96, -42],
  [0, -108], [62, -100], [-62, -100],
  [30, -156], [-30, -156],
];
