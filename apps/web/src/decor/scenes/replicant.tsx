// «Репликант»: the megacity in violet fog under the giant pink hologram of Cineko, a lone figure on the
// wet walkway, rain (@martytv/ui decor/replicant, the TV's background); over Home's hero scanlines, a
// hologram grade and an amber spectral band along the foot.
import { HoloCity, SpectralBand } from "@martytv/ui/decor/replicant";
import type { WebLook } from "../look";
import "./replicant.css";

function Scene() {
  return (
    <div className="rp-scene wd-fill">
      <HoloCity className="rp-city" width="100%" height="100%" preserveAspectRatio="xMaxYMax slice" />
    </div>
  );
}

function HeroEdges() {
  return (
    <>
      <div className="rp-grade" />
      <div className="rp-scanlines" />
      <SpectralBand className="rp-band" width="100%" height={26} digits={false} />
    </>
  );
}

export const look: WebLook = { Scene, HeroEdges };
