// The screensaver over a player left paused (PAUSED_SAVER_MS without a key).
// Mounted for the whole app, so its key listener runs before the players':
// the key that wakes the screensaver goes no further (it doesn't also press
// play).
import { useEffect, useState } from "react";
import { useAppliedDesign } from "@martytv/ui";
import { player } from "../player/controller";
import { Screensaver } from "./IdleLayer";
import { pausedSaverDue, pausedSaverMs, saverPref } from "./logic";


/**
 * The on-screen player's video, paused by the viewer (not ended, not
 * loading; our own «Буферизация» pauses the element too — that's no pause).
 */
function pausedVideo(): boolean {
  const v = document.querySelector("video");
  if (!v || !v.paused || v.ended || v.readyState === 0) return false;
  return player.video === v ? player.userPaused() : true;
}

export function PausedSaver() {
  const cv = useAppliedDesign() === "constructivism";
  const [on, setOn] = useState(false);

  useEffect(() => {
    let shown = false;
    let lastKey = Date.now();
    let pausedAt: number | null = null;
    const show = (v: boolean) => {
      shown = v;
      setOn(v);
    };
    const onKey = (e: KeyboardEvent) => {
      lastKey = Date.now();
      if (!shown) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      show(false);
    };
    window.addEventListener("keydown", onKey, true);
    const id = setInterval(() => {
      const now = Date.now();
      if (!pausedVideo()) pausedAt = null;
      else if (pausedAt === null) pausedAt = now;
      const due = saverPref.get() !== "off" && pausedSaverDue(pausedAt, lastKey, now, pausedSaverMs());
      if (due !== shown) show(due);
    }, 1000);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      clearInterval(id);
    };
  }, []);

  if (!on) return null;
  return (
    <div className="absolute left-0 top-0" style={{ zIndex: 70 }}>
      <Screensaver cv={cv} />
    </div>
  );
}
