import { describe, expect, it, vi } from "vitest";
import { createLatest, createLeaveGuard, loadingSourceId } from "./abandon";
import { canStopOnTv } from "./flow";

describe("latest request wins", () => {
  it("a newer run supersedes the older one", () => {
    const l = createLatest();
    const a = l.begin();
    expect(a.live()).toBe(true);
    const b = l.begin();
    expect(a.live()).toBe(false);
    expect(a.signal.aborted).toBe(true);
    expect(b.live()).toBe(true);
  });

  it("cancel (leaving the page) kills the current run", async () => {
    const l = createLatest();
    const run = l.begin();
    const navigate = vi.fn();
    // The slow part (search + source creation) finishes after the viewer left.
    const done = new Promise((r) => setTimeout(r, 0)).then(() => run.live() && navigate("/watch/s1"));
    l.cancel();
    await done;
    expect(navigate).not.toHaveBeenCalled();
    expect(run.signal.aborted).toBe(true);
  });

  it("cancel with nothing running is harmless", () => {
    const l = createLatest();
    l.cancel();
    expect(l.begin().live()).toBe(true);
  });
});

describe("leave guard", () => {
  const manual = () => {
    const q: (() => void)[] = [];
    return { defer: (f: () => void) => void q.push(f), flush: () => q.splice(0).forEach((f) => f()) };
  };

  it("cancels the loading source once the page is really gone", () => {
    const cancel = vi.fn();
    const m = manual();
    const g = createLeaveGuard(cancel, m.defer);
    g.enter();
    g.leave("s1");
    m.flush();
    expect(cancel).toHaveBeenCalledWith("s1");
  });

  it("keeps it when the page comes right back (StrictMode remount)", () => {
    const cancel = vi.fn();
    const m = manual();
    const g = createLeaveGuard(cancel, m.defer);
    g.enter();
    g.leave("s1");
    g.enter();
    m.flush();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("nothing loading: nothing to cancel", () => {
    const cancel = vi.fn();
    const m = manual();
    const g = createLeaveGuard(cancel, m.defer);
    g.leave(null);
    m.flush();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("loadingSourceId", () => {
  const src = (status: string, kind: string | null = "torrent") => ({ id: "s1", status, kind });
  it("a torrent still preparing or before its first frame", () => {
    expect(loadingSourceId(src("preparing"), true, false)).toBe("s1");
    expect(loadingSourceId(src("ready"), true, false)).toBe("s1");
    expect(loadingSourceId(src("ready", null), true, false)).toBe("s1");
  });
  it("not once it plays, on the fallback screen, failed, or online", () => {
    expect(loadingSourceId(src("ready"), false, false)).toBeNull();
    expect(loadingSourceId(src("preparing"), true, true)).toBeNull();
    expect(loadingSourceId(src("error"), true, false)).toBeNull();
    expect(loadingSourceId(src("ready", "online"), true, false)).toBeNull();
    expect(loadingSourceId(null, true, false)).toBeNull();
  });
});

describe("canStopOnTv", () => {
  it("only while the TV reports this title loading", () => {
    expect(canStopOnTv({ kind: "searching" })).toBe(true);
    expect(canStopOnTv({ kind: "loading", stage: "preloading", pct: 10, peers: 3, seeders: 9, speed: 1, buffered: 1, release: null })).toBe(true);
    for (const kind of ["opening", "playing", "gone"] as const) expect(canStopOnTv({ kind })).toBe(false);
    expect(canStopOnTv({ kind: "failed", code: "x" })).toBe(false);
  });
});
