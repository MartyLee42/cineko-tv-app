import { describe, expect, it } from "vitest";
import {
  bandwidthCheck,
  bufferedAhead,
  estimateRate,
  mbit,
  preferUnderRate,
  rebufferDone,
  rebufferPercent,
  rebufferTarget,
  sourceBitrate,
  type RateSample,
} from "./logic";

describe("rebuffer threshold", () => {
  it("is max(20, 3 × last stall) capped at 60, 8 after a seek", () => {
    expect(rebufferTarget(null, false)).toBe(20);
    expect(rebufferTarget(4, false)).toBe(20);
    expect(rebufferTarget(10, false)).toBe(30);
    expect(rebufferTarget(45, false)).toBe(60);
    expect(rebufferTarget(45, true)).toBe(8);
  });

  it("measures the buffer ahead of the playhead", () => {
    const r: [number, number][] = [
      [0, 30],
      [100, 140],
    ];
    expect(bufferedAhead(r, 10)).toBe(20);
    expect(bufferedAhead(r, 120)).toBe(20);
    expect(bufferedAhead(r, 50)).toBe(0);
    expect(bufferedAhead([], 5)).toBe(0);
  });

  it("resumes at the threshold, on canplaythrough, or when the buffer reaches the end", () => {
    const base = { target: 20, canPlayThrough: false, time: 100, duration: 5400 };
    expect(rebufferDone({ ...base, ahead: 12 })).toBeNull();
    expect(rebufferDone({ ...base, ahead: 20 })).toBe("threshold");
    expect(rebufferDone({ ...base, ahead: 3, canPlayThrough: true })).toBe("canplaythrough");
    expect(rebufferDone({ ...base, ahead: 4, time: 5396 })).toBe("end");
    expect(rebufferDone({ ...base, ahead: 4, duration: null })).toBeNull();
    expect(rebufferPercent(10, 20)).toBe(50);
    expect(rebufferPercent(25, 20)).toBe(99);
  });

  it("plays what is there once the browser stopped fetching below the target (no «99 %» forever)", () => {
    const base = { target: 20, canPlayThrough: false, time: 100, duration: 5400 };
    expect(rebufferDone({ ...base, ahead: 19.8, stuckMs: 4_000 })).toBeNull();
    expect(rebufferDone({ ...base, ahead: 19.8, stuckMs: 5_000 })).toBe("plateau");
    // Nothing buffered: still a stall, keep waiting.
    expect(rebufferDone({ ...base, ahead: 1, stuckMs: 60_000 })).toBeNull();
  });
});

describe("bandwidth", () => {
  it("estimates the file bitrate and the download rate from buffer growth", () => {
    // 6.3 GB over 90 min ≈ 9.3 Mbit/s.
    const br = sourceBitrate(6_277_500_000, 5400)!;
    expect(Math.round(br / 1e5) / 10).toBe(9.3);
    expect(sourceBitrate(0, 5400)).toBeNull();
    expect(sourceBitrate(1000, null)).toBeNull();

    const at = (s: number) => 1_000_000 + s * 1000;
    // 10 s of wall time, buffer end grew 8 s of media → 0.8 × bitrate.
    const samples: RateSample[] = [
      { at: at(0), end: 100 },
      { at: at(5), end: 104 },
      { at: at(10), end: 108 },
    ];
    expect(estimateRate(samples, br, at(10))! / br).toBeCloseTo(0.8, 5);
    expect(estimateRate(samples.slice(0, 1), br, at(10))).toBeNull(); // not enough samples
    expect(estimateRate([samples[0]!, { at: at(1), end: 101 }], br, at(1))).toBeNull(); // < 3 s
    expect(estimateRate(samples, null, at(10))).toBeNull();
    expect(mbit(7_440_000)).toBe("7.4");
  });

  it("hints after > 20 s below 1.1 × bitrate, or > 3 stalls in 2 min", () => {
    const br = 9_300_000;
    let st = bandwidthCheck({ rate: 8e6, bitrate: br, lowSince: null, stalls: [], now: 0 });
    expect(st).toEqual({ lowSince: 0, hint: false });
    st = bandwidthCheck({ rate: 8e6, bitrate: br, lowSince: st.lowSince, stalls: [], now: 15_000 });
    expect(st.hint).toBe(false);
    st = bandwidthCheck({ rate: 8e6, bitrate: br, lowSince: st.lowSince, stalls: [], now: 21_000 });
    expect(st.hint).toBe(true);
    // A fast moment resets the low streak.
    expect(bandwidthCheck({ rate: 12e6, bitrate: br, lowSince: 0, stalls: [], now: 30_000 })).toEqual({ lowSince: null, hint: false });
    // Stalls: 4 within 2 min → hint; old ones don't count.
    const now = 500_000;
    expect(bandwidthCheck({ rate: null, bitrate: br, lowSince: null, stalls: [now - 100_000, now - 60_000, now - 30_000, now - 1000], now }).hint).toBe(true);
    expect(bandwidthCheck({ rate: null, bitrate: br, lowSince: null, stalls: [now - 200_000, now - 60_000, now - 30_000, now - 1000], now }).hint).toBe(false);
  });

  it("ranks releases under the measured rate first", () => {
    const rs = [
      { id: "remux", size_bytes: 30e9 },
      { id: "1080", size_bytes: 6e9 },
      { id: "pack", size_bytes: 1e9, is_season_pack: true },
      { id: "720", size_bytes: 2.5e9 },
    ];
    // 5 Mbit/s over 90 min carries ~3 GB (with 10 % headroom).
    expect(preferUnderRate(rs, 5e6, 5400).map((r) => r.id)).toEqual(["720", "remux", "1080", "pack"]);
  });
});
