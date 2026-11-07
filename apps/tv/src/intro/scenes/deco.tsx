// The startup intro in «deco» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import { type ReactNode } from "react";
import { DESIGN_SWATCH } from "@martytv/ui";
import { delay, Mascot } from "../parts";
import "./deco.css";

// ================================================================ Ар-деко

export function Scene() {
  const sw = DESIGN_SWATCH.deco;
  const rays: ReactNode[] = [];
  for (let i = 0; i < 25; i++) {
    const a = Math.PI + (i / 24) * Math.PI;
    const a1 = a - 0.025, a2 = a + 0.025, R = 760;
    rays.push(<polygon key={i} points={`640,720 ${640 + R * Math.cos(a1)},${720 + R * Math.sin(a1)} ${640 + R * Math.cos(a2)},${720 + R * Math.sin(a2)}`} fill={sw.accent} fillOpacity={i % 2 ? 0.1 : 0.2} />);
  }
  // A half sunburst fan (the deco ornament beside the title).
  const fan = () => (
    <svg viewBox="0 0 124 66" width="124" height="66" aria-hidden="true">
      {[0, 1, 2, 3, 4, 5, 6].map((i) => {
        const a = Math.PI + (i / 6) * Math.PI;
        return <line key={i} x1="62" y1="62" x2={62 + 54 * Math.cos(a)} y2={62 + 54 * Math.sin(a)} stroke={sw.accent} strokeWidth="2" />;
      })}
      <path d="M4 62 A58 58 0 0 1 120 62" fill="none" stroke={sw.accent2} strokeWidth="2" />
      <line x1="0" y1="63" x2="124" y2="63" stroke={sw.accent} strokeWidth="2" />
    </svg>
  );
  return (
    <>
      <svg className="in-abs in-burst" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        {rays}
      </svg>
      <svg className="in-abs" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        <rect className="in-draw" pathLength={1000} x="70" y="60" width="1140" height="600" fill="none" stroke={sw.accent} strokeWidth="3" />
        <rect className="in-draw" pathLength={1000} x="86" y="76" width="1108" height="568" fill="none" stroke={sw.accent2} strokeOpacity=".6" strokeWidth="1.5" style={delay(0.45)} />
      </svg>
      <div className="in-abs in-up" style={{ top: 186, width: 1280, display: "flex", justifyContent: "center", ...delay(0.7) }}>
        <Mascot color={sw.accent} ink={sw.bg} size={110} cheeks={false} />
      </div>
      <div className="in-abs in-up" style={{ top: 316, width: 1280, display: "flex", justifyContent: "center", alignItems: "center", gap: 28, ...delay(0.95) }}>
        {fan()}
        <span style={{ fontFamily: "'Playfair Display', Georgia, serif", fontWeight: 700, fontSize: 120, lineHeight: 1, color: sw.accent2, letterSpacing: ".02em" }}>
          Cineko<span style={{ color: sw.accent }}>TV</span>
        </span>
        {fan()}
      </div>
      <div className="in-abs in-rule" style={{ left: 390, top: 476, width: 500, height: 2, background: sw.accent }} />
      <div className="in-abs in-rule" style={{ left: 440, top: 484, width: 400, height: 1, background: sw.accent2, ...delay(1.4) }} />
      <p className="in-abs in-fade" style={{ top: 506, width: 1280, textAlign: "center", fontFamily: "'Playfair Display', Georgia, serif", fontStyle: "italic", fontSize: 30, color: "rgba(243,234,214,.75)", ...delay(1.6) }}>
        Сейчас на экране
      </p>
    </>
  );
}
