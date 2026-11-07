import { describe, expect, it, vi } from "vitest";
import { createChunkReload, entryScript, installChunkReload, isChunkLoadError, newerRelease, reloadAllowed, RELOAD_GUARD_MS, RELOAD_MARKER_KEY } from "./chunkReload";

function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m };
}

const MISSING = new TypeError("Failed to fetch dynamically imported module: https://tv.test/tv/assets/GhostMeter-BCJZK91d.js");
// What the legacy (SystemJS) build rejected with on the TV.
const SYSTEMJS = new Error(
  "https://tv.test/tv/assets/GhostMeter-legacy-BCJZK91d.js, https://tv.test/tv/assets/chunkPlayback-legacy-x.js (SystemJS https://github.com/systemjs/systemjs/blob/main/docs/errors.md#3)",
);

describe("isChunkLoadError", () => {
  it("knows every engine's failed chunk download", () => {
    expect(isChunkLoadError(MISSING)).toBe(true);
    expect(isChunkLoadError(SYSTEMJS)).toBe(true);
    expect(isChunkLoadError(new Error("x.css (SystemJS https://github.com/systemjs/systemjs/blob/main/docs/errors.md#7)"))).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module: /assets/a.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Unable to preload CSS for /assets/a.css"))).toBe(true);
    expect(isChunkLoadError({ name: "ChunkLoadError", message: "Loading chunk 3 failed." })).toBe(true);
  });
  it("leaves real bugs and other SystemJS errors alone", () => {
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(false);
    expect(isChunkLoadError(new Error("bare specifier (SystemJS https://github.com/systemjs/systemjs/blob/main/docs/errors.md#8)"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError(42)).toBe(false);
  });
});

describe("reload guard", () => {
  it("allows a reload without a fresh marker", () => {
    expect(reloadAllowed(null, 1000)).toBe(true);
    expect(reloadAllowed("garbage", 1000)).toBe(true);
    expect(reloadAllowed(JSON.stringify({ at: 1000 }), 1000 + RELOAD_GUARD_MS)).toBe(true);
    expect(reloadAllowed(JSON.stringify({ at: 1000 }), 1000 + RELOAD_GUARD_MS - 1)).toBe(false);
    // The clock went back: not a loop.
    expect(reloadAllowed(JSON.stringify({ at: 5000 }), 1000)).toBe(true);
  });
  it("needs a newer release", () => {
    expect(newerRelease("/tv/assets/index-a.js", "/tv/assets/index-b.js")).toBe(true);
    expect(newerRelease("/tv/assets/index-a.js", "/tv/assets/index-a.js")).toBe(false);
    expect(newerRelease(null, "/tv/assets/index-b.js")).toBe(false);
    expect(newerRelease("/tv/assets/index-a.js", null)).toBe(false);
    expect(entryScript(`<script type="module" crossorigin src="/tv/assets/index-B1.js"></script>`)).toBe("/tv/assets/index-B1.js");
  });
});

describe("createChunkReload", () => {
  const setup = (latest: string | null, store = memStore(), now = 10_000_000) => {
    const reload = vi.fn();
    const beforeReload = vi.fn();
    const latestEntry = vi.fn(async () => latest);
    const failed = createChunkReload({ ownEntry: () => "/tv/assets/index-old.js", latestEntry, beforeReload, reload, storage: store, now: () => now });
    return { failed, reload, beforeReload, latestEntry, store };
  };

  it("reloads once into a newer release, after the hooks, and leaves a marker", async () => {
    const { failed, reload, beforeReload, store } = setup("/tv/assets/index-new.js");
    expect(await failed(SYSTEMJS)).toBe(true);
    expect(beforeReload).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
    expect(beforeReload.mock.invocationCallOrder[0]).toBeLessThan(reload.mock.invocationCallOrder[0]!);
    expect(JSON.parse(store.map.get(RELOAD_MARKER_KEY)!)).toMatchObject({ at: 10_000_000 });
    // Later failures of the same page: already reloading.
    expect(await failed(MISSING)).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("shares one decision between failures at the same time", async () => {
    const { failed, reload, latestEntry } = setup("/tv/assets/index-new.js");
    const [a, b] = await Promise.all([failed(MISSING), failed(SYSTEMJS)]);
    expect(a && b).toBe(true);
    expect(latestEntry).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("stays when the release is current (a network hiccup), offline, or not a chunk error", async () => {
    const same = setup("/tv/assets/index-old.js");
    expect(await same.failed(MISSING)).toBe(false);
    const offline = setup(null);
    expect(await offline.failed(MISSING)).toBe(false);
    const bug = setup("/tv/assets/index-new.js");
    expect(await bug.failed(new TypeError("x is not a function"))).toBe(false);
    expect(bug.latestEntry).not.toHaveBeenCalled();
    for (const s of [same, offline, bug]) expect(s.reload).not.toHaveBeenCalled();
  });

  it("never reloads in a loop: a fresh marker from the last reload stops it", async () => {
    const store = memStore({ [RELOAD_MARKER_KEY]: JSON.stringify({ at: 10_000_000 - 60_000 }) });
    const { failed, reload, latestEntry } = setup("/tv/assets/index-new.js", store);
    expect(await failed(MISSING)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(latestEntry).not.toHaveBeenCalled();
    // Long after: allowed again.
    const later = setup("/tv/assets/index-new.js", store, 10_000_000 + RELOAD_GUARD_MS);
    expect(await later.failed(MISSING)).toBe(true);
  });

  it("still reloads when a hook throws or storage is missing", async () => {
    const reload = vi.fn();
    const failed = createChunkReload({
      ownEntry: () => "/a/assets/index-1.js",
      latestEntry: async () => "/a/assets/index-2.js",
      beforeReload: () => {
        throw new Error("hook");
      },
      reload,
      storage: null,
    });
    expect(await failed(MISSING)).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe("installChunkReload", () => {
  it("routes uncaught rejections and vite:preloadError to the handler", () => {
    const listeners = new Map<string, (e: Event) => void>();
    const win = {
      addEventListener: (t: string, fn: (e: Event) => void) => void listeners.set(t, fn),
      removeEventListener: (t: string) => void listeners.delete(t),
    } as unknown as Window;
    const failed = vi.fn(async () => false);
    const off = installChunkReload(failed, win);
    listeners.get("unhandledrejection")!({ reason: MISSING } as unknown as Event);
    listeners.get("vite:preloadError")!({ payload: SYSTEMJS } as unknown as Event);
    expect(failed.mock.calls).toEqual([[MISSING], [SYSTEMJS]]);
    off();
    expect(listeners.size).toBe(0);
  });
});
