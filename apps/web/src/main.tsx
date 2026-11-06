import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { apiErrorMiddleware, ErrorBoundary, I18nProvider, installClickSounds, installErrorReporter } from "@martytv/ui";
import { registerSW } from "virtual:pwa-register";
import { initInstall } from "./install/install";
import { api, queryClient } from "./api";
import { App } from "./App";
import { readCachedLook, setLook, syncThemeColorMeta } from "./watch/settings";
import { captureInstallPrompt } from "./watch/onboarding";
import { readStoredProfile } from "./watch/profile";
import "./index.css";
import { captureFromTv } from "./watch/fromTv";

// Design + theme before the first render (no dark/light flash); the profile's setting
// takes over once it loads.
captureFromTv();
setLook(readCachedLook());
syncThemeColorMeta();
captureInstallPrompt();
// «Звуки интерфейса»: a click on buttons and links (off unless switched on in Settings).
installClickSounds();

registerSW({ immediate: true });
// Catch `beforeinstallprompt` before React mounts (it fires early, once).
initInstall();

// Client error logging (Admin → Errors): window errors, rejections, render
// crashes, failed API calls. Sent only while signed in.
declare const __MARTYTV_RELEASE__: string;
const sessionOf = () => queryClient.getQueryData<{ csrf_token?: string; user?: { id: string } } | null>(["session"]);
installErrorReporter({
  app: "web",
  release: typeof __MARTYTV_RELEASE__ === "string" ? __MARTYTV_RELEASE__ : "dev",
  getAuth: () => {
    const csrf = sessionOf()?.csrf_token;
    return csrf ? { headers: { "X-CSRF-Token": csrf }, beacon: true } : null;
  },
  getProfileId: () => {
    const id = sessionOf()?.user?.id;
    return id ? readStoredProfile(id) : null;
  },
});
api.use(apiErrorMiddleware());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ErrorBoundary variant="web">
          <App />
        </ErrorBoundary>
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
);
