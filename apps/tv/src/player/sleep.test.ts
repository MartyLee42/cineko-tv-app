import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DIM_MAX,
  DIM_MS,
  dimming,
  dimOpacity,
  dimVolume,
  due,
  EXTEND_MS,
  extendSleep,
  remainingMinutes,
  sleepAtEpisodeEnd,
  sleepChoiceOf,
  SLEEP_OFF,
  startSleep,
} from "./sleep";

describe("sleep timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 6, 23, 0, 0));
  });
  afterEach(() => vi.useRealTimers());

  it("counts down a time timer and fires at the end", () => {
    const s = startSleep(30, Date.now());
    expect(remainingMinutes(s, Date.now())).toBe(30);
    vi.advanceTimersByTime(6 * 60_000 + 1);
    expect(remainingMinutes(s, Date.now())).toBe(24);
    vi.advanceTimersByTime(24 * 60_000 - 2);
    expect(due(s, Date.now())).toBe(false);
    vi.advanceTimersByTime(1);
    expect(due(s, Date.now())).toBe(true);
    expect(remainingMinutes(SLEEP_OFF, Date.now())).toBeNull();
  });

  it("dims over the last minute only: opacity and volume ramp", () => {
    const s = startSleep(15, Date.now());
    vi.advanceTimersByTime(15 * 60_000 - DIM_MS - 1);
    expect(dimOpacity(s, Date.now())).toBe(0);
    expect(dimming(s, Date.now())).toBe(false);
    vi.advanceTimersByTime(1 + DIM_MS / 2);
    expect(dimOpacity(s, Date.now())).toBeCloseTo(DIM_MAX / 2);
    expect(dimVolume(s, Date.now())).toBeCloseTo(0.8);
    expect(dimming(s, Date.now())).toBe(true);
    vi.advanceTimersByTime(DIM_MS / 2);
    expect(dimming(s, Date.now())).toBe(false); // fired: the goodnight screen, not the dim
    expect(due(s, Date.now())).toBe(true);
  });

  it("a key during the dim extends by 10 minutes", () => {
    const s = startSleep(15, Date.now());
    const end = Date.now() + 15 * 60_000;
    vi.advanceTimersByTime(15 * 60_000 - 20_000);
    const e = extendSleep(s, Date.now());
    expect(e.mode === "time" && e.endsAt).toBe(end + EXTEND_MS);
    expect(dimOpacity(e, Date.now())).toBe(0);
    // Late (already due): counts from now.
    vi.advanceTimersByTime(25_000);
    const late = extendSleep(s, Date.now());
    expect(late.mode === "time" && late.endsAt).toBe(Date.now() + EXTEND_MS);
    expect(extendSleep(SLEEP_OFF, Date.now())).toBe(SLEEP_OFF);
  });

  it("«after this episode» stops at the end instead of the next episode", () => {
    const s = startSleep("episode", Date.now());
    expect(sleepAtEpisodeEnd(s)).toBe(true);
    vi.advanceTimersByTime(10 * 3600_000);
    expect(due(s, Date.now())).toBe(false);
    expect(remainingMinutes(s, Date.now())).toBeNull();
    expect(sleepAtEpisodeEnd(startSleep(30, Date.now()))).toBe(false);
    expect(sleepAtEpisodeEnd(SLEEP_OFF)).toBe(false);
    expect(sleepChoiceOf(s, "episode")).toBe(true);
    expect(sleepChoiceOf(SLEEP_OFF, "off")).toBe(true);
    expect(sleepChoiceOf(startSleep(30, Date.now()), 30)).toBe(false);
  });
});
