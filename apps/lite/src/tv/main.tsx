import { createRoot } from "react-dom/client";
import "../shared/fonts.css";
import "../shared/theme.css";
import "./tv.css";
import { applyDesign } from "../core/designs";
import { getSettings } from "../core/store";
import { probeImages } from "../core/tmdb";
import { installNav } from "./nav";
import { installBackTrap } from "./backtrap";
import { App } from "./App";

const s = getSettings();
applyDesign(s.design, s.light);
void probeImages();

// The host's Back (MSX / webOS) becomes an in-app Back; installed before the
// navigation's own keydown listener.
installBackTrap(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "GoBack", bubbles: true, cancelable: true })));
installNav();

// The UI is laid out for 1920×1080 and scaled to the screen (720p panels,
// 4K web views, desktop windows), centred when the shape differs.
function fit() {
  const root = document.getElementById("root")!;
  const vv = (window as unknown as { visualViewport?: { width: number; height: number } }).visualViewport;
  const w = Math.min(window.innerWidth, vv?.width || window.innerWidth, document.documentElement.clientWidth || window.innerWidth);
  const h = Math.min(window.innerHeight, vv?.height || window.innerHeight, document.documentElement.clientHeight || window.innerHeight);
  const scale = Math.min(w / 1920, h / 1080);
  const x = Math.max(0, (w - 1920 * scale) / 2);
  const y = Math.max(0, (h - 1080 * scale) / 2);
  root.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
}
window.addEventListener("resize", fit);
fit();

createRoot(document.getElementById("root")!).render(<App />);
