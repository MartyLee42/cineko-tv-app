// OK on a card → Details, through the design's «pick» animation (Стикербук's
// peel): the look starts it on the focused card and Details opens a moment
// later. No animation (most designs, calm motion, fast scrolling) → at once.
import type { Look } from "./looks/types";
import { pickDelay } from "./sticker";

let busy = false;

export function openWithPick(look: Look | null, calm: boolean, run: () => void): void {
  if (busy) return; // a second OK during the animation
  const card = document.querySelector(".mt-card.is-focused");
  const wrap = card ? (card.closest("[data-card-id]") as HTMLElement | null) : null;
  const fast = document.documentElement.classList.contains("mt-fast");
  const ms = pickDelay({ pickMs: look?.pick?.ms, calm, fast, hasCard: !!wrap });
  if (!ms || !wrap || !look?.pick) return run();
  busy = true;
  look.pick.start(wrap);
  setTimeout(() => {
    busy = false;
    run();
  }, ms);
}
