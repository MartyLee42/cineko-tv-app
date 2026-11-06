// «Уютный режим» (cozy mode), the pure part: when the warm palette and the
// Home ambience (rain on the glass / fireplace glow) are drawn, the
// precomputed particles, and the parameters of the synthesised sound.
// The layer is CozyLayer.tsx, the Web Audio engine cozyAudio.ts.

/** ProfileSettings.cozy_ambience. */
export type CozyAmbience = "rain" | "fireplace" | "off";
export const COZY_AMBIENCES: CozyAmbience[] = ["fireplace", "rain", "off"];
export type CozyPlatform = "tv" | "web";

/** How the ambience draws: animated, a still glow / still drops, or nothing. */
export type CozyRender = "full" | "static" | "none";

export interface CozyInputs {
  /** ProfileSettings.cozy_mode. */
  on: boolean;
  ambience: CozyAmbience;
  /** The ambience lives on Home only. */
  onHome: boolean;
  /** A video plays somewhere on the page. */
  playing: boolean;
  reducedMotion: boolean;
  /** TV: this TV's calm background motion. */
  calmMotion?: boolean;
}

export function cozyRender(i: CozyInputs): CozyRender {
  if (!i.on || i.ambience === "off" || !i.onHome || i.playing) return "none";
  return i.reducedMotion || i.calmMotion ? "static" : "full";
}

/** Whether the ambience's sound may play now (also needs a user gesture to start). */
export function cozySoundAllowed(i: CozyInputs & { sound: boolean; hidden: boolean }): boolean {
  return i.sound && !i.hidden && cozyRender(i) !== "none";
}

// ---------------------------------------------------------------- particles

/** Deterministic PRNG (Park–Miller), so the layer is stable across renders. */
export function cozyRng(seed: string): () => number {
  let s = 11;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) % 2147483647;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export interface CozyParticle {
  left: number; // %
  top: number; // % (drops on the glass)
  size: number; // px (streak length / spark or drop diameter)
  dur: number; // s
  delay: number; // s (negative: already running on mount)
  opacity: number;
}

/** Moving particles: rain streaks / rising sparks (TV px; phones about half). */
export function cozyCount(ambience: CozyAmbience, platform: CozyPlatform, narrow = false): { moving: number; drops: number } {
  if (ambience === "off") return { moving: 0, drops: 0 };
  const tv = platform === "tv";
  if (ambience === "rain") return { moving: tv ? 16 : narrow ? 10 : 20, drops: tv ? 6 : narrow ? 4 : 7 };
  return { moving: tv ? 7 : narrow ? 5 : 9, drops: 0 };
}

export function makeCozyParticles(ambience: CozyAmbience, platform: CozyPlatform, narrow = false): { moving: CozyParticle[]; drops: CozyParticle[] } {
  const r = cozyRng(`${ambience}:${platform}:${narrow ? "n" : "w"}`);
  const k = platform === "tv" ? 1 : 0.6;
  const n = cozyCount(ambience, platform, narrow);
  const between = (a: number, b: number) => a + r() * (b - a);
  const round = (v: number) => Math.round(v * 10) / 10;
  const moving: CozyParticle[] = [];
  for (let i = 0; i < n.moving; i++) {
    const rain = ambience === "rain";
    const dur = rain ? between(0.9, 1.6) : between(5, 9);
    moving.push({
      // Even spread with jitter; sparks keep to the middle (the hearth).
      left: rain ? Math.min(98, ((i + 0.1 + r() * 0.8) / n.moving) * 100) : 18 + ((i + r()) / n.moving) * 64,
      top: 0,
      size: Math.round((rain ? between(60, 130) : between(4, 8)) * k),
      dur: round(dur),
      delay: -round(r() * dur),
      opacity: Math.round((rain ? between(0.16, 0.34) : between(0.55, 0.95)) * 100) / 100,
    });
  }
  const drops: CozyParticle[] = [];
  for (let i = 0; i < n.drops; i++) {
    const dur = between(14, 26);
    drops.push({
      left: 4 + ((i + r() * 0.8) / n.drops) * 90,
      top: between(4, 40),
      size: Math.round(between(10, 18) * k),
      dur: round(dur),
      delay: -round(r() * dur),
      opacity: Math.round(between(0.35, 0.6) * 100) / 100,
    });
  }
  return { moving, drops };
}

// ---------------------------------------------------------------- sound

/** Master volume of the ambience (quiet: a background, not a soundtrack). */
export const COZY_VOLUME = 0.16;
/** Seconds the sound takes to fade in / out. */
export const COZY_FADE_IN = 2.5;
export const COZY_FADE_OUT = 0.35;

export type NoiseColor = "white" | "pink" | "brown";

/** A steady noise bed: looped noise through a band (high-pass → low-pass). */
export interface NoiseBed {
  color: NoiseColor;
  highpass: number; // Hz
  lowpass: number; // Hz
  gain: number;
  /** Slow swell: depth (fraction of gain) and rate (Hz). */
  swell?: { depth: number; rate: number };
}

/** Short noise bursts (raindrops ticking on the sill, fire crackles). */
export interface Bursts {
  /** Mean events per second (Poisson). */
  rate: number;
  freq: [number, number]; // band-pass centre, Hz
  gain: [number, number]; // skewed toward the low end (most are soft)
  dur: [number, number]; // s
  /** Q of the band-pass. */
  q: number;
}

export interface AmbienceMix {
  beds: NoiseBed[];
  bursts: Bursts[];
}

export const AMBIENCE_MIX: Record<Exclude<CozyAmbience, "off">, AmbienceMix> = {
  rain: {
    beds: [
      // The hiss of rain: pink noise without the extremes.
      { color: "pink", highpass: 400, lowpass: 5200, gain: 0.55, swell: { depth: 0.25, rate: 0.06 } },
      // Body: the low wash of water.
      { color: "brown", highpass: 60, lowpass: 600, gain: 0.35 },
    ],
    bursts: [{ rate: 7, freq: [2200, 5200], gain: [0.04, 0.22], dur: [0.012, 0.03], q: 2.5 }],
  },
  fireplace: {
    beds: [
      // The low roar of the flames.
      { color: "brown", highpass: 30, lowpass: 220, gain: 0.7, swell: { depth: 0.35, rate: 0.11 } },
      // A faint breath of air.
      { color: "pink", highpass: 300, lowpass: 1400, gain: 0.08 },
    ],
    bursts: [
      // Crackles…
      { rate: 3.2, freq: [1400, 4200], gain: [0.08, 0.9], dur: [0.006, 0.03], q: 1.2 },
      // …and the odd soft pop of a log.
      { rate: 0.35, freq: [300, 800], gain: [0.25, 0.6], dur: [0.04, 0.09], q: 0.9 },
    ],
  },
};

/** Fills `out` with noise of a colour (values in about −1…1). */
export function fillNoise(out: Float32Array, color: NoiseColor, rand: () => number = Math.random): Float32Array {
  // Paul Kellet's economy pink filter; brown = leaky integrated white.
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    last = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rand() * 2 - 1;
    if (color === "white") out[i] = w;
    else if (color === "pink") {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    } else {
      last = (last + 0.02 * w) / 1.02;
      out[i] = last * 3.5;
    }
  }
  // Fade the loop's ends into each other (no click at the seam).
  const edge = Math.min(256, Math.floor(out.length / 8));
  for (let i = 0; i < edge; i++) {
    const g = i / edge;
    out[i] = out[i]! * g;
    out[out.length - 1 - i] = out[out.length - 1 - i]! * g;
  }
  return out;
}

export interface BurstEvent {
  at: number; // s (AudioContext time)
  dur: number;
  freq: number;
  gain: number;
}

/**
 * The bursts to schedule in [from, until): a Poisson process (exponential
 * gaps) starting at `next` (the time the previous call stopped at). Returns
 * the events and where the next call continues.
 */
export function scheduleBursts(b: Bursts, next: number, until: number, rand: () => number = Math.random): { events: BurstEvent[]; next: number } {
  const events: BurstEvent[] = [];
  let t = next;
  const lerp = ([a, c]: [number, number], x: number) => a + (c - a) * x;
  while (t < until) {
    const g = rand();
    events.push({
      at: t,
      dur: lerp(b.dur, rand()),
      freq: Math.round(lerp(b.freq, rand())),
      // Cubed: mostly soft, now and then a louder one.
      gain: lerp(b.gain, g * g * g),
    });
    t += -Math.log(1 - rand() * 0.999) / b.rate;
  }
  return { events, next: t };
}
