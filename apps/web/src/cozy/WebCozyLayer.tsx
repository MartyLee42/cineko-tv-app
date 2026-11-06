// «Уютный режим» in the PWA, the sibling of WebSeasonLayer: the warm palette
// (html.mt-cozy) on every page inside Layout, and the ambience (rain /
// fireplace, optionally with its quiet sound) on Home only. The full-screen
// player (/watch) is outside Layout, so neither reaches it; inline players
// hide the ambience through useVideoPlaying.
import { useLocation } from "react-router";
import { cozyRender, CozyLayer, useCozyPalette, useReducedMotion, useVideoPlaying } from "@martytv/ui";
import { useSettings } from "../watch/queries";
import { useNarrow } from "../seasons/SeasonalLayer";

export function WebCozyLayer() {
  const settings = useSettings();
  const { pathname } = useLocation();
  const reduced = useReducedMotion();
  const playing = useVideoPlaying();
  const narrow = useNarrow();
  const on = settings.cozy_mode === true;
  useCozyPalette(on);
  const ambience = settings.cozy_ambience ?? "fireplace";
  const render = cozyRender({ on, ambience, onHome: pathname === "/", playing, reducedMotion: reduced });
  if (render === "none" || ambience === "off") return null;
  return <CozyLayer ambience={ambience} mode={render} platform="web" narrow={narrow} sound={settings.cozy_sound === true} />;
}
