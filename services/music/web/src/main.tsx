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

// Offline play and the cached app shell (scope /music/ only).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/music/sw.js", { scope: "/music/" })
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
      <BrowserRouter basename="/music">
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
