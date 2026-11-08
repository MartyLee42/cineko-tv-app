// An installed PWA resumed from the background never reloads, so it only learns
// about a new release on a cold start. Check again whenever it comes back to the
// foreground (and hourly), unless something is playing: a found update reloads
// the page.

const PLAYER_PATHS = [/^\/watch\//, /^\/offline\//, /^\/video\/watch\//];
const HOUR = 60 * 60_000;

export function busyPlaying(path: string, media: ArrayLike<{ paused: boolean }>): boolean {
  if (PLAYER_PATHS.some((re) => re.test(path))) return true;
  return Array.from(media).some((m) => !m.paused);
}

export function watchForUpdates(reg: ServiceWorkerRegistration | undefined) {
  if (!reg) return;
  let last = Date.now();
  const check = () => {
    if (busyPlaying(location.pathname, document.querySelectorAll<HTMLMediaElement>("video, audio"))) return;
    last = Date.now();
    reg.update().catch(() => {});
  };
  document.addEventListener("visibilitychange", () => {
    // Coming back after at least a minute away.
    if (document.visibilityState === "visible" && Date.now() - last > 60_000) check();
  });
  window.setInterval(() => document.visibilityState === "visible" && check(), HOUR);
}
