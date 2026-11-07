// «Ретро 90-е»: the Windows 95 desktop.
import "./retro90.css";
import type { Look } from "./types";
import { layer } from "./common";

/** The Windows 95 desktop: flat teal with a faint dither. */
function DesktopBackground() {
  return <div data-skin-bg="desktop" className={`r9-desktop ${layer}`} />;
}

export const look: Look = { Background: () => <DesktopBackground /> };
