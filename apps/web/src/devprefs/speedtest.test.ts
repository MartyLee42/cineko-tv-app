// Background speed test (shared @martytv/media-types logic): samples and
// the current estimate, the adaptive measurement, the scheduler's triggers
// and guards, the release-list network hint and the settings texts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addThroughputSample,
  agoText,
  createScheduler,
  currentThroughput,
  hintThroughput,
  INTERVAL_MS,
  LONG_HIDDEN_MS,
  measureThroughput,
  networkHint,
  networkHintText,
  networkSignature,
  NETWORK_DEBOUNCE_MS,
  parseSamples,
  readSchedulerState,
  runResultText,
  lastSpeedText,
  SETTLE_MS,
  shouldRun,
  SpeedtestAborted,
  TICK_MS,
  type SchedulerEnv,
  type SchedulerState,
  type SpeedtestResponse,
  type ThroughputSample,
} from "@martytv/media-types";
import { currentEstimate, readSampleList, recordSample, SAMPLES_KEY, type KV } from "./logic";

const H = 3600_000;
const NOW = 1_800_000_000_000;

function memKV(init: Record<string, string> = {}): KV {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

const pb = (mbps: number, at: number): ThroughputSample => ({ bps: mbps * 1e6, at, src: "playback" });
const st = (mbps: number, at: number): ThroughputSample => ({ bps: mbps * 1e6, at, src: "speedtest" });

describe("throughput samples", () => {
  it("reads legacy number arrays and drops junk", () => {
    expect(parseSamples([5e6, "x", -1, null, { bps: 7e6, at: 5, src: "speedtest" }, { bps: "1" }])).toEqual([
      { bps: 5e6, at: 0, src: "playback" },
      { bps: 7e6, at: 5, src: "speedtest" },
    ]);
    expect(parseSamples("nope")).toEqual([]);
  });

  it("keeps the newest samples", () => {
    let l: ThroughputSample[] = [];
    for (let i = 0; i < 20; i++) l = addThroughputSample(l, pb(i + 1, i));
    expect(l).toHaveLength(12);
    expect(l[11]!.bps).toBe(20e6);
    expect(addThroughputSample(l, pb(0, 1))).toHaveLength(12);
  });

  it("without a speed test: the median of the last 7", () => {
    expect(currentThroughput([], NOW)).toBeNull();
    expect(currentThroughput([pb(10, NOW - H), pb(20, NOW - H), pb(30, NOW - H)], NOW)).toBe(20e6);
  });

  it("a speed test on a new network replaces the old estimate at once", () => {
    const home = [pb(50, NOW - 9 * H), st(60, NOW - 8 * H), pb(55, NOW - 5 * H), pb(45, NOW - 4 * H)];
    expect(currentThroughput(home, NOW)).toBe(52.5e6);
    // Another Wi-Fi: one test at 8 Mbit/s.
    expect(currentThroughput([...home, st(8, NOW - 60_000)], NOW)).toBe(8e6);
    // …and back home: the boundary is the 8 Mbit/s test; the old samples beyond it don't count.
    expect(currentThroughput([...home, st(8, NOW - 2 * H), st(58, NOW - 60_000)], NOW)).toBe(58e6);
  });

  it("a slow playback session (weak swarm) doesn't pull a measured network down", () => {
    const l = [st(40, NOW - 3 * H), pb(4, NOW - 2 * H), pb(38, NOW - H)];
    // Samples older than the test within ×2 count; after it, all count.
    expect(currentThroughput([pb(3, NOW - 4 * H), pb(35, NOW - 4 * H), ...l.slice(0, 1)], NOW)).toBe(37.5e6);
    expect(currentThroughput(l, NOW)).toBe(38e6);
  });

  it("drops samples older than 30 days", () => {
    expect(currentThroughput([st(5, NOW - 40 * 24 * H), pb(20, NOW - H)], NOW)).toBe(20e6);
  });

  it("hint speed only from a measurement ≤ 24 h old", () => {
    expect(hintThroughput([st(8, NOW - 25 * H)], NOW)).toBeNull();
    expect(hintThroughput([st(8, NOW - H)], NOW)).toBe(8e6);
    expect(hintThroughput([{ bps: 8e6, at: 0, src: "playback" }], NOW)).toBeNull();
  });

  it("web storage: legacy arrays migrate; speed tests anchor the estimate", () => {
    const kv = memKV({ [SAMPLES_KEY]: "[20000000,30000000]" });
    expect(currentEstimate(kv, NOW)).toBe(25e6);
    expect(recordSample(6e6, kv, "speedtest", NOW)).toBe(6e6);
    expect(readSampleList(kv).map((s) => s.src)).toEqual(["playback", "playback", "speedtest"]);
    expect(recordSample(7e6, kv, "playback", NOW + 1)).toBe(6.5e6);
  });
});

// ---------------------------------------------------------------- measurement

/** A fake /speedtest: `mbps` link, `ttfb` ms latency, chunks of 64 KB; time is virtual. */
function fakeServer(mbps: number, opts: { ttfb?: number; stream?: boolean; failAt?: number } = {}) {
  let t = 0;
  const calls: number[] = [];
  const fetchBytes = async (bytes: number, signal: AbortSignal): Promise<SpeedtestResponse> => {
    calls.push(bytes);
    t += opts.ttfb ?? 30;
    const chunk = 64 * 1024;
    let sent = 0;
    const reader = {
      read: async () => {
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        if (opts.failAt != null && sent >= opts.failAt) throw new Error("reset");
        if (sent >= bytes) return { done: true };
        const n = Math.min(chunk, bytes - sent);
        sent += n;
        t += (n * 8 * 1000) / (mbps * 1e6);
        return { done: false, value: new Uint8Array(n) };
      },
      cancel: async () => undefined,
    };
    return {
      ok: true,
      body: opts.stream === false ? null : { getReader: () => reader },
      arrayBuffer: async () => {
        t += (bytes * 8 * 1000) / (mbps * 1e6);
        return new ArrayBuffer(bytes);
      },
    };
  };
  return { fetchBytes, now: () => t, calls };
}

describe("measureThroughput", () => {
  it("probes with 1 MB, then sizes the sample for ~4 s", async () => {
    const s = fakeServer(40);
    const bps = await measureThroughput({ fetchBytes: s.fetchBytes, now: s.now });
    expect(bps).toBeCloseTo(40e6, -5);
    expect(s.calls[0]).toBe(1 << 20);
    // 40 Mbit/s × 4 s = 20 MB.
    expect(s.calls[1]).toBe(20e6);
    expect(s.calls).toHaveLength(2);
  });

  it("caps the sample at 25 MB on fast links", async () => {
    const s = fakeServer(500);
    const bps = await measureThroughput({ fetchBytes: s.fetchBytes, now: s.now });
    expect(bps).toBeCloseTo(500e6, -6);
    expect(Math.max(...s.calls)).toBe(25 << 20);
  });

  it("slow links: a 2 MB sample is the minimum", async () => {
    const s = fakeServer(2);
    expect(await measureThroughput({ fetchBytes: s.fetchBytes, now: s.now })).toBeCloseTo(2e6, -4);
    expect(s.calls).toEqual([1 << 20, 2 << 20]);
  });

  it("without a streaming body it times the whole request", async () => {
    const s = fakeServer(20, { stream: false, ttfb: 0 });
    expect(await measureThroughput({ fetchBytes: s.fetchBytes, now: s.now })).toBeCloseTo(20e6, -5);
  });

  it("an abort (playback started) throws SpeedtestAborted", async () => {
    const s = fakeServer(20);
    const ctl = new AbortController();
    ctl.abort();
    await expect(measureThroughput({ fetchBytes: s.fetchBytes, now: s.now, signal: ctl.signal })).rejects.toBeInstanceOf(SpeedtestAborted);
  });

  it("a broken connection mid-sample: the partial data counts when there's enough", async () => {
    const s = fakeServer(10, { failAt: 512 * 1024 });
    expect(await measureThroughput({ fetchBytes: s.fetchBytes, now: s.now })).toBeCloseTo(10e6, -5);
  });

  it("a server error fails the test", async () => {
    const fetchBytes = async (): Promise<SpeedtestResponse> => ({ ok: false, body: null, arrayBuffer: async () => new ArrayBuffer(0) });
    await expect(measureThroughput({ fetchBytes })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------- scheduler

const ENV: SchedulerEnv = { enabled: true, busy: false, hidden: false, online: true, saveData: false, cellular: false };
const NEVER: SchedulerState = { lastRunAt: null, netSig: null };

describe("shouldRun", () => {
  it("guards: playing, offline, disabled, hidden, Save-Data, cellular", () => {
    expect(shouldRun("start", NEVER, { ...ENV, busy: true }, NOW)).toEqual({ run: false, reason: "playing" });
    expect(shouldRun("start", NEVER, { ...ENV, online: false }, NOW).reason).toBe("offline");
    expect(shouldRun("start", NEVER, { ...ENV, enabled: false }, NOW).reason).toBe("disabled");
    expect(shouldRun("start", NEVER, { ...ENV, hidden: true }, NOW).reason).toBe("hidden");
    expect(shouldRun("start", NEVER, { ...ENV, saveData: true }, NOW).reason).toBe("save_data");
    expect(shouldRun("start", NEVER, { ...ENV, cellular: true }, NOW).reason).toBe("cellular");
    expect(shouldRun("start", NEVER, ENV, NOW).run).toBe(true);
  });

  it("manual: ignores the setting and connection type, never during playback", () => {
    expect(shouldRun("manual", { lastRunAt: NOW, netSig: null }, { ...ENV, enabled: false, cellular: true, saveData: true }, NOW).run).toBe(true);
    expect(shouldRun("manual", NEVER, { ...ENV, busy: true }, NOW).reason).toBe("playing");
  });

  it("start / interval / visible gaps", () => {
    const at = (ms: number): SchedulerState => ({ lastRunAt: NOW - ms, netSig: null });
    expect(shouldRun("start", at(10 * 60_000), ENV, NOW).reason).toBe("recent");
    expect(shouldRun("start", at(H), ENV, NOW).run).toBe(true);
    expect(shouldRun("interval", at(5 * H), ENV, NOW).run).toBe(false);
    expect(shouldRun("interval", at(INTERVAL_MS), ENV, NOW).run).toBe(true);
    expect(shouldRun("visible", at(10 * 60_000), ENV, NOW).run).toBe(false);
    expect(shouldRun("visible", at(LONG_HIDDEN_MS), ENV, NOW).run).toBe(true);
    // A clock that went backwards doesn't block tests forever.
    expect(shouldRun("interval", { lastRunAt: NOW + H, netSig: null }, ENV, NOW).run).toBe(true);
  });

  it("network: a changed signature after 2 min; unknown signature at most every 10 min", () => {
    const st0 = { lastRunAt: NOW - 3 * 60_000, netSig: "wifi|4g|5" };
    expect(shouldRun("network", st0, ENV, NOW, "wifi|4g|5").run).toBe(false);
    expect(shouldRun("network", st0, ENV, NOW, "cellular|4g|3").run).toBe(true);
    expect(shouldRun("network", { ...st0, lastRunAt: NOW - 60_000 }, ENV, NOW, "x").run).toBe(false);
    expect(shouldRun("network", { lastRunAt: NOW - 3 * 60_000, netSig: null }, ENV, NOW, null).run).toBe(false);
    expect(shouldRun("network", { lastRunAt: NOW - 11 * 60_000, netSig: null }, ENV, NOW, null).run).toBe(true);
  });

  it("network signature: coarse, null when unknown", () => {
    expect(networkSignature(null)).toBeNull();
    expect(networkSignature({})).toBeNull();
    expect(networkSignature({ type: "wifi", effectiveType: "4g", downlink: 10 })).toBe("wifi|4g|3");
    expect(networkSignature({ type: "wifi", effectiveType: "4g", downlink: 9 })).toBe("wifi|4g|3");
  });
});

describe("createScheduler", () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => vi.useRealTimers());

  function setup(o: { measure?: (signal: AbortSignal) => Promise<number | null>; env?: Partial<SchedulerEnv> } = {}) {
    let state: SchedulerState = { lastRunAt: null, netSig: null };
    const env = { ...ENV, ...o.env };
    const results: number[] = [];
    let runs = 0;
    const measure =
      o.measure ??
      (async () => {
        runs++;
        return 30e6;
      });
    const sched = createScheduler({
      now: () => Date.now(),
      setTimeout: (f, ms) => setTimeout(f, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      env: () => env,
      netSig: () => null,
      load: () => state,
      save: (s) => void (state = s),
      measure: (s) => {
        if (o.measure) runs++;
        return measure(s);
      },
      onResult: (bps) => results.push(bps),
    });
    return { sched, env, results, runs: () => runs, state: () => state };
  }

  it("first test after the app settles, then every 6 h", async () => {
    const s = setup();
    s.sched.start();
    await vi.advanceTimersByTimeAsync(SETTLE_MS - 1000);
    expect(s.runs()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.runs()).toBe(1);
    expect(s.results).toEqual([30e6]);
    expect(s.state().lastRunAt).toBe(NOW + SETTLE_MS);
    await vi.advanceTimersByTimeAsync(5 * H);
    expect(s.runs()).toBe(1);
    await vi.advanceTimersByTimeAsync(H + TICK_MS);
    expect(s.runs()).toBe(2);
    s.sched.stop();
  });

  it("network changes are debounced into one test", async () => {
    const s = setup();
    s.sched.start();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    s.sched.networkChanged();
    s.sched.networkChanged();
    s.sched.networkChanged();
    await vi.advanceTimersByTimeAsync(NETWORK_DEBOUNCE_MS);
    expect(s.runs()).toBe(2);
    s.sched.stop();
  });

  it("back after a long time hidden: a test; a short absence: none", async () => {
    const s = setup();
    s.sched.start();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    s.sched.visible(60_000);
    await vi.advanceTimersByTimeAsync(NETWORK_DEBOUNCE_MS);
    expect(s.runs()).toBe(1);
    await vi.advanceTimersByTimeAsync(LONG_HIDDEN_MS);
    s.sched.visible(LONG_HIDDEN_MS);
    await vi.advanceTimersByTimeAsync(NETWORK_DEBOUNCE_MS);
    expect(s.runs()).toBe(2);
    s.sched.stop();
  });

  it("never while playing; a running test is aborted and retried after playback", async () => {
    let aborted = 0;
    const s = setup({
      measure: (signal) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve(20e6), 5000);
          signal.addEventListener("abort", () => {
            aborted++;
            clearTimeout(t);
            reject(new SpeedtestAborted());
          });
        }),
    });
    s.sched.start();
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 1000);
    expect(s.sched.running()).toBe(true);
    s.sched.setBusy(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(aborted).toBe(1);
    expect(s.sched.running()).toBe(false);
    expect(s.results).toEqual([]);
    // An aborted run doesn't count as a run.
    expect(s.state().lastRunAt).toBeNull();
    // Manual runs are refused while playing.
    expect((await s.sched.runNow()).reason).toBe("playing");
    await vi.advanceTimersByTimeAsync(H);
    expect(s.runs()).toBe(1);
    // Playback ends: retried a minute later.
    s.sched.setBusy(false);
    await vi.advanceTimersByTimeAsync(60_000 + 5000);
    expect(s.runs()).toBe(2);
    expect(s.results).toEqual([20e6]);
    s.sched.stop();
  });

  it("disabled: no background tests, but «Проверить сейчас» works", async () => {
    const s = setup({ env: { enabled: false } });
    s.sched.start();
    await vi.advanceTimersByTimeAsync(SETTLE_MS + INTERVAL_MS + TICK_MS);
    expect(s.runs()).toBe(0);
    const r = await s.sched.runNow();
    expect(r).toEqual({ bps: 30e6 });
    expect(s.runs()).toBe(1);
    s.sched.stop();
  });

  it("a failed test still counts (no retry storm)", async () => {
    const s = setup({ measure: async () => Promise.reject(new Error("500")) });
    s.sched.start();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(s.state().lastRunAt).not.toBeNull();
    s.sched.networkChanged();
    await vi.advanceTimersByTimeAsync(NETWORK_DEBOUNCE_MS);
    expect(s.runs()).toBe(1);
    expect((await s.sched.runNow()).reason).toBe("failed");
    s.sched.stop();
  });

  it("persisted state survives junk", () => {
    expect(readSchedulerState({ get: () => "{oops", set: () => undefined })).toEqual({ lastRunAt: null, netSig: null });
    expect(readSchedulerState({ get: () => '{"lastRunAt":5,"netSig":"a"}', set: () => undefined })).toEqual({ lastRunAt: 5, netSig: "a" });
  });
});

// ---------------------------------------------------------------- hint & texts

const t = (k: string, v?: Record<string, string | number>) => `${k}${v ? JSON.stringify(v) : ""}`;

describe("networkHint", () => {
  // A 2 h film: 4 GB 1080p ≈ 4.8 Mbit/s, 15 GB 1080p ≈ 17.9, 40 GB 4K ≈ 47.7.
  const runtime = 7200;
  const rel = (gb: number, resolution: string) => ({ resolution, size_bytes: gb * 2 ** 30, est_bitrate_bps: (gb * 2 ** 30 * 8) / runtime });
  const items = [rel(40, "2160p"), rel(15, "1080p"), rel(4, "1080p"), rel(1.5, "720p")];

  it("slow network: the best resolution that fits and the size limit", () => {
    const h = networkHint(items, 8e6)!;
    expect(h).toEqual({ mbps: 8, resolution: "1080p", maxGb: 6 });
    expect(networkHintText(h, t)).toBe('tvplay.net.hint{"mbps":8,"res":"1080p","gb":6}');
  });

  it("fast enough for everything: no hint", () => {
    expect(networkHint(items, 100e6)).toBeNull();
    expect(networkHint(items, null)).toBeNull();
  });

  it("nothing fits: «раздачи до ~N ГБ»; unknown runtime: generic", () => {
    const h = networkHint(items, 1e6)!;
    expect(h.resolution).toBeNull();
    expect(networkHintText(h, t)).toBe('tvplay.net.hint_any{"mbps":1,"gb":0.8}');
    const packs = [{ resolution: "1080p", size_bytes: 50 * 2 ** 30, est_bitrate_bps: 20e6, is_season_pack: true, episodes: [1, 2, 3] }];
    expect(networkHintText(networkHint(packs, 8e6)!, t)).toBe('tvplay.net.hint_slow{"mbps":8}');
  });
});

describe("settings texts", () => {
  it("time ago, last result, run results", () => {
    expect(agoText(NOW - 10_000, NOW, t)).toBe("tvplay.net.ago_now");
    expect(agoText(NOW - 5 * 60_000, NOW, t)).toBe('tvplay.net.ago_min{"n":5}');
    expect(agoText(NOW - 3 * H, NOW, t)).toBe('tvplay.net.ago_hour{"n":3}');
    expect(agoText(NOW - 50 * H, NOW, t)).toBe('tvplay.net.ago_day{"n":2}');
    expect(lastSpeedText(null, NOW, t)).toBe("tvplay.net.never");
    expect(lastSpeedText(st(42.4, NOW - 5 * 60_000), NOW, t)).toBe('tvplay.net.last{"mbps":42,"ago":"tvplay.net.ago_min{\\"n\\":5}"}');
    expect(lastSpeedText(st(7.46, NOW), NOW, t)).toContain('"mbps":7.5');
    expect(runResultText({ bps: 42e6 }, t)).toBe('tvplay.net.done{"mbps":42}');
    expect(runResultText({ bps: null, reason: "playing" }, t)).toBe("tvplay.net.busy");
    expect(runResultText({ bps: null, reason: "failed" }, t)).toBe("tvplay.net.failed");
  });
});
