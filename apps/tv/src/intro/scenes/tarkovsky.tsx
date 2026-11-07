// The startup intro in «tarkovsky» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import { DESIGN_SWATCH } from "@martytv/ui";
import { delay, Mascot } from "../parts";
import { rand } from "../../design/looks/common";
import "./tarkovsky.css";

// ================================================================ Созерцание

const serif = "'Cormorant Garamond', 'Playfair Display', Georgia, serif";

/** Rain streaks on the 1280×720 stage, fixed once: x, y, length, opacity. */
const RAIN = (() => {
  const r = rand(1986);
  return Array.from({ length: 90 }, () => [Math.round(r() * 1320), Math.round(r() * 700), Math.round(30 + r() * 60), +(0.06 + r() * 0.12).toFixed(3)] as const);
})();

/** Dusk over still water: rain appears, Cineko and the name surface slowly with their reflection. */
export function Scene() {
  const sw = DESIGN_SWATCH.tarkovsky;
  const logo = (
    <div style={{ display: "flex", alignItems: "center" }}>
      <Mascot color={sw.accent} ink={sw.bg} size={110} />
      <span style={{ marginLeft: 22, fontFamily: serif, fontWeight: 600, fontSize: 110, lineHeight: 1, letterSpacing: 2, color: sw.text }}>cineko</span>
    </div>
  );
  return (
    <>
      <div className="in-abs tki-ground" style={{ width: 1280, height: 720 }} />
      <svg className="in-abs tki-rain" width="1280" height="720" viewBox="0 0 1280 720" aria-hidden>
        <g stroke="#d8d2bf" strokeWidth="1.2" strokeLinecap="round">
          {RAIN.map(([x, y, l, o], i) => (
            <line key={i} x1={x} y1={y} x2={x - l * 0.12} y2={y + l} opacity={o} />
          ))}
        </g>
      </svg>
      <div className="in-abs tki-mist" style={{ top: 380 }} />
      <div className="in-abs tki-slow" style={{ left: 0, top: 210, width: 1280, display: "flex", justifyContent: "center", ...delay(0.5) }}>
        {logo}
      </div>
      {/* The reflection in the water: the same logo, flipped and faint. */}
      <div className="in-abs tki-slow" style={{ left: 0, top: 336, width: 1280, display: "flex", justifyContent: "center", ...delay(0.8) }}>
        <div className="tki-reflect">{logo}</div>
      </div>
      <p className="in-abs tki-slow" style={{ top: 520, width: 1280, textAlign: "center", fontFamily: serif, fontWeight: 600, fontSize: 34, letterSpacing: ".3em", color: sw.accent, ...delay(1.5) }}>
        тишина · дождь · кино
      </p>
    </>
  );
}
