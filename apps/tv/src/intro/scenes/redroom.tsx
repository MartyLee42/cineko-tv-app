// The startup intro in «redroom» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import { delay, Mascot } from "../parts";
import "./redroom.css";

// ================================================================ Красная комната

const SERIF = "'Playfair Display', Georgia, serif";

/** The curtains part on a red room with a zigzag floor; «cineko» appears backwards, then rights itself. */
export function Scene() {
  return (
    <>
      <div className="in-abs rri-wall" style={{ width: 1280, height: 720 }} />
      {/* The floor in perspective: zigzag bands narrowing towards the back. */}
      <svg className="in-abs" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        <defs>
          <pattern id="rri-zig" width="80" height="40" patternUnits="userSpaceOnUse">
            <rect width="80" height="40" fill="#0d0b0b" />
            <path d="M0 0 L40 20 L80 0 L80 20 L40 40 L0 20 Z" fill="#ece7dd" />
          </pattern>
        </defs>
        <path d="M200 520 L1080 520 L1280 720 L0 720 Z" fill="url(#rri-zig)" />
        <path d="M200 520 L1080 520" stroke="rgba(0,0,0,.6)" strokeWidth="4" />
      </svg>
      <div className="in-abs in-up" style={{ top: 168, width: 1280, display: "flex", justifyContent: "center", ...delay(1.1) }}>
        <Mascot color="#e22c34" ink="#0b0606" size={130} />
      </div>
      {/* The name, mirrored first («sometimes plays backwards»), then flipped the right way. */}
      <div className="in-abs" style={{ top: 316, width: 1280, display: "flex", justifyContent: "center" }}>
        <span className="rri-name" style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 112, lineHeight: 1, letterSpacing: ".12em", color: "#f4efe6" }}>
          CINEKO
        </span>
      </div>
      <p className="in-abs in-fade" style={{ top: 452, width: 1280, textAlign: "center", fontFamily: SERIF, fontStyle: "italic", fontSize: 34, color: "rgba(244,239,230,.85)", ...delay(2) }}>
        кофе, пирог и кино
      </p>
      {/* The curtains: closed over the stage, then drawn apart. */}
      <div className="in-abs rri-curtain rri-curtain-l" style={{ width: 660, height: 720 }} />
      <div className="in-abs rri-curtain rri-curtain-r" style={{ left: 620, width: 660, height: 720 }} />
    </>
  );
}
