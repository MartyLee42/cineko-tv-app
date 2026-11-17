// The startup intro in «metro» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import { delay, Mascot } from "../parts";
import "./metro.css";

// ================================================================ Метро

const SANS = "'Jost', 'Futura', Arial, sans-serif";

/** A train pulls into the platform under the «CINEKO» station sign; its doors slide open on Cineko. */
export function Scene() {
  return (
    <>
      <div className="in-abs mxi-wall" style={{ width: 1280, height: 720 }} />
      {/* The station sign over the track. */}
      <div className="in-abs in-fade mxi-sign" style={{ left: 390, top: 70, width: 500, height: 96, ...delay(0.2) }}>
        <svg width="64" height="64" viewBox="0 0 48 48" aria-hidden="true">
          <circle cx="24" cy="24" r="23" fill="#d52028" />
          <path d="M10 34 L17 13 L24 27 L31 13 L38 34" fill="none" stroke="#fff" strokeWidth="5" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        <span style={{ marginLeft: 22, fontFamily: SANS, fontSize: 58, letterSpacing: ".14em", color: "#fff" }}>CINEKO</span>
      </div>
      {/* The train: one car arriving from the right (decelerating), its door in the middle. */}
      <div className="in-abs mxi-train" style={{ left: 140, top: 230, width: 1000, height: 330 }}>
        <div className="mxi-car" />
        <span className="mxi-stripe" />
        {[0, 1, 4, 5].map((i) => (
          <span key={i} className="mxi-window" style={{ left: 60 + i * 150 }} />
        ))}
        <div className="mxi-doorway">
          <div className="in-up" style={{ position: "absolute", left: 91, top: 70, ...delay(1.75) }}>
            <Mascot color="#d52028" ink="#10131a" size={118} />
          </div>
          <span className="mxi-door mxi-door-l" />
          <span className="mxi-door mxi-door-r" />
        </div>
      </div>
      <div className="in-abs mxi-platform" style={{ top: 590, width: 1280, height: 130 }} />
      <p className="in-abs in-fade" style={{ top: 628, width: 1280, textAlign: "center", fontFamily: SANS, fontSize: 30, letterSpacing: ".08em", color: "rgba(240,242,245,.85)", ...delay(1.9) }}>
        осторожно, двери открываются
      </p>
    </>
  );
}
