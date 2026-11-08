import { describe, expect, it } from "vitest";
import { appendFresh, buildClock, clockTime, excludeIds, runningLow, slotProgress, stepIndex, type ChannelItem } from "./schedule";
import { BATCH, ChannelSession, MAX_FAILS, STRIP_MS, type ChannelDeps } from "./session";
import { osdKey } from "./keys";

function item(id: string, minutes = 100, episode?: string): ChannelItem {
  return {
    media: { id, kind: episode ? "series" : "movie", title: `T ${id}` } as ChannelItem["media"],
    episode: episode ? { id: episode, season_number: 1, episode_number: 2, name: "Ep" } : null,
    runtime_minutes: minutes,
    runtime_known: true,
    resume_seconds: 0,
    source: episode ? "continue" : "foryou",
    reason: null,
  };
}

const T0 = new Date(2026, 10, 8, 20, 0, 0).getTime();

describe("buildClock", () => {
  it("chains the runtimes from the tune-in time", () => {
    const s = buildClock([100, 45, 120, 90], 0, T0 + 60_000, { position: null, duration: null, startedAt: T0 });
    expect(s.map((x) => [x.index, clockTime(x.start), clockTime(x.end)])).toEqual([
      [0, "20:00", "21:40"],
      [1, "21:40", "22:25"],
      [2, "22:25", "00:25"],
    ]);
  });
  it("uses the file's duration and position once known", () => {
    // 30 min in, a 90 min file: started 19:30 → ends 21:00.
    const now = T0;
    const s = buildClock([100, 45], 0, now, { position: 1800, duration: 5400, startedAt: now - 5_000 });
    expect(clockTime(s[0]!.start)).toBe("19:30");
    expect(clockTime(s[0]!.end)).toBe("21:00");
    expect(clockTime(s[1]!.start)).toBe("21:00");
    expect(slotProgress(s[0], now)).toBeCloseTo(1 / 3);
  });
  it("never ends the current slot in the past", () => {
    const s = buildClock([10], 0, T0 + 3600_000, { position: null, duration: null, startedAt: T0 });
    expect(s[0]!.end).toBeGreaterThan(T0 + 3600_000);
  });
  it("starts from the current index and stops at the list's end", () => {
    const s = buildClock([100, 45, 120], 2, T0, { position: null, duration: null, startedAt: T0 });
    expect(s.map((x) => x.index)).toEqual([2]);
    expect(buildClock([100], 5, T0, { position: null, duration: null, startedAt: T0 })).toEqual([]);
  });
});

describe("programme bookkeeping", () => {
  it("steps within the list", () => {
    expect(stepIndex(0, 1, 3)).toBe(1);
    expect(stepIndex(2, 1, 3)).toBeNull();
    expect(stepIndex(0, -1, 3)).toBeNull();
  });
  it("runs low with fewer than three picks ahead", () => {
    expect(runningLow(0, 8)).toBe(false);
    expect(runningLow(5, 8)).toBe(true);
  });
  it("appends only fresh picks", () => {
    const a = [item("a"), item("s", 45, "e1")];
    const out = appendFresh(a, [item("a"), item("b"), item("s", 45, "e2"), item("x")], new Set(["x"]));
    expect(out.map((i) => i.episode?.id ?? i.media.id)).toEqual(["a", "e1", "b", "e2"]);
    expect(excludeIds(out, ["x"])).toEqual(["a", "s", "b", "x"]);
  });
});

// ---------------------------------------------------------------- session

function fakeDeps(batches: ChannelItem[][]) {
  const timers: { fn: () => void; ms: number; dead: boolean }[] = [];
  const log = { loads: [] as string[][], plays: [] as string[], dismissed: [] as string[], prefetched: [] as string[], stopped: 0, played: [] as string[] };
  const d: ChannelDeps = {
    load: (_n, exclude) => {
      log.loads.push(exclude);
      return Promise.resolve(batches.shift() ?? []);
    },
    play: (it) => log.plays.push(it.episode?.id ?? it.media.id),
    stop: () => void log.stopped++,
    prefetch: (it) => log.prefetched.push(it.media.id),
    dismiss: (id) => log.dismissed.push(id),
    played: (id) => log.played.push(id),
    now: () => T0,
    setTimer: (fn, ms) => {
      const t = { fn, ms, dead: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) (t as { dead: boolean }).dead = true;
    },
  };
  const fire = (ms: number) => timers.filter((t) => !t.dead && t.ms === ms).forEach((t) => ((t.dead = true), t.fn()));
  return { d, log, fire };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ChannelSession", () => {
  it("tunes in to the first pick and shows the strip", async () => {
    const { d, log, fire } = fakeDeps([[item("a"), item("b"), item("c"), item("d"), item("e")]]);
    const s = new ChannelSession(d);
    await s.start();
    expect(s.get().phase).toBe("on");
    expect(log.plays).toEqual(["a"]);
    expect(log.played).toEqual(["a"]);
    expect(s.get().osd).toBe("strip");
    fire(STRIP_MS);
    expect(s.get().osd).toBeNull();
    fire(45_000);
    expect(log.prefetched).toEqual(["b"]);
  });

  it("channel up / down move through the programme", async () => {
    const { d, log } = fakeDeps([[item("a"), item("b"), item("c"), item("d"), item("e")]]);
    const s = new ChannelSession(d);
    await s.start();
    s.next();
    s.next();
    s.prev();
    s.prev();
    s.prev(); // at the start: stays
    expect(log.plays).toEqual(["a", "b", "c", "b", "a"]);
    expect(s.get().index).toBe(0);
  });

  it("fetches more when low, excluding what is on the programme", async () => {
    const { d, log } = fakeDeps([[item("a"), item("b"), item("c"), item("d")], [item("d"), item("e"), item("f")]]);
    const s = new ChannelSession(d);
    await s.start();
    expect(log.loads.length).toBe(1);
    s.next(); // index 1: two left → low
    await flush();
    expect(log.loads.length).toBe(2);
    expect(log.loads[1]).toEqual(["a", "b", "c", "d"]);
    expect(s.get().items.map((i) => i.media.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("channel up at the very end waits for the next batch", async () => {
    const { d, log } = fakeDeps([[item("a")], [], [item("b")]]);
    const s = new ChannelSession(d);
    await s.start();
    await flush(); // the low-water fetch (empty)
    s.next();
    expect(s.get().waiting).toBe(true);
    await flush();
    await flush();
    expect(log.plays).toEqual(["a", "b"]);
    expect(s.get().waiting).toBe(false);
  });

  it("«Не то» dismisses and skips, and the title never comes back", async () => {
    const { d, log } = fakeDeps([
      [item("a"), item("b"), item("c"), item("d"), item("e")],
      [item("a"), item("f")],
    ]);
    const s = new ChannelSession(d);
    await s.start();
    s.notThis();
    expect(log.dismissed).toEqual(["a"]);
    expect(log.plays).toEqual(["a", "b"]);
    s.next();
    s.next(); // low → fetch; «a» came back from the server but is dropped
    await flush();
    expect(s.get().items.filter((i) => i.media.id === "a").length).toBe(1);
    expect(log.loads[1]).toContain("a");
  });

  it("the end of a title goes straight on; failures skip, then give up", async () => {
    const many = Array.from({ length: BATCH }, (_, i) => item(`m${i}`));
    const { d, log } = fakeDeps([many]);
    const s = new ChannelSession(d);
    await s.start();
    s.ended();
    expect(log.plays).toEqual(["m0", "m1"]);
    for (let i = 0; i < MAX_FAILS; i++) s.failed();
    expect(s.get().phase).toBe("error");
    expect(log.stopped).toBe(1);
  });

  it("an empty programme says so", async () => {
    const { d } = fakeDeps([[]]);
    const s = new ChannelSession(d);
    await s.start();
    expect(s.get().phase).toBe("empty");
  });

  it("the guide's buttons", async () => {
    const { d } = fakeDeps([[item("a"), item("b"), item("c"), item("d")]]);
    const s = new ChannelSession(d);
    await s.start();
    s.showGuide();
    expect(s.get().osd).toBe("guide");
    expect(s.focused()).toBe("next");
    s.moveFocus(1);
    expect(s.focused()).toBe("not_this");
    s.moveFocus(1);
    s.moveFocus(1);
    s.moveFocus(1);
    expect(s.focused()).toBe("leave");
    s.hideOsd();
    expect(s.get().osd).toBeNull();
  });
});

describe("osdKey", () => {
  const base = { osd: null, panel: false, skip: false } as const;
  it("maps the remote like a TV", () => {
    expect(osdKey("chup", base)).toBe("next");
    expect(osdKey("chdown", base)).toBe("prev");
    expect(osdKey("up", base)).toBe("next");
    expect(osdKey("down", base)).toBe("prev");
    expect(osdKey("ok", base)).toBe("guide");
    expect(osdKey("guide", base)).toBe("guide");
    expect(osdKey("back", base)).toBe("leave");
    expect(osdKey("stop", base)).toBe("leave");
    expect(osdKey("left", base)).toBeNull();
    expect(osdKey("playpause", base)).toBeNull();
  });
  it("leaves OK to an intro / credits pill and the arrows to the tracks panel", () => {
    expect(osdKey("ok", { ...base, skip: true })).toBeNull();
    expect(osdKey("up", { ...base, panel: true })).toBeNull();
    expect(osdKey("back", { ...base, panel: true })).toBeNull();
    expect(osdKey("chup", { ...base, panel: true })).toBe("next");
  });
  it("the guide owns ◀▶ / OK / Back", () => {
    const g = { ...base, osd: "guide" } as const;
    expect(osdKey("left", g)).toBe("focus_prev");
    expect(osdKey("right", g)).toBe("focus_next");
    expect(osdKey("ok", g)).toBe("press");
    expect(osdKey("back", g)).toBe("hide");
    expect(osdKey("up", g)).toBe("next");
    // The strip: Back just hides it.
    expect(osdKey("back", { ...base, osd: "strip" })).toBe("hide");
  });
});
