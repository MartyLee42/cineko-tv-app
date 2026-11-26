// The startup intro in «replicant» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import { Oscilloscope, REPLICANT_HOLO, SpectralBand } from "@martytv/ui/decor/replicant";
import { delay } from "../parts";
import "./replicant.css";

// ================================================================ Репликант

const WIDE = "'Unbounded', 'Onest', sans-serif";
const SERIF = "'Cormorant Garamond', 'Times New Roman', serif";

/**
 * Black like an opening credit: blue sync spikes flash, an orange oscilloscope trace runs across and
 * blooms pink and cyan; the giant hologram of Cineko flickers on over it, the credit fades in in a
 * film serif, «CINEKO» in wide thin capitals with the colours split, and an amber spectral band reads
 * along the foot.
 */
export function Scene() {
  return (
    <>
      <div className="in-abs rpi-black" style={{ width: 1280, height: 720 }} />
      {/* The scope: the trace draws in from the left, then the bloom opens; it dims under the hologram. */}
      <div className="in-abs rpi-scope" style={{ top: 150, width: 1280, height: 360 }}>
        <div className="rpi-draw" style={{ width: 1280, height: 360 }}>
          <Oscilloscope width={1280} height={360} bloom={1} />
        </div>
      </div>
      {/* The hologram of Cineko, flickering on (mirrored, facing the credit). */}
      <div className="in-abs rpi-holo" style={{ left: 760, top: 70, width: 480, height: 520, ...delay(1.15) }}>
        <img src={REPLICANT_HOLO} alt="" width={480} height={520} style={{ transform: "scaleX(-1)" }} />
      </div>
      {/* The credit. */}
      <div className="in-abs" style={{ left: 80, top: 280, width: 720 }}>
        <p className="in-fade rpi-credit" style={{ fontFamily: SERIF, ...delay(1.35) }}>
          Студия <span className="rpi-credit-big">Cineko</span> представляет
        </p>
        <p className="rpi-logo" style={{ fontFamily: WIDE, ...delay(1.7) }}>
          CINEKO
        </p>
        <p className="in-fade rpi-tag" style={{ fontFamily: SERIF, ...delay(2.05) }}>
          фильмы · сериалы · тв
        </p>
      </div>
      {/* The amber spectral band along the foot, uncovered left to right. */}
      <div className="in-abs" style={{ left: 0, top: 600, width: 1280, height: 90, overflow: "hidden" }}>
        <SpectralBand width={1280} height={90} digits={false} />
        <div className="rpi-cover" style={delay(1.5)} />
      </div>
    </>
  );
}
