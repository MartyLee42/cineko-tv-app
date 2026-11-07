// The drawn loading styles (art shared with the TV, @martytv/ui/loaders/*):
// used by the loader and the Settings preview tiles.
import { AquariumArt } from "@martytv/ui/loaders/aquarium";
import { BalloonsArt } from "@martytv/ui/loaders/balloons";
import { CatchArt, type CatchKey } from "@martytv/ui/loaders/catch";
import { OdysseyArt } from "@martytv/ui/loaders/odyssey";
import { PawsArt } from "@martytv/ui/loaders/paws";
import { SpeedoArt } from "@martytv/ui/loaders/speedo";
import type { LoadingStyle } from "../watch/settings";

export const ART_STYLES = ["paws", "aquarium", "speed88", "odyssey", "balloons", "catch"] as const;
export type ArtStyleId = (typeof ART_STYLES)[number];

export function isArtStyle(s: LoadingStyle): s is ArtStyleId {
  return (ART_STYLES as readonly string[]).includes(s);
}

const ARROWS: Record<string, CatchKey> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

/** «Лови!» in the browser: the keyboard's arrows move the basket. */
function windowArrows(move: (k: CatchKey) => void): () => void {
  const onKey = (e: KeyboardEvent) => {
    const k = ARROWS[e.key];
    if (!k) return;
    e.preventDefault();
    move(k);
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

/** `quiet`: a preview (no sounds; the game plays by itself). */
export function ArtOf({ style, p, width, done, quiet, label }: { style: ArtStyleId; p: number; width: number; done?: boolean; quiet?: boolean; label?: string }) {
  const props = { p, width, done, quiet, label };
  switch (style) {
    case "paws":
      return <PawsArt {...props} />;
    case "aquarium":
      return <AquariumArt {...props} />;
    case "speed88":
      return <SpeedoArt {...props} />;
    case "odyssey":
      return <OdysseyArt {...props} />;
    case "balloons":
      return <BalloonsArt {...props} />;
    case "catch":
      return <CatchArt {...props} demo={quiet} bindKeys={quiet ? undefined : windowArrows} />;
  }
}
