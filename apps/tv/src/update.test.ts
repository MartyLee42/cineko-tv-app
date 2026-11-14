import { describe, expect, it } from "vitest";
import { entryScript, safeToReload, takeUpdateReload } from "./update";

describe("auto update", () => {
  it("finds the entry bundle, not the polyfills", () => {
    const html = `<script type="module" crossorigin src="/tv/assets/polyfills-D-kq.js"></script><script type="module" crossorigin src="/tv/assets/index-Ctzx.js"></script>`;
    expect(entryScript(html)).toBe("/tv/assets/index-Ctzx.js");
    expect(entryScript("<html></html>")).toBeNull();
  });
  it("reloads only when nothing plays and nobody is pressing keys (or the TV just woke)", () => {
    const base = { playerIdle: true, mediaPlaying: false, sinceKeyMs: 0, justWoke: false };
    expect(safeToReload(base)).toBe(false);
    expect(safeToReload({ ...base, sinceKeyMs: 180_000 })).toBe(true);
    expect(safeToReload({ ...base, justWoke: true })).toBe(true);
    expect(safeToReload({ ...base, justWoke: true, playerIdle: false })).toBe(false);
    expect(safeToReload({ ...base, sinceKeyMs: 999_999, mediaPlaying: true })).toBe(false);
  });
  it("reloads unseen while the screen is off (never while something plays)", () => {
    const base = { playerIdle: true, mediaPlaying: false, sinceKeyMs: 0, justWoke: false };
    expect(safeToReload({ ...base, hidden: true })).toBe(true);
    expect(safeToReload({ ...base, hidden: true, playerIdle: false })).toBe(false);
  });
  it("an update's reload is read once (it skips the intro)", () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => void m.delete(k) };
    m.set("martytv.update_reload", String(1_000_000));
    expect(takeUpdateReload(1_010_000, store)).toBe(true);
    expect(takeUpdateReload(1_010_000, store)).toBe(false);
    m.set("martytv.update_reload", String(1_000_000));
    expect(takeUpdateReload(1_000_000 + 120_000, store)).toBe(false);
  });
});
