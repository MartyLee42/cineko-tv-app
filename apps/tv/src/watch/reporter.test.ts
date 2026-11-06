import { describe, expect, it } from "vitest";
import { ProgressReporter, REPORT_EVERY, SEEK_DEBOUNCE, type Clock, type ReportBody, type SessionStart, type Snapshot, type Transport } from "./reporter";

/** Manual clock: intervals/timeouts run when advanced. */
function fakeClock() {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; every: number | null; fn: () => void }>();
  const clock: Clock = {
    setInterval: (fn, ms) => (timers.set(++id, { at: now + ms, every: ms, fn }), id),
    clearInterval: (h) => void timers.delete(h as number),
    setTimeout: (fn, ms) => (timers.set(++id, { at: now + ms, every: null, fn }), id),
    clearTimeout: (h) => void timers.delete(h as number),
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [k, t] = next;
      now = t.at;
      if (t.every) t.at += t.every;
      else timers.delete(k);
      t.fn();
    }
    now = end;
  };
  return { clock, advance };
}

function setup(opts: { startFails?: boolean } = {}) {
  const sent: { id: string; body: ReportBody; beacon: boolean }[] = [];
  let resolveStart!: (s: SessionStart) => void;
  let rejectStart!: (e: unknown) => void;
  const transport: Transport = {
    start: () =>
      new Promise((res, rej) => {
        resolveStart = res;
        rejectStart = rej;
      }),
    report: (id, body) => (sent.push({ id, body, beacon: false }), Promise.resolve()),
    beacon: (id, body) => void sent.push({ id, body, beacon: true }),
  };
  const { clock, advance } = fakeClock();
  const snap: Snapshot = { position: 100, duration: 1000, paused: false };
  const r = new ProgressReporter(transport, clock);
  const started = r.begin({ profile_id: "p", media_id: "m" }, () => ({ ...snap }));
  const open = async () => {
    if (opts.startFails) rejectStart(new Error("x"));
    else resolveStart({ id: "s1", resume_position_seconds: 420, progress: null });
    await started;
  };
  return { r, sent, snap, advance, open, started };
}

describe("ProgressReporter", () => {
  it("reports every 15 s while playing, with increasing seq", async () => {
    const { sent, advance, open, snap } = setup();
    await open();
    advance(REPORT_EVERY);
    snap.position = 115;
    advance(REPORT_EVERY);
    expect(sent.map((s) => [s.body.seq, s.body.state, s.body.position_seconds])).toEqual([
      [1, "playing", 100],
      [2, "playing", 115],
    ]);
    expect(sent[0]!.body.duration_seconds).toBe(1000);
  });

  it("skips periodic reports while paused, but reports the pause at once", async () => {
    const { r, sent, advance, open, snap } = setup();
    await open();
    snap.paused = true;
    r.report("paused");
    advance(REPORT_EVERY * 3);
    expect(sent.map((s) => s.body.state)).toEqual(["paused"]);
  });

  it("debounces seeks into one report", async () => {
    const { r, sent, advance, open, snap } = setup();
    await open();
    r.seeked();
    snap.position = 300;
    r.seeked();
    advance(SEEK_DEBOUNCE + 10);
    expect(sent.map((s) => [s.body.state, s.body.position_seconds])).toEqual([["seeking", 300]]);
  });

  it("does not repeat 'playing' after buffering", async () => {
    const { r, sent, open } = setup();
    await open();
    r.report("playing");
    r.report("playing");
    expect(sent).toHaveLength(1);
  });

  it("queues the latest report until the session exists", async () => {
    const { r, sent, open, snap } = setup();
    snap.paused = true;
    r.report("paused");
    expect(sent).toHaveLength(0);
    await open();
    expect(sent).toEqual([{ id: "s1", body: { seq: 1, position_seconds: 100, duration_seconds: 1000, state: "paused" }, beacon: false }]);
  });

  it("sends a keepalive report when the page is hidden", async () => {
    const { r, sent, open } = setup();
    await open();
    r.hidden();
    expect(sent[0]).toMatchObject({ beacon: true, body: { state: "paused", seq: 1 } });
  });

  it("sends a final 'stopped' on end (Back / Stop) and nothing after", async () => {
    const { r, sent, advance, open } = setup();
    await open();
    r.end({ position: 250, duration: 1000, paused: false });
    advance(REPORT_EVERY * 2);
    expect(sent.map((s) => [s.body.state, s.body.position_seconds])).toEqual([["stopped", 250]]);
    expect(r.active).toBe(false);
  });

  it("skips 'stopped' right after 'ended' at the same spot", async () => {
    const { r, sent, open, snap } = setup();
    await open();
    snap.position = 999;
    r.report("ended");
    r.end();
    expect(sent.map((s) => s.body.state)).toEqual(["ended"]);
  });

  it("a new session ends the previous one first", async () => {
    const { r, sent, open } = setup();
    await open();
    void r.begin({ profile_id: "p", media_id: "m2" }, () => null);
    expect(sent.map((s) => s.body.state)).toEqual(["stopped"]);
  });

  it("drops reports when the session couldn't start; resolves null", async () => {
    const { r, sent, open, started } = setup({ startFails: true });
    await open();
    expect(await started).toBeNull();
    r.report("paused");
    r.end();
    expect(sent).toHaveLength(0);
  });

  it("untracked sessions (MSX / external) never report", async () => {
    const sent: unknown[] = [];
    const r = new ProgressReporter(
      { start: async () => ({ id: "x", resume_position_seconds: null, progress: null }), report: async () => sent.push(1), beacon: () => void sent.push(1) },
      fakeClock().clock,
    );
    await r.begin({ profile_id: "p", media_id: "m" }, () => ({ position: 5, duration: 10, paused: false }), false);
    r.report("paused");
    r.hidden();
    r.end();
    expect(sent).toHaveLength(0);
  });
});

describe("stale sessions", () => {
  it("stops reporting once the server says another device took over", async () => {
    const sent: ReportBody[] = [];
    const r = new ProgressReporter(
      {
        start: async () => ({ id: "s", resume_position_seconds: null, progress: null }),
        report: async (_id, body) => {
          sent.push(body);
          return { accepted: false, reason: "stale_session", progress: null };
        },
        beacon: () => undefined,
      },
      fakeClock().clock,
    );
    await r.begin({ profile_id: "p", media_id: "m" }, () => ({ position: 50, duration: 100, paused: false }));
    r.report("paused");
    await Promise.resolve();
    await Promise.resolve();
    r.report("playing");
    r.end();
    expect(sent.map((b) => b.state)).toEqual(["paused"]);
  });
});
