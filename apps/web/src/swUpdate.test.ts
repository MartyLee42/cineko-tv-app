import { describe, expect, it } from "vitest";
import { busyPlaying } from "./swUpdate";

describe("busyPlaying", () => {
  it("holds updates in players and while any media plays", () => {
    expect(busyPlaying("/watch/abc", [])).toBe(true);
    expect(busyPlaying("/video/watch/x", [])).toBe(true);
    expect(busyPlaying("/offline/1", [])).toBe(true);
    expect(busyPlaying("/tv-channels", [{ paused: false }])).toBe(true);
    expect(busyPlaying("/title/1", [{ paused: true }])).toBe(false);
    expect(busyPlaying("/", [])).toBe(false);
  });
});
