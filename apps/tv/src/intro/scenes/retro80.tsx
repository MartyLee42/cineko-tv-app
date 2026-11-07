// The startup intro in «retro80» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import { DESIGN_SWATCH } from "@martytv/ui";
import { delay, Mascot } from "../parts";
import "./retro80.css";

// ================================================================ Ретро 80-е

const TAPE = ["#ff3b5c", "#ff7a1a", "#ffd23a", "#16e0d0"];

/** VCR: «PLAY ▶» on blue noise, tracking bars roll, then a chrome logo over a striped sunset and tape stripes. */
export function Scene() {
  const sw = DESIGN_SWATCH.retro80;
  const vcr = "'JetBrains Mono', ui-monospace, monospace";
  return (
    <>
      <div className="in-abs" style={{ width: 1280, height: 720, background: "linear-gradient(180deg, #0b0e2a 0%, #1a1240 70%, #34103e 100%)" }} />
      {/* The sun rises behind the horizon (stripes cut in the navy). */}
      <div className="in-abs r8i-sun" style={{ left: 440, top: 300, width: 400, height: 400, borderRadius: "50%", background: "linear-gradient(180deg, #ffd23a 0%, #ff7a1a 50%, #ff3b8c 100%)" }} />
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="in-abs" style={{ left: 420, top: 470 + i * 26 + i * i * 2, width: 440, height: 4 + i * 2.5, background: "#1a1240" }} />
      ))}
      <div className="in-abs" style={{ left: 0, top: 560, width: 1280, height: 160, background: "linear-gradient(180deg, #0b0e2a 0%, #0b0e2a 100%)" }} />
      {/* Tape stripes sweep in under the logo. */}
      <svg className="in-abs r8i-stripes" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        {TAPE.map((c, i) => (
          <polygon key={c} points={`0,${640 - i * 22} 0,${618 - i * 22} 1280,${470 - i * 22} 1280,${492 - i * 22}`} fill={c} />
        ))}
      </svg>
      {/* Static noise bands roll down like a VCR finding the tracking. */}
      <div className="in-abs r8i-noise" style={{ width: 1280, height: 720 }}>
        <div style={{ position: "absolute", left: 0, top: 120, width: 1280, height: 26, background: "repeating-linear-gradient(90deg, rgba(255,255,255,.55) 0 3px, rgba(255,255,255,.08) 3px 9px, rgba(255,255,255,.4) 9px 11px, rgba(255,255,255,0) 11px 20px)" }} />
        <div style={{ position: "absolute", left: 0, top: 420, width: 1280, height: 14, background: "repeating-linear-gradient(90deg, rgba(255,255,255,.35) 0 5px, rgba(255,255,255,0) 5px 14px)" }} />
      </div>
      <div className="in-abs r8i-blue" style={{ width: 1280, height: 720, background: "#1f2bd8" }} />
      <div className="in-abs" style={{ left: 64, top: 44, fontFamily: vcr, fontWeight: 500, fontSize: 40, color: "#fff", letterSpacing: ".08em", textShadow: "3px 3px 0 rgba(0,0,0,.45)" }}>
        <span className="r8i-osd">PLAY ▶</span>
      </div>
      <div className="in-abs in-fade" style={{ left: 1004, top: 646, fontFamily: vcr, fontSize: 26, color: "#fff", letterSpacing: ".08em", ...delay(0.2) }}>
        SP 0:00:03
      </div>
      {/* Chrome logo: MARTY (horizon gradient) + the tape-teal TV block. */}
      <div className="in-abs r8i-logo" style={{ top: 214, width: 1280, display: "flex", justifyContent: "center", alignItems: "center", gap: 24 }}>
        <Mascot color={sw.accent} ink={sw.bg} size={128} />
        <span style={{ fontFamily: "'Russo One', Unbounded, sans-serif", fontStyle: "italic", fontSize: 150, lineHeight: 1.1, padding: "0 .12em 0 0",
          backgroundImage: "linear-gradient(180deg, #ffffff 0%, #d8e6ff 38%, #6a7dff 50%, #ffb04a 53%, #ff7a1a 74%, #ffe7a0 100%)",
          WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent", WebkitTextFillColor: "transparent" }}>
          CINEKO
        </span>
        <span className="r8i-tv" style={{ fontFamily: "'Russo One', Unbounded, sans-serif", fontStyle: "italic", fontSize: 104, lineHeight: 1, padding: "8px 26px 14px", background: sw.accent2, color: sw.bg, transform: "skewX(-10deg)" }}>TV</span>
      </div>
      <div className="in-abs in-fade" style={{ top: 150, width: 1280, textAlign: "center", fontFamily: "'Russo One', sans-serif", fontSize: 30, letterSpacing: ".34em", color: "#ffd23a", ...delay(1.7) }}>
        ВИДЕОСАЛОН ОТКРЫТ
      </div>
      <div className="in-abs in-scan" style={{ width: 1280, height: 720 }} />
    </>
  );
}
