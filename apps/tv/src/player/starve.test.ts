import { describe, expect, it } from "vitest";
import { keyReopens, shouldReopen, spinnerWanted, stallWatch0, watchStep, type StallWatch } from "./starve";

/** Ticks every 500 ms from `from` to `to` with the same observation. */
function run(w: StallWatch, from: number, to: number, o: { wants: boolean; advancing: boolean; end: number }): StallWatch {
  for (let now = from; now <= to; now += 500) w = watchStep(w, { ...o, now });
  return w;
}

describe("stall watchdog", () => {
  it("a dead connection mid-film (nothing moves, no data) is reopened after 12 s", () => {
    let w = run(stallWatch0(0), 0, 10_000, { wants: true, advancing: true, end: 30 });
    w = run(w, 10_500, 21_500, { wants: true, advancing: false, end: 33 });
    expect(shouldReopen(w, { now: 21_500, resumedAgoMs: 1e9, rebufferMs: null })).toBe(false);
    w = run(w, 22_000, 22_500, { wants: true, advancing: false, end: 33 });
    expect(shouldReopen(w, { now: 22_500, resumedAgoMs: 1e9, rebufferMs: 11_000 })).toBe(true);
  });
  it("data still arriving (a slow torrent) is no dead stream; the viewer's pause never is", () => {
    let w = stallWatch0(0);
    for (let now = 0, end = 10; now <= 40_000; now += 500, end += 0.2) w = watchStep(w, { wants: true, advancing: false, end, now });
    expect(shouldReopen(w, { now: 40_000, resumedAgoMs: 1e9, rebufferMs: 30_000 })).toBe(false);
    const p = run(stallWatch0(0), 0, 600_000, { wants: false, advancing: false, end: 10 });
    expect(shouldReopen(p, { now: 600_000, resumedAgoMs: 1e9, rebufferMs: null })).toBe(false);
  });
  it("reopens in a row wait longer each time (12, 24, 36 … ≤ 60 s)", () => {
    const w = { end: 10, progressAt: 0, movedAt: 0 };
    expect(shouldReopen(w, { now: 23_000, resumedAgoMs: 1e9, rebufferMs: null, tries: 1 })).toBe(false);
    expect(shouldReopen(w, { now: 24_000, resumedAgoMs: 1e9, rebufferMs: null, tries: 1 })).toBe(true);
    expect(shouldReopen(w, { now: 59_000, resumedAgoMs: 1_000, rebufferMs: null, tries: 9 })).toBe(false);
    expect(shouldReopen(w, { now: 60_000, resumedAgoMs: 1_000, rebufferMs: null, tries: 9 })).toBe(true);
  });
  it("a «Буферизация» that trickles on for 45 s gives up and reopens", () => {
    const w = { end: 10, progressAt: 44_900, movedAt: 0 };
    expect(shouldReopen(w, { now: 45_000, resumedAgoMs: 1e9, rebufferMs: 44_000 })).toBe(false);
    expect(shouldReopen(w, { now: 45_000, resumedAgoMs: 1e9, rebufferMs: 45_000 })).toBe(true);
  });
  it("right after resuming a pause, 5 s of nothing is enough", () => {
    // Paused for 10 min (no clock running), then ▶ at 600 s: no data, no picture.
    let w = run(stallWatch0(0), 0, 600_000, { wants: false, advancing: false, end: 50 });
    w = run(w, 600_500, 604_500, { wants: true, advancing: false, end: 50 });
    expect(shouldReopen(w, { now: 604_500, resumedAgoMs: 4_500, rebufferMs: 4_000 })).toBe(false);
    expect(shouldReopen(w, { now: 604_500, resumedAgoMs: 1e9, rebufferMs: 4_000 })).toBe(false);
    w = run(w, 605_000, 605_000, { wants: true, advancing: false, end: 50 });
    expect(shouldReopen(w, { now: 605_000, resumedAgoMs: 5_000, rebufferMs: 4_500 })).toBe(true);
  });
});

describe("OK / ▶ on a stuck picture", () => {
  it("reopens once the picture stood still 2.5 s with no data (or a wedged ready engine)", () => {
    const w = { end: 10, progressAt: 0, movedAt: 0 };
    expect(keyReopens(w, { now: 2_000, readyState: 2 })).toBe(false);
    expect(keyReopens(w, { now: 2_500, readyState: 2 })).toBe(true);
    expect(keyReopens(w, { now: 2_500, readyState: 4 })).toBe(true);
    // Data is coming in: let it play (the rebuffer's OK plays what is there).
    expect(keyReopens({ end: 10, progressAt: 2_400, movedAt: 0 }, { now: 2_500, readyState: 2 })).toBe(false);
  });
});

describe("the buffering spinner", () => {
  const base = { userPaused: false, advancing: false, seeking: false, readyState: 2, quiet: false, stuckMs: 0 };
  it("never over a moving picture or the viewer's pause", () => {
    expect(spinnerWanted({ ...base, advancing: true })).toBe(false);
    expect(spinnerWanted({ ...base, advancing: true, readyState: 1, seeking: true })).toBe(false);
    expect(spinnerWanted({ ...base, userPaused: true, stuckMs: 60_000 })).toBe(false);
  });
  it("at once while seeking / not ready; a frozen «ready» picture after 1.5 s", () => {
    expect(spinnerWanted(base)).toBe(true);
    expect(spinnerWanted({ ...base, seeking: true, readyState: 4 })).toBe(true);
    expect(spinnerWanted({ ...base, readyState: 4, stuckMs: 1_000 })).toBe(false);
    expect(spinnerWanted({ ...base, readyState: 4, stuckMs: 1_500 })).toBe(true);
  });
  it("after a played-out «Буферизация» a short stall stays quiet, a long one shows the spinner", () => {
    expect(spinnerWanted({ ...base, quiet: true, stuckMs: 2_000 })).toBe(false);
    expect(spinnerWanted({ ...base, quiet: true, stuckMs: 3_000 })).toBe(true);
    expect(spinnerWanted({ ...base, quiet: true, seeking: true })).toBe(true);
  });
});
