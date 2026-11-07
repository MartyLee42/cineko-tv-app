import { describe, expect, it, vi } from "vitest";
import { Hold, LONG_PRESS_MS } from "./hold";

describe("Hold (OK tap vs hold)", () => {
  it("a quick tap is a short press; the long action never fires", () => {
    vi.useFakeTimers();
    const long = vi.fn();
    const h = new Hold();
    h.down(long);
    vi.advanceTimersByTime(LONG_PRESS_MS - 100);
    expect(h.up()).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(long).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("holding fires the long action once (repeats ignored) and the release is not a press", () => {
    vi.useFakeTimers();
    const long = vi.fn();
    const h = new Hold();
    h.down(long);
    vi.advanceTimersByTime(300);
    h.down(long); // auto-repeat
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(long).toHaveBeenCalledTimes(1);
    expect(h.up()).toBe(false);
    vi.useRealTimers();
  });

  it("a release without a press (focus arrived mid-hold) does nothing; reset drops a pending hold", () => {
    vi.useFakeTimers();
    const long = vi.fn();
    const h = new Hold();
    expect(h.up()).toBe(false);
    h.down(long);
    h.reset();
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(long).not.toHaveBeenCalled();
    expect(h.up()).toBe(false);
    vi.useRealTimers();
  });
});
