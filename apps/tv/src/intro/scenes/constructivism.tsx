// The startup intro in «constructivism» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import { DESIGN_SWATCH, MAYAKOVSKY, SloganTicker, SovietEmblem } from "@martytv/ui";
import { delay } from "../parts";
import "./constructivism.css";

// ================================================================ Конструктивизм

/**
 * A 1920s–30s poster assembling on cream paper: a red circle rolls in with
 * Mayakovsky (this design's mascot) in it, the hammer and sickle stamps in,
 * a black bar draws on a diagonal (the name and a changing slogan on it),
 * «КИНО», «СМОТРИ!», «ГОВОРИТ МОСКВА…».
 */
export function Scene() {
  const sw = DESIGN_SWATCH.constructivism;
  const grot = "Oswald, 'Russo One', Onest, sans-serif";
  const red = sw.accent;
  const paper = sw.accent2;
  const ink = "#1a1512";
  return (
    <>
      <div className="in-abs" style={{ width: 1280, height: 720, background: paper }} />
      <svg className="in-abs cvi-wedge" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        <polygon points="0,720 0,500 620,720" fill={red} />
      </svg>
      <div className="in-abs cvi-line" style={{ left: 640, top: 690, width: 760, height: 8, background: ink, ...delay(0.35) }} />
      <div className="in-abs cvi-line" style={{ left: 720, top: 716, width: 700, height: 3, background: ink, ...delay(0.5) }} />
      {/* The red circle rolls in from the right; Mayakovsky pops up in it. */}
      <div className="in-abs cvi-roll" style={{ left: 700, top: 40, width: 420, height: 420, borderRadius: "50%", background: red }} />
      {/* The black diagonal bar with the name on it. */}
      <div className="in-abs cvi-bar" style={{ left: -60, top: 452, width: 1480, height: 118, background: ink, display: "flex", alignItems: "center" }}>
        <span className="in-fade" style={{ marginLeft: 150, fontFamily: grot, fontWeight: 700, fontSize: 92, letterSpacing: ".06em", color: paper, lineHeight: 1, ...delay(1.1) }}>
          CINEKO<span style={{ color: red }}>·</span>TV
        </span>
        <div className="in-fade" style={{ marginLeft: 56, width: 700, ...delay(1.35) }}>
          <SloganTicker ms={1600} className="whitespace-nowrap" style={{ height: 52, fontFamily: grot, fontWeight: 700, fontSize: 36, lineHeight: "52px", letterSpacing: ".04em", textTransform: "uppercase", color: paper }} />
        </div>
      </div>
      {/* A broadcast caption (text only). */}
      <div data-testid="intro-broadcast" className="in-abs in-fade" style={{ left: 40, top: 656, fontFamily: grot, fontWeight: 700, fontSize: 34, lineHeight: 1, letterSpacing: ".1em", color: paper, ...delay(0.45) }}>
        ГОВОРИТ МОСКВА…
      </div>
      {/* Mayakovsky (this design's mascot) pops up in the red circle as a poster tile; the emblem stamps in at the corner. */}
      <div data-testid="intro-mayakovsky" className="in-abs in-pop" style={{ left: 762, top: 38, ...delay(1.0) }}>
        <img src={MAYAKOVSKY} alt="" width={152} height={201} style={{ display: "block", transform: "rotate(-4deg)", outline: `6px solid ${paper}`, outlineOffset: -6, boxShadow: `10px 10px 0 ${ink}` }} />
      </div>
      <div data-testid="intro-emblem" className="in-abs in-pop" style={{ left: 1142, top: 24, ...delay(1.25) }}>
        <SovietEmblem size={112} />
      </div>
      <div className="in-abs cvi-kino" style={{ left: 64, top: 30, fontFamily: grot, fontWeight: 700, fontSize: 210, lineHeight: 1, letterSpacing: ".02em", color: ink }}>
        КИНО
      </div>
      <div className="in-abs cvi-kino" style={{ left: 70, top: 262, width: 330, height: 14, background: red, ...delay(0.2) }} />
      <div className="in-abs in-up" style={{ left: 930, top: 586, ...delay(1.7) }}>
        <span style={{ display: "inline-block", fontFamily: grot, fontWeight: 700, fontSize: 60, lineHeight: 1, letterSpacing: ".08em", color: paper, background: red, padding: "12px 26px 14px", transform: "rotate(-6deg)" }}>СМОТРИ!</span>
      </div>
    </>
  );
}
