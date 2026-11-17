import { describe, expect, it } from "vitest";
import { burstOf, CAT_AFTER_MS, CodeMatcher, codeKey, FIREWORK_COLORS, idlePhase, PAUSED_SAVER_MS, pausedSaverDue, posterPool, resolveSaver, SAVER_AFTER_MS, SECRET, SHOWN_SAVERS, type CodeKey } from "./logic";

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

describe("the screensaver over a paused player", () => {
  it("waits PAUSED_SAVER_MS from the pause or the last key, whichever is later", () => {
    expect(pausedSaverDue(null, 0, PAUSED_SAVER_MS * 3)).toBe(false);
    expect(pausedSaverDue(1000, 0, 1000 + PAUSED_SAVER_MS - 1)).toBe(false);
    expect(pausedSaverDue(1000, 0, 1000 + PAUSED_SAVER_MS)).toBe(true);
    expect(pausedSaverDue(1000, 60_000, 1000 + PAUSED_SAVER_MS)).toBe(false);
    expect(pausedSaverDue(1000, 60_000, 60_000 + PAUSED_SAVER_MS)).toBe(true);
  });
});

describe("screensaver choice", () => {
  it("shows the setting itself, and «Случайная» never the previous one", () => {
    expect(resolveSaver("snow", "snow", 0.3)).toBe("snow");
    expect(resolveSaver("off", null, 0.3)).toBe("sleep");
    for (const last of SHOWN_SAVERS) {
      for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
        const s = resolveSaver("random", last, r);
        expect(SHOWN_SAVERS).toContain(s);
        expect(s).not.toBe(last);
      }
    }
    // Every saver comes up.
    expect(new Set([0, 0.2, 0.4, 0.6, 0.8].map((r) => resolveSaver("random", null, r))).size).toBe(SHOWN_SAVERS.length);
  });
});

describe("«Салют»", () => {
  it("bursts over the skyline, off the edges; every 7th of the first slot spells the name", () => {
    let k = 1;
    const rand = () => ((k = (k * 16807) % 2147483647) / 2147483647);
    for (let n = 0; n < 50; n++) {
      const b = burstOf(n % 3, n, rand);
      expect(b.x).toBeGreaterThanOrEqual(260);
      expect(b.x).toBeLessThanOrEqual(1660);
      expect(b.y).toBeGreaterThanOrEqual(150);
      expect(b.y).toBeLessThanOrEqual(580);
      expect(FIREWORK_COLORS).toContain(b.color);
    }
    expect(burstOf(0, 6, rand).word).toBe(true);
    expect(burstOf(1, 6, rand).word).toBe(false);
    expect(burstOf(0, 5, rand).word).toBe(false);
  });
});

describe("«Афиша»", () => {
  it("collects titles with posters from cached data, deduped and capped", () => {
    const m = (id: string, poster: string | null = `/${id}.jpg`) => ({ id, title: `T${id}`, poster_path: poster, year: 2020 });
    const cache = [
      { items: [m("a"), m("b"), m("c", null)] },
      { rows: [{ key: "r", items: [m("b"), m("d")] }] },
      [{ media: m("e"), progress: 0.5 }],
      null,
      "text",
    ];
    const pool = posterPool(cache, () => 0.5);
    expect(pool.map((p) => p.id).sort()).toEqual(["a", "b", "d", "e"]);
    expect(pool.every((p) => p.media && typeof p.media === "object")).toBe(true);
    expect(posterPool(cache, () => 0.5, 2)).toHaveLength(2);
  });
});
