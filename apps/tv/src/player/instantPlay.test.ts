import { afterEach, describe, expect, it, vi } from "vitest";
import { createWarmer, saveDataOn, warmKey, WARM_DELAY_MS, type WarmTarget } from "@martytv/media-types";

afterEach(() => vi.useRealTimers());

const movie: WarmTarget = { media_id: "m1", profile_id: "p1", release_id: "r1" };

function setup(allowed = () => true) {
  vi.useFakeTimers();
  const warm = vi.fn((_t: WarmTarget) => Promise.resolve());
  const cancel = vi.fn((_p: string) => undefined);
  const w = createWarmer({ warm, cancel, allowed });
  return { w, warm, cancel };
}

describe("instant play warmer", () => {
  it("warms once the page stayed on the same target for the delay", () => {
    const { w, warm } = setup();
    w.set(movie);
    vi.advanceTimersByTime(WARM_DELAY_MS - 1);
    expect(warm).not.toHaveBeenCalled();
    w.set({ ...movie }); // a re-render with an equal target keeps the timer
    vi.advanceTimersByTime(1);
    expect(warm).toHaveBeenCalledTimes(1);
    expect(warm).toHaveBeenCalledWith(movie);
    w.set({ ...movie });
    vi.advanceTimersByTime(WARM_DELAY_MS * 3);
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("debounces: moving on before the delay warms only the last target", () => {
    const { w, warm, cancel } = setup();
    w.set(movie);
    vi.advanceTimersByTime(1000);
    w.set({ ...movie, release_id: "r2" });
    vi.advanceTimersByTime(1000);
    expect(warm).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(warm.mock.calls.map((c) => c[0].release_id)).toEqual(["r2"]);
    expect(cancel).not.toHaveBeenCalled(); // nothing was sent before
  });

  it("cancels the sent warm on leave and on a new target, never twice", () => {
    const { w, warm, cancel } = setup();
    w.set(movie);
    vi.advanceTimersByTime(WARM_DELAY_MS);
    w.set({ ...movie, episode_id: "e2" });
    expect(cancel).toHaveBeenCalledWith("p1");
    vi.advanceTimersByTime(WARM_DELAY_MS);
    expect(warm).toHaveBeenCalledTimes(2);
    w.dispose();
    w.dispose();
    expect(cancel).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(WARM_DELAY_MS * 2);
    expect(warm).toHaveBeenCalledTimes(2);
  });

  it("leaving before the delay sends nothing", () => {
    const { w, warm, cancel } = setup();
    w.set(movie);
    vi.advanceTimersByTime(500);
    w.dispose();
    vi.advanceTimersByTime(WARM_DELAY_MS);
    expect(warm).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("skips while not allowed (playing, data saver) and retries on the next change", () => {
    let ok = false;
    const { w, warm } = setup(() => ok);
    w.set(movie);
    vi.advanceTimersByTime(WARM_DELAY_MS);
    expect(warm).not.toHaveBeenCalled();
    ok = true;
    w.set(movie);
    vi.advanceTimersByTime(WARM_DELAY_MS);
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("a failed request is swallowed", async () => {
    vi.useFakeTimers();
    const w = createWarmer({ warm: () => Promise.reject(new Error("404")), cancel: () => undefined });
    w.set(movie);
    vi.advanceTimersByTime(WARM_DELAY_MS);
    await Promise.resolve();
  });

  it("keys: the resume minute and the source count, seconds within a minute don't", () => {
    expect(warmKey({ ...movie, start_seconds: 61 })).toBe(warmKey({ ...movie, start_seconds: 119 }));
    expect(warmKey({ ...movie, start_seconds: 61 })).not.toBe(warmKey({ ...movie, start_seconds: 121 }));
    expect(warmKey({ media_id: "m1", profile_id: "p1", source_id: "s1" })).not.toBe(warmKey(movie));
  });

  it("data saver", () => {
    expect(saveDataOn({ connection: { saveData: true } })).toBe(true);
    expect(saveDataOn({})).toBe(false);
    expect(saveDataOn(undefined)).toBe(false);
  });
});
