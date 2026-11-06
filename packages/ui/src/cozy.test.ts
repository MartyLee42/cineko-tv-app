import { describe, expect, it } from "vitest";
import {
  AMBIENCE_MIX,
  COZY_AMBIENCES,
  COZY_VOLUME,
  cozyCount,
  cozyRender,
  cozyRng,
  cozySoundAllowed,
  fillNoise,
  makeCozyParticles,
  scheduleBursts,
  type CozyInputs,
} from "./cozy";

const base: CozyInputs = { on: true, ambience: "fireplace", onHome: true, playing: false, reducedMotion: false };

describe("cozy render", () => {
  it("draws on Home only, never during playback, off with the setting", () => {
    expect(cozyRender(base)).toBe("full");
    expect(cozyRender({ ...base, on: false })).toBe("none");
    expect(cozyRender({ ...base, ambience: "off" })).toBe("none");
    expect(cozyRender({ ...base, onHome: false })).toBe("none");
    expect(cozyRender({ ...base, playing: true })).toBe("none");
  });
  it("holds still with reduced or calm motion", () => {
    expect(cozyRender({ ...base, reducedMotion: true })).toBe("static");
    expect(cozyRender({ ...base, ambience: "rain", calmMotion: true })).toBe("static");
  });
  it("sound needs its own switch and a visible page", () => {
    expect(cozySoundAllowed({ ...base, sound: true, hidden: false })).toBe(true);
    expect(cozySoundAllowed({ ...base, sound: false, hidden: false })).toBe(false);
    expect(cozySoundAllowed({ ...base, sound: true, hidden: true })).toBe(false);
    expect(cozySoundAllowed({ ...base, sound: true, hidden: false, playing: true })).toBe(false);
    expect(cozySoundAllowed({ ...base, sound: true, hidden: false, onHome: false })).toBe(false);
    // Reduced motion stills the picture but may keep the sound.
    expect(cozySoundAllowed({ ...base, sound: true, hidden: false, reducedMotion: true })).toBe(true);
  });
  it("lists every ambience once", () => {
    expect(new Set(COZY_AMBIENCES)).toEqual(new Set(["rain", "fireplace", "off"]));
  });
});

describe("cozy particles", () => {
  it("stays within the TV budget and fewer on phones", () => {
    for (const a of ["rain", "fireplace"] as const) {
      const tv = cozyCount(a, "tv");
      expect(tv.moving + tv.drops).toBeLessThanOrEqual(24);
      expect(cozyCount(a, "web", true).moving).toBeLessThan(cozyCount(a, "web").moving);
    }
    expect(cozyCount("off", "tv")).toEqual({ moving: 0, drops: 0 });
  });
  it("is deterministic and on screen", () => {
    const a = makeCozyParticles("rain", "tv");
    expect(makeCozyParticles("rain", "tv")).toEqual(a);
    expect(a.moving).toHaveLength(cozyCount("rain", "tv").moving);
    expect(a.drops).toHaveLength(cozyCount("rain", "tv").drops);
    for (const p of [...a.moving, ...a.drops, ...makeCozyParticles("fireplace", "web").moving]) {
      expect(p.left).toBeGreaterThanOrEqual(0);
      expect(p.left).toBeLessThanOrEqual(100);
      expect(p.delay).toBeLessThanOrEqual(0);
      expect(-p.delay).toBeLessThanOrEqual(p.dur);
      expect(p.opacity).toBeGreaterThan(0);
      expect(p.opacity).toBeLessThanOrEqual(1);
    }
    expect(makeCozyParticles("fireplace", "tv").drops).toHaveLength(0);
  });
});

describe("cozy sound", () => {
  it("is quiet and well-formed", () => {
    expect(COZY_VOLUME).toBeGreaterThan(0);
    expect(COZY_VOLUME).toBeLessThanOrEqual(0.25);
    for (const mix of Object.values(AMBIENCE_MIX)) {
      for (const bed of mix.beds) {
        expect(bed.highpass).toBeLessThan(bed.lowpass);
        expect(bed.gain).toBeLessThanOrEqual(1);
        if (bed.swell) expect(bed.swell.depth).toBeLessThan(1);
      }
      for (const b of mix.bursts) {
        expect(b.rate).toBeGreaterThan(0);
        expect(b.freq[0]).toBeLessThan(b.freq[1]);
        expect(b.gain[1]).toBeLessThanOrEqual(1);
        expect(b.dur[1]).toBeLessThan(0.2);
      }
    }
  });

  it("fills noise of every colour within range, faded at the loop seam", () => {
    for (const color of ["white", "pink", "brown"] as const) {
      const out = fillNoise(new Float32Array(4096), color, cozyRng(color));
      let peak = 0;
      for (const v of out) peak = Math.max(peak, Math.abs(v));
      expect(peak).toBeGreaterThan(0.01);
      expect(peak).toBeLessThanOrEqual(1.5);
      expect(Math.abs(out[0]!)).toBe(0);
      expect(Math.abs(out[out.length - 1]!)).toBeLessThan(0.05);
    }
  });

  it("schedules bursts as a Poisson process in the window", () => {
    const b = AMBIENCE_MIX.fireplace.bursts[0]!;
    const rand = cozyRng("bursts");
    let next = 0;
    const all = [];
    // Many short windows, like the 250 ms scheduler tick.
    for (let until = 0.6; until <= 600; until += 0.25) {
      const r = scheduleBursts(b, next, until, rand);
      for (const e of r.events) {
        expect(e.at).toBeGreaterThanOrEqual(next);
        expect(e.at).toBeLessThan(until);
        expect(e.freq).toBeGreaterThanOrEqual(b.freq[0]);
        expect(e.freq).toBeLessThanOrEqual(b.freq[1]);
        expect(e.gain).toBeGreaterThanOrEqual(b.gain[0]);
        expect(e.gain).toBeLessThanOrEqual(b.gain[1]);
        expect(e.dur).toBeGreaterThanOrEqual(b.dur[0]);
        expect(e.dur).toBeLessThanOrEqual(b.dur[1]);
      }
      expect(r.next).toBeGreaterThanOrEqual(until);
      all.push(...r.events);
      next = r.next;
    }
    // Times strictly increase across windows (no event scheduled twice).
    for (let i = 1; i < all.length; i++) expect(all[i]!.at).toBeGreaterThan(all[i - 1]!.at);
    // About `rate` per second over ten minutes.
    expect(all.length / 600).toBeGreaterThan(b.rate * 0.85);
    expect(all.length / 600).toBeLessThan(b.rate * 1.15);
    // Mostly soft: the median is well under the midpoint.
    const gains = all.map((e) => e.gain).sort((x, y) => x - y);
    expect(gains[Math.floor(gains.length / 2)]!).toBeLessThan((b.gain[0] + b.gain[1]) / 2);
  });

  it("returns nothing when the window is already covered", () => {
    expect(scheduleBursts(AMBIENCE_MIX.rain.bursts[0]!, 5, 4)).toEqual({ events: [], next: 5 });
  });
});
