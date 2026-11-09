// Mounts the current design's scenery: the fixed background (once, in Layout) and the
// layers over Home's hero. Motion is CSS-only (transform / opacity), stopped by
// prefers-reduced-motion and paused while a video plays (decor.css).
import { useAppliedDesign, useVideoPlaying } from "@martytv/ui";
import { useWebLook } from "./look";
import "./decor.css";

export function DesignDecor() {
  const design = useAppliedDesign();
  const look = useWebLook(design);
  const playing = useVideoPlaying();
  if (!look) return null;
  const { Scene } = look;
  return (
    <div className="wd-layer" data-design={design} data-paused={playing ? "" : undefined} aria-hidden="true">
      <Scene />
    </div>
  );
}

/** Over Home's hero artwork, under its text (HomePage's Hero). */
export function DesignHeroEdges() {
  const look = useWebLook(useAppliedDesign());
  if (!look?.HeroEdges) return null;
  const { HeroEdges } = look;
  return (
    <div className="wd-hero" aria-hidden="true">
      <HeroEdges />
    </div>
  );
}
