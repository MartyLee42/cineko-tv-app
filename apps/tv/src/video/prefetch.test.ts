import { describe, expect, it } from "vitest";
import { gridThumbs, nearbyThumbs, ThumbPrefetcher } from "@martytv/media-types";
import { cardThumb } from "./prefetch";

const row = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`);

describe("what to prefetch", () => {
  it("takes the next cards of the row first, then the row below from its focus, then the rest", () => {
    const rows = [row("a", 30), row("b", 30), row("c", 30)];
    const out = nearbyThumbs(rows, 1, 4, { ahead: 6, next: 3, starts: [0, 4, 10] });
    expect(out).toEqual(["b5", "b6", "b7", "c10", "c11", "c12", "b8", "b9", "b10", "a0", "a1", "a2"]);
  });

  it("stops at the ends and skips missing thumbnails and repeats", () => {
    expect(nearbyThumbs([["x0", "x1", null, "x1"]], 0, 0, { ahead: 10 })).toEqual(["x1"]);
    expect(nearbyThumbs([row("a", 3)], 0, 2)).toEqual([]);
    expect(nearbyThumbs([], 0, 0)).toEqual([]);
  });

  it("grids: the rest of the line and the next two", () => {
    expect(gridThumbs(row("g", 40), 5, 4)).toEqual(row("g", 16).slice(6));
    expect(gridThumbs(row("g", 5), 1, 4)).toEqual(["g2", "g3", "g4"]);
  });

  it("uses the card's own size", () => {
    const v = { thumbnail: "/mq.jpg", thumbnail_hd: "/hq.jpg" };
    expect(cardThumb(v, 384)).toBe("/hq.jpg");
    expect(cardThumb(v, 320)).toBe("/mq.jpg");
  });
});

describe("prefetch scheduling", () => {
  function setup(maxInFlight = 2) {
    const started: string[] = [];
    const finish = new Map<string, () => void>();
    const idleQueue: (() => void)[] = [];
    const p = new ThumbPrefetcher({
      maxInFlight,
      maxQueue: 5,
      load: (u, done) => {
        started.push(u);
        finish.set(u, done);
      },
      idle: (cb) => idleQueue.push(cb),
    });
    const runIdle = () => {
      while (idleQueue.length) idleQueue.shift()!();
    };
    return { p, started, finish, runIdle };
  }

  it("waits for idle and keeps at most N in flight", () => {
    const { p, started, finish, runIdle } = setup(2);
    p.want(["a", "b", "c"]);
    expect(started).toEqual([]);
    runIdle();
    expect(started).toEqual(["a", "b"]);
    finish.get("a")!();
    runIdle();
    expect(started).toEqual(["a", "b", "c"]);
  });

  it("puts the newest request first and drops the oldest beyond the queue", () => {
    const { p, started, finish, runIdle } = setup(1);
    p.want(["a", "b", "c", "d"]);
    runIdle(); // a starts
    p.want(["x", "y", "c"]); // focus moved: x, y, c before b, d
    finish.get("a")!();
    runIdle();
    finish.get("x")!();
    runIdle();
    finish.get("y")!();
    runIdle();
    finish.get("c")!();
    runIdle();
    expect(started).toEqual(["a", "x", "y", "c", "b"]);
    p.want(row("q", 9));
    expect(p.pending()).toBe(6); // b in flight + 5 queued
  });

  it("never asks twice for a loaded or loading URL", () => {
    const { p, started, finish, runIdle } = setup(2);
    p.want(["a"]);
    runIdle();
    p.want(["a"]);
    finish.get("a")!();
    finish.get("a")!(); // a late second callback is ignored
    p.want(["a", "b"]);
    runIdle();
    expect(started).toEqual(["a", "b"]);
  });

  it("clear drops what waits", () => {
    const { p, started, runIdle } = setup(1);
    p.want(["a", "b", "c"]);
    p.clear();
    runIdle();
    expect(started).toEqual([]);
  });
});
