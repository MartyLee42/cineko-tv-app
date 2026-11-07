import { createRoot } from "react-dom/client";
import { getCurrentFocusKey, init } from "@noriginmedia/norigin-spatial-navigation";
import { QueryClientProvider } from "@tanstack/react-query";
import { apiErrorMiddleware, ErrorBoundary, I18nProvider, initialLocale, installErrorReporter, installKeySounds, loadLocale, parseDeviceModel } from "@martytv/ui";
import { queryClient } from "./catalog/queries";
import { App } from "./App";
import { api } from "./api";
import { credentialStore, detectPlatform } from "./platform";
import { installBackTrap, needsBackTrap } from "./remote/backTrap";
import "./index.css";
import { installKeyDedupe } from "./remote/keyDedupe";
import { installNavTrace } from "./remote/navTrace";
import { installFastNav } from "./design/fastNav";
import { installAutoUpdate } from "./update";
import { player } from "./player/controller";

// Client error logging (Admin → Errors): window errors, rejections, render
// crashes, failed API calls and player errors. Sent only once paired.
declare const __MARTYTV_RELEASE__: string;
installErrorReporter({
  app: "tv",
  release: typeof __MARTYTV_RELEASE__ === "string" ? __MARTYTV_RELEASE__ : "dev",
  getAuth: () => {
    const cred = credentialStore.get();
    return cred ? { headers: { Authorization: `Bearer ${cred}` }, beacon: false } : null;
  },
  getRoute: () => location.pathname + (location.hash.split("?")[0] ?? ""),
  deviceModel: parseDeviceModel(navigator.userAgent),
});
api.use(apiErrorMiddleware());

// TV hosts (MSX on Android/Tizen, webOS…): the host's own Back must stay
// inside the app (remote/backTrap.ts). Before any other keydown listener.
if (needsBackTrap(detectPlatform()) || /MSX|Media ?Station/i.test(navigator.userAgent)) installBackTrap();
// Tests: changes only when the page really (re)loads.
(window as unknown as { __bootId?: string }).__bootId = Math.random().toString(36).slice(2);

// Remote-control focus management (arrow keys + OK/Enter).
init({ debug: false, visualDebug: false, throttle: 80, throttleKeypresses: true });
// Tests and debugging: the current focus key.
(window as unknown as { __focusKey?: () => string }).__focusKey = getCurrentFocusKey;
// Reports a Left/Right in the menu that skips a tab (seen on some TVs only).
if (detectPlatform() !== "browser" && !navigator.webdriver) installKeyDedupe();
installNavTrace();
installFastNav();
// «Звуки интерфейса»: a tick on arrows, a click on OK (off unless switched on in Settings).
installKeySounds();
// A new deploy reaches the TV without a manual restart (update.ts).
if (!navigator.webdriver) installAutoUpdate(() => player.flow.phase === "idle");

// The UI is laid out for 1920×1080; scale it to whatever the screen is
// (720p panels, 4K browsers, desktop windows during development).
function fit() {
  const root = document.getElementById("root")!;
  // The visible area (visualViewport where the engine has it): some TV
  // browsers report a layout viewport that is larger than what's shown.
  const vv = (window as unknown as { visualViewport?: { width: number; height: number } }).visualViewport;
  const w = Math.min(window.innerWidth, vv?.width || window.innerWidth, document.documentElement.clientWidth || window.innerWidth);
  const h = Math.min(window.innerHeight, vv?.height || window.innerHeight, document.documentElement.clientHeight || window.innerHeight);
  const scale = Math.min(w / 1920, h / 1080);
  // Centre the 16:9 canvas when the screen has another shape.
  const x = Math.max(0, (w - 1920 * scale) / 2);
  const y = Math.max(0, (h - 1080 * scale) / 2);
  root.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
}
window.addEventListener("resize", fit);
fit();

// index.html paints the cached theme's background before the bundle loads; the app's own CSS takes over now.
document.documentElement.style.removeProperty("background");
document.documentElement.style.removeProperty("color");

// The start language's strings first (preloaded by main.tsx: usually already here).
// A failed download still renders (keys, then the provider retries).
void loadLocale(initialLocale())
  .catch(() => undefined)
  .then(() => {
    createRoot(document.getElementById("root")!).render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <ErrorBoundary variant="tv">
            <App />
          </ErrorBoundary>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
