// «Уютный режим» and «Живые постеры» on the TV, the sibling of TvSeasonLayer.
// CatalogShell mounts <TvCozyLayer/> for as long as the catalog is up: it
// keeps the warm palette (html.mt-cozy) and the poster hop (html.mt-wobble)
// applied, and draws the ambience (with its quiet sound, if chosen) only on
// Home's menu screen — never on Details, Settings, the guide, or while the
// player / live TV replaces the catalog (CatalogShell is gone then).
import { lazy, Suspense, useEffect } from "react";
import { cozyRender, useCozyPalette, useReducedMotion, useVideoPlaying } from "@martytv/ui";
import { useSettings } from "../profile/settings";
import { useCalmMotion } from "./skins";

// The ambience (and its Web Audio engine) is its own chunk: fetched only in cozy mode.
const CozyLayer = lazy(() => import("@martytv/ui/cozy-layer").then((m) => ({ default: m.CozyLayer })));

/** html.mt-wobble while the profile wants the poster hop (and motion isn't reduced). */
function useWobbleClass(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const root = document.documentElement;
    root.classList.add("mt-wobble");
    return () => root.classList.remove("mt-wobble");
  }, [on]);
}

export function TvCozyLayer({ onHome }: { onHome: boolean }) {
  const settings = useSettings();
  const reduced = useReducedMotion();
  const calm = useCalmMotion();
  const playing = useVideoPlaying();
  useCozyPalette(settings.cozy_mode);
  useWobbleClass(settings.poster_wobble && !reduced);
  const ambience = settings.cozy_ambience;
  const render = cozyRender({ on: settings.cozy_mode, ambience, onHome, playing, reducedMotion: reduced, calmMotion: calm });
  if (render === "none" || ambience === "off") return null;
  return (
    <Suspense fallback={null}>
      <CozyLayer ambience={ambience} mode={render} platform="tv" fixed={false} sound={settings.cozy_sound} />
    </Suspense>
  );
}
