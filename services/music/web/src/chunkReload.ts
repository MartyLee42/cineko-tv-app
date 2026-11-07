// A chunk of this release gone from the server (a deploy while the page was
// open; the music service keeps old assets for a while, but not forever): one
// reload into the new release instead of a broken page — only when the
// server's index.html really names another entry script, and at most once in
// five minutes (a sessionStorage marker), so offline play never reloads.
// The same logic as @martytv/ui's chunkReload.ts (this app is its own npm project).

const KEY = "martytv.music.chunk_reload";
const GUARD_MS = 5 * 60_000;

function isChunkLoadError(e: unknown): boolean {
  const msg = e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string" ? (e as { message: string }).message : String(e ?? "");
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(msg);
}

function entryOf(html: string): string | null {
  return /src="([^"]*\/assets\/index-[^"]+\.js)"/.exec(html)?.[1] ?? null;
}

let busy = false;

async function failed(e: unknown): Promise<void> {
  if (busy || !isChunkLoadError(e)) return;
  busy = true;
  try {
    const at = Number(sessionStorage.getItem(KEY));
    if (at && Date.now() - at < GUARD_MS && Date.now() >= at) return;
    const own = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]');
    const res = await fetch(`${import.meta.env.BASE_URL}index.html?_v=${Date.now()}`, { cache: "no-store" });
    const latest = res.ok ? entryOf(await res.text()) : null;
    if (!own || !latest || new URL(latest, location.href).pathname === new URL(own.src, location.href).pathname) return;
    sessionStorage.setItem(KEY, String(Date.now()));
    location.reload();
  } catch {
    // offline or no storage: stay
  } finally {
    busy = false;
  }
}

export function installChunkReload(): void {
  window.addEventListener("vite:preloadError", (ev) => void failed((ev as Event & { payload?: unknown }).payload));
  window.addEventListener("unhandledrejection", (ev) => void failed(ev.reason));
}
