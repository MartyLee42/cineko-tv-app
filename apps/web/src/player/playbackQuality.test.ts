import { describe, expect, it } from "vitest";
import { PlaybackQualityMeter, QUALITY_EVERY_REPORTS, type PlaybackQualitySample } from "@martytv/media-types";
import { ProgressReporter, type Clock, type ReportBody, type Transport } from "./reporter";

function fakeVideo() {
  const l = new Map<string, () => void>();
  const v = {
    seeking: false,
    paused: false,
    videoWidth: 1920,
    videoHeight: 1080,
    frames: { droppedVideoFrames: 0, totalVideoFrames: 0 },
    getVideoPlaybackQuality() {
      return this.frames;
    },
    addEventListener: (k: string, fn: () => void) => l.set(k, fn),
    removeEventListener: (k: string) => l.delete(k),
    fire: (k: string) => l.get(k)?.(),
    listeners: l,
  };
  return v;
}

function setup(selfPaused = () => false) {
  let t = 1000;
  const m = new PlaybackQualityMeter("tv", () => "direct", selfPaused, () => t);
  const v = fakeVideo();
  m.attach(v as unknown as HTMLVideoElement);
  return { m, v, at: (d: number) => (t += d) };
}

describe("PlaybackQualityMeter", () => {
  it("measures startup, watch time and a stall", () => {
    const { m, v, at } = setup();
    at(2000);
    v.fire("playing");
    at(60_000);
    v.fire("waiting");
    at(3000);
    v.fire("playing");
    at(10_000);
    const s = m.snapshot();
    expect(s).toMatchObject({ startup_ms: 2000, watched_s: 70, stalls: 1, stall_ms: 3000, longest_stall_ms: 3000, height: 1080 });
  });

  it("ignores engine blips and counts a wait after a seek as the seek", () => {
    const { m, v, at } = setup();
    v.fire("playing");
    v.fire("waiting");
    at(100);
    v.fire("playing");
    v.seeking = true;
    v.fire("seeking");
    at(500);
    v.seeking = false;
    v.fire("seeked");
    v.fire("waiting");
    at(1000);
    v.fire("playing");
    expect(m.snapshot()).toMatchObject({ stalls: 0, stall_ms: 0, seeks: 1, seek_wait_ms: 1500 });
  });

  it("keeps a stall open across the player's own rebuffering pause, not a user's", () => {
    let own = true;
    const { m, v, at } = setup(() => own);
    v.fire("playing");
    v.fire("waiting");
    v.fire("pause");
    at(2000);
    v.fire("playing");
    expect(m.snapshot().stall_ms).toBe(2000);
    own = false;
    v.fire("waiting");
    at(1000);
    v.fire("pause");
    at(60_000);
    expect(m.snapshot()).toMatchObject({ stalls: 2, stall_ms: 3000 });
  });

  it("adds frame counters across a counter reset and stops listening on detach", () => {
    const { m, v } = setup();
    v.frames = { droppedVideoFrames: 2, totalVideoFrames: 100 };
    expect(m.snapshot()).toMatchObject({ dropped_frames: 2, total_frames: 100 });
    v.frames = { droppedVideoFrames: 1, totalVideoFrames: 10 };
    expect(m.snapshot()).toMatchObject({ dropped_frames: 3, total_frames: 110 });
    m.detach();
    expect(v.listeners.size).toBe(0);
  });
});

describe("telemetry on progress reports", () => {
  const sample = { app: "web" } as PlaybackQualitySample;

  async function session() {
    const bodies: ReportBody[] = [];
    const beacons: ReportBody[] = [];
    let tick = () => {};
    const transport: Transport = {
      start: async () => ({ id: "s", resume_position_seconds: null, progress: null, report_token: "t" }),
      report: async (_id, b) => {
        bodies.push(b);
        return { accepted: true };
      },
      beacon: (_id, b) => void beacons.push(b),
    };
    const clock: Clock = {
      setInterval: (fn) => ((tick = fn), 1),
      clearInterval: () => undefined,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    };
    const r = new ProgressReporter(transport, clock);
    await r.begin({ profile_id: "p", media_id: "m" }, () => ({ position: 60, duration: 600, paused: false }), () => sample);
    return { r, bodies, beacons, tick: () => tick() };
  }

  it("adds totals every 20th periodic report and adds no requests", async () => {
    const { bodies, tick } = await session();
    for (let i = 0; i < QUALITY_EVERY_REPORTS * 2; i++) tick();
    expect(bodies).toHaveLength(QUALITY_EVERY_REPORTS * 2);
    expect(bodies.flatMap((b, i) => (b.quality ? [i + 1] : []))).toEqual([QUALITY_EVERY_REPORTS, QUALITY_EVERY_REPORTS * 2]);
  });

  it("always adds them at the end and when the page is hidden", async () => {
    const { r, bodies, beacons } = await session();
    r.hidden();
    expect(beacons[0]?.quality).toBe(sample);
    r.end();
    expect(bodies.at(-1)).toMatchObject({ state: "stopped", quality: sample });
  });
});
