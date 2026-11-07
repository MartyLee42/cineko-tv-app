import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import "./fonts.css";
import "./styles.css";
import "./themes.css";
import "./designs.css";
import { initDesign } from "./themes";

initDesign();

// The app is built twice: for /music/ on the Cineko host and for / on
// Music's own host (MUSIC_DOMAIN). The API stays at /music/api on both.
const BASE = import.meta.env.BASE_URL;

// Offline play and the cached app shell (scope = the app's base only).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`${BASE}sw.js`, { scope: BASE })
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => {
        // Keep the offline copy of the app current after every deploy.
        if (navigator.onLine) reg.active?.postMessage("cache-shell");
      })
      .catch(() => undefined);
  });
}

const qc = new QueryClient({
  defaultOptions: {
    // "always": without a connection requests fail fast (and the app switches to
    // offline mode) instead of waiting forever for the network to come back.
    queries: { refetchOnWindowFocus: false, retry: 1, networkMode: "always" },
    mutations: { networkMode: "always" },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter basename={BASE.replace(/\/$/, "") || "/"}>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
