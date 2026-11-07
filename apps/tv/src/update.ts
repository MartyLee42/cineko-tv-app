// Picks up a new deploy without anyone restarting the app. TV hosts (MSX on
// Tizen / Android) keep the page alive through standby for days, so a fix
// only reached a TV once someone closed the app by hand. Every few minutes
// (and when the TV wakes) we fetch /tv/ and compare its entry script with the
// one this page runs; once it differs, the page reloads at the first quiet
// moment: right after waking, or after a while without keys — never while
// anything plays.

// A chunk of the old release that is already gone doesn't wait for that
// moment: chunkReload.ts reloads at once.
import { entryScript, pageEntry } from "@martytv/ui/chunk-reload";

export { entryScript };

const CHECK_MS = 10 * 60_000;
/** No key for this long counts as nobody using the TV right now. */
const QUIET_MS = 3 * 60_000;

/** Whether a reload may happen now. */
export function safeToReload(o: { playerIdle: boolean; mediaPlaying: boolean; sinceKeyMs: number; justWoke: boolean }): boolean {
  if (!o.playerIdle || o.mediaPlaying) return false;
  return o.justWoke || o.sinceKeyMs >= QUIET_MS;
}

function mediaPlaying(): boolean {
  return Array.from(document.querySelectorAll("video, audio")).some((m) => !(m as HTMLMediaElement).paused);
}

/** `playerIdle`: no title is loading or playing in the player. */
export function installAutoUpdate(playerIdle: () => boolean) {
  const mine = pageEntry();
  if (!mine) return; // dev server: no hashed bundle
  let lastKey = Date.now();
  let stale = false;
  window.addEventListener("keydown", () => (lastKey = Date.now()), true);

  const tryReload = (justWoke: boolean) => {
    if (!stale) return;
    if (safeToReload({ playerIdle: playerIdle(), mediaPlaying: mediaPlaying(), sinceKeyMs: Date.now() - lastKey, justWoke })) location.reload();
  };
  const check = async (justWoke: boolean) => {
    try {
      const res = await fetch(location.pathname.replace(/[^/]*$/, ""), { cache: "no-store" });
      if (!res.ok) return;
      const latest = entryScript(await res.text());
      if (latest && new URL(latest, location.href).pathname !== mine) stale = true;
    } catch {
      return; // offline: try next time
    }
    tryReload(justWoke);
  };

  setInterval(() => void check(false), CHECK_MS);
  // Between checks: reload as soon as it gets quiet. A long gap between
  // ticks means the TV slept (standby doesn't always fire visibilitychange).
  let tick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const woke = now - tick > 90_000;
    tick = now;
    if (woke) void check(true);
    else tryReload(false);
  }, 30_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void check(true);
  });
}
