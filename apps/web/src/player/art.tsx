// The drawn loading styles (art shared with the TV, @martytv/ui/loaders/*):
// used by the loader and the Settings preview tiles.
import { AquariumArt } from "@martytv/ui/loaders/aquarium";
import { BalloonsArt } from "@martytv/ui/loaders/balloons";
import { OdysseyArt } from "@martytv/ui/loaders/odyssey";
import { PawsArt } from "@martytv/ui/loaders/paws";
import { SpeedoArt } from "@martytv/ui/loaders/speedo";
import type { LoadingStyle } from "../watch/settings";

export const ART_STYLES = ["paws", "aquarium", "speed88", "odyssey", "balloons"] as const;
export type ArtStyleId = (typeof ART_STYLES)[number];

export function isArtStyle(s: LoadingStyle): s is ArtStyleId {
  return (ART_STYLES as readonly string[]).includes(s);
}

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
  }
}
