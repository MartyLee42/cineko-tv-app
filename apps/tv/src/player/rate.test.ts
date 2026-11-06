// This TV's throughput samples: playback sessions + background speed tests
// (newest test anchors the estimate), legacy storage migrates.
import { describe, expect, it } from "vitest";
import { storage } from "../platform";
import { rateStore } from "./rebuffer";

const H = 3600_000;
const NOW = 1_800_000_000_000;

describe("rateStore", () => {
  it("migrates legacy samples and follows a new network after one speed test", () => {
    storage.set("martytv.tv_rate2", JSON.stringify([30e6, 34e6, 32e6]));
    expect(rateStore.get(NOW)).toBe(32e6);
    expect(rateStore.samples()).toEqual([30e6, 34e6, 32e6]);
    // A speed test on another Wi-Fi.
    rateStore.add(6e6, "speedtest", NOW - H);
    expect(rateStore.get(NOW)).toBe(6e6);
    expect(rateStore.hintBps(NOW)).toBe(6e6);
    // A playback session afterwards counts too.
    rateStore.add(8e6, "playback", NOW);
    expect(rateStore.get(NOW)).toBe(7e6);
    expect(rateStore.list().map((s) => s.src)).toEqual(["playback", "playback", "playback", "speedtest", "playback"]);
    // A day later the hint stays quiet (stale), ranking still uses the estimate.
    expect(rateStore.hintBps(NOW + 25 * H)).toBeNull();
    expect(rateStore.get(NOW + 25 * H)).toBe(7e6);
  });
});
