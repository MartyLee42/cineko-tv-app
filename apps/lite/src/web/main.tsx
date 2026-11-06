import { createRoot } from "react-dom/client";
import "../shared/fonts.css";
import "../shared/theme.css";
import "./web.css";
import { applyDesign } from "../core/designs";
import { getSettings } from "../core/store";
import { probeImages } from "../core/tmdb";
import { App } from "./App";

const s = getSettings();
applyDesign(s.design, s.light);
void probeImages();

createRoot(document.getElementById("root")!).render(<App />);

// Installable PWA: a small service worker caches the app shell.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(import.meta.env.BASE_URL + "sw.js").catch(() => undefined);
  });
}
