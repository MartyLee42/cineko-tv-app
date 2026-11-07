import { describe, expect, it } from "vitest";
import { CAT_AFTER_MS, CodeMatcher, codeKey, dvdStep, idlePhase, PAUSED_SAVER_MS, pausedSaverDue, SAVER_AFTER_MS, SECRET, type CodeKey } from "./logic";

describe("idle phases on Home", () => {
  const all = { cat: true, saver: true };
  it("cat once after 2 min, the screensaver after 10", () => {
    expect(idlePhase(CAT_AFTER_MS - 1, false, all)).toBe("none");
    expect(idlePhase(CAT_AFTER_MS, false, all)).toBe("cat");
    expect(idlePhase(CAT_AFTER_MS + 30_000, true, all)).toBe("none");
    expect(idlePhase(SAVER_AFTER_MS, true, all)).toBe("saver");
    expect(idlePhase(SAVER_AFTER_MS, false, all)).toBe("saver");
  });
  it("respects what is switched off", () => {
    expect(idlePhase(CAT_AFTER_MS, false, { cat: false, saver: true })).toBe("none");
    expect(idlePhase(SAVER_AFTER_MS, true, { cat: true, saver: false })).toBe("none");
  });
});

describe("secret code", () => {
  it("maps remote keys", () => {
    expect(codeKey({ key: "ArrowUp" })).toBe("up");
    expect(codeKey({ keyCode: 37 })).toBe("left");
    expect(codeKey({ key: "Enter" })).toBe("ok");
    expect(codeKey({ key: "a" })).toBeNull();
  });
  it("fires on the full sequence only, also after a false start", () => {
    const m = new CodeMatcher();
    const feed = (keys: readonly CodeKey[]) => keys.map((k) => m.push(k));
    expect(feed(SECRET.slice(0, -1)).some(Boolean)).toBe(false);
    expect(m.push("ok")).toBe(true);
    // A false start, then the code.
    expect(feed(["up", "down", ...SECRET]).at(-1)).toBe(true);
    // Another key in between breaks it.
    m.push("up");
    m.push(null);
    expect(feed(SECRET.slice(1)).some(Boolean)).toBe(false);
  });
});

describe("DVD bounce", () => {
  it("moves, bounces off walls and reports it", () => {
    const s1 = dvdStep({ x: 10, y: 10, vx: 100, vy: 100 }, 100, 1920, 1080, 300, 100);
    expect(s1).toMatchObject({ x: 20, y: 20, bounced: false });
    const s2 = dvdStep({ x: 1615, y: 500, vx: 100, vy: -50 }, 100, 1920, 1080, 300, 100);
    expect(s2.x).toBe(1620);
    expect(s2.vx).toBeLessThan(0);
    expect(s2.bounced).toBe(true);
    // A long frame (the TV was busy) doesn't fling it out.
    const s3 = dvdStep({ x: 5, y: 5, vx: -400, vy: -400 }, 5000, 1920, 1080, 300, 100);
    expect(s3).toMatchObject({ x: 0, y: 0, bounced: true });
  });
});

describe("the screensaver over a paused player", () => {
  it("waits PAUSED_SAVER_MS from the pause or the last key, whichever is later", () => {
    expect(pausedSaverDue(null, 0, PAUSED_SAVER_MS * 3)).toBe(false);
    expect(pausedSaverDue(1000, 0, 1000 + PAUSED_SAVER_MS - 1)).toBe(false);
    expect(pausedSaverDue(1000, 0, 1000 + PAUSED_SAVER_MS)).toBe(true);
    expect(pausedSaverDue(1000, 60_000, 1000 + PAUSED_SAVER_MS)).toBe(false);
    expect(pausedSaverDue(1000, 60_000, 60_000 + PAUSED_SAVER_MS)).toBe(true);
  });
});
