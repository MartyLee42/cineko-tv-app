import { describe, expect, it } from "vitest";
import { entryScript, safeToReload } from "./update";

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
});
