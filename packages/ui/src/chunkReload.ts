// A page that outlived its release: every lazy chunk (a screen, a loader, a
// design…) is a hashed file of the release the page started with. After a
// deploy the server keeps old ones for a while (the web image's asset
// archive, docs/deployment.md), but when one is gone anyway the import fails
// with a 404. Then — and only when a newer release is really out (the page's
// entry script differs from the one the server's index.html loads now) — the
// page reloads once, instead of crashing. A marker in sessionStorage keeps a
// broken release from reloading in a loop.
//
// No React and no other @martytv/ui imports: the TV app's startup code
// (main.tsx, before boot) uses it through "@martytv/ui/chunk-reload".

/** Another chunk failure this soon after a reload doesn't reload again. */
export const RELOAD_GUARD_MS = 5 * 60_000;
export const RELOAD_MARKER_KEY = "martytv.chunk_reload";

/**
 * Whether `e` is a failed chunk download (not a bug in the chunk's code):
 * the browsers' dynamic-import errors, Vite's preload errors and the legacy
 * build's SystemJS load error (errors.md#3).
 */
export function isChunkLoadError(e: unknown): boolean {
  let msg = "";
  let name = "";
  try {
    if (typeof e === "string") msg = e;
    else if (e && typeof e === "object") {
      const o = e as { message?: unknown; name?: unknown };
      msg = typeof o.message === "string" ? o.message : "";
      name = typeof o.name === "string" ? o.name : "";
    }
  } catch {
    return false;
  }
  if (name === "ChunkLoadError") return true;
  return (
    /Failed to fetch dynamically imported module/i.test(msg) || // Chrome
    /error loading dynamically imported module/i.test(msg) || // Firefox
    /Importing a module script failed/i.test(msg) || // Safari
    /Unable to preload CSS/i.test(msg) || // Vite's CSS preload
    /Loading (CSS )?chunk \S+ failed/i.test(msg) ||
    // SystemJS (legacy build): "<url>, <parent> (SystemJS …/errors.md#3)" for a
    // script that didn't load, #7 for a fetched one (CSS) with a bad status.
    /errors\.md#[37]\b/.test(msg)
  );
}

/** The entry bundle a page's HTML loads ("/tv/assets/index-abc.js"), or null. */
export function entryScript(html: string): string | null {
  const m = /src="([^"]*\/assets\/index-[^"]+\.js)"/.exec(html);
  return m ? m[1]! : null;
}

/** The marker allows a reload now (none yet, unreadable, or older than the guard). */
export function reloadAllowed(marker: string | null, now: number, guardMs = RELOAD_GUARD_MS): boolean {
  if (!marker) return true;
  let at: number;
  try {
    at = Number((JSON.parse(marker) as { at?: unknown }).at);
  } catch {
    return true;
  }
  if (!Number.isFinite(at)) return true;
  // A clock that jumped back counts as long ago.
  return now - at >= guardMs || now < at;
}

/** The page's running release is behind the server's (both are entry script paths). */
export function newerRelease(own: string | null, latest: string | null): boolean {
  return !!own && !!latest && own !== latest;
}

export interface ChunkReloadOptions {
  /** The running page's entry script path (null in dev: never reloads). */
  ownEntry: () => string | null;
  /** The entry script path the server's index.html loads now (null: unknown / offline). */
  latestEntry: () => Promise<string | null>;
  /** Called once a reload is decided, before it happens (persist state, show «Обновляем…»). */
  beforeReload?: () => void | Promise<void>;
  reload?: () => void;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  now?: () => number;
}

export type ChunkFailed = (e: unknown) => Promise<boolean>;

let handler: ChunkFailed | null = null;

/** The app's handler for failed imports inside this package (strings, glyphs). */
export function setChunkFailedHandler(h: ChunkFailed | null): void {
  handler = h;
}

/** A failed import here: tell the app (no-op without a handler or for other errors). */
export function reportChunkFailure(e: unknown): void {
  if (handler) void handler(e).catch(() => undefined);
}

/**
 * The handler for a failed import: resolves true when the page is reloading
 * (the caller shows «Обновляем приложение…»), false when the failure stays
 * (not a chunk error, no newer release, or reloaded a moment ago).
 * Concurrent failures share one decision.
 */
export function createChunkReload(o: ChunkReloadOptions): ChunkFailed {
  const now = o.now ?? Date.now;
  const store = o.storage === undefined ? sessionStore() : o.storage;
  let pending: Promise<boolean> | null = null;
  let reloading = false;
  const decide = async (): Promise<boolean> => {
    const read = () => {
      try {
        return store?.getItem(RELOAD_MARKER_KEY) ?? null;
      } catch {
        return null;
      }
    };
    if (!reloadAllowed(read(), now())) return false;
    let latest: string | null;
    try {
      latest = await o.latestEntry();
    } catch {
      return false;
    }
    if (!newerRelease(o.ownEntry(), latest)) return false;
    try {
      store?.setItem(RELOAD_MARKER_KEY, JSON.stringify({ at: now(), to: latest }));
    } catch {
      // No storage: no loop guard either; reload at most once per page anyway.
    }
    reloading = true;
    try {
      await o.beforeReload?.();
    } catch {
      // never keep the page on an old release because of a hook
    }
    (o.reload ?? (() => window.location.reload()))();
    return true;
  };
  return (e: unknown) => {
    if (!isChunkLoadError(e)) return Promise.resolve(false);
    if (reloading) return Promise.resolve(true);
    return (pending ??= decide().finally(() => {
      pending = null;
    }));
  };
}

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** The entry script of the server's current index.html (`url`: the app's base, never from a cache). */
export async function fetchLatestEntry(url: string): Promise<string | null> {
  // The query keeps a service worker's precache from answering with the old shell.
  const res = await fetch(url + (url.indexOf("?") >= 0 ? "&" : "?") + "_v=" + Date.now(), { cache: "no-store" });
  if (!res.ok) return null;
  const latest = entryScript(await res.text());
  return latest ? new URL(latest, location.href).pathname : null;
}

/** The running page's entry script path (the module script; the legacy build keeps the tag too). */
export function pageEntry(doc: Document = document): string | null {
  const s = doc.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]');
  return s ? new URL(s.src, location.href).pathname : null;
}

/**
 * Failures nobody caught (an import's rejection, Vite's `vite:preloadError`)
 * go to `failed` too. Returns the uninstaller.
 */
export function installChunkReload(failed: ChunkFailed, win: Pick<Window, "addEventListener" | "removeEventListener"> = window): () => void {
  const onPreload = (ev: Event) => void failed((ev as Event & { payload?: unknown }).payload);
  const onRejection = (ev: Event) => void failed((ev as PromiseRejectionEvent).reason);
  win.addEventListener("vite:preloadError", onPreload);
  win.addEventListener("unhandledrejection", onRejection);
  return () => {
    win.removeEventListener("vite:preloadError", onPreload);
    win.removeEventListener("unhandledrejection", onRejection);
  };
}
