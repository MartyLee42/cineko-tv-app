// The startup intro in «odyssey» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import { DESIGN_SWATCH } from "@martytv/ui";
import { rand } from "../../design/looks/common";
import { delay } from "../parts";
import "./odyssey.css";

// ================================================================ Одиссея

/** Planet: a huge circle whose top crosses the stage just below the middle, on the centre axis. */
const CX = 640;
const LIMB = 330;
const R = 900;

const STARS = (() => {
  const r = rand(2001);
  return Array.from({ length: 90 }, () => ({ x: Math.round(r() * 1280), y: Math.round(r() * 720), r: +(0.5 + r() * 1).toFixed(2), o: +(0.3 + r() * 0.6).toFixed(2) }));
})();

/**
 * Space-age dawn: stars, the moon slides onto the centre axis, the planet's limb rises, the sun
 * breaks over it with a flare, a black slab rises into the frame on the left, then «CINEKO» in wide
 * spaced capitals fades in over the planet's night side and a red status light comes on.
 */
export function Scene() {
  const sw = DESIGN_SWATCH.odyssey;
  return (
    <>
      <div className="in-abs" style={{ width: 1280, height: 720, background: sw.bg }} />
      <svg className="in-abs in-fade" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true" style={{ animationDuration: ".7s" }}>
        {STARS.map((s, i) => (
          <circle key={i} cx={s.x} cy={s.y} r={s.r} fill="#fff" opacity={s.o} />
        ))}
      </svg>
      {/* The moon: a thin crescent sliding down onto the axis. */}
      <svg className="in-abs odi-moon" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        <circle cx={CX} cy="96" r="26" fill="#dfe6f0" />
        <circle cx={CX} cy="103" r="25.5" fill={sw.bg} />
      </svg>
      {/* The sun behind the limb: rises a little, then the flare opens. */}
      <svg className="in-abs odi-sun" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        <defs>
          <radialGradient id="odi-glare" cx={CX} cy={LIMB - 4} r="260" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#fff" stopOpacity=".7" />
            <stop offset=".14" stopColor="#fff4e0" stopOpacity=".25" />
            <stop offset="1" stopColor="#fff4e0" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx={CX} cy={LIMB - 4} r="260" fill="url(#odi-glare)" />
        <circle cx={CX} cy={LIMB - 4} r="10" fill="#fff" />
      </svg>
      <svg className="in-abs odi-flare" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        <ellipse cx={CX} cy={LIMB - 3} rx="380" ry="1.5" fill="#fff" opacity=".7" />
        <ellipse cx={CX} cy={LIMB - 3} rx="110" ry="2.6" fill="#fff" opacity=".8" />
      </svg>
      {/* The planet with its lit rim (layered strokes, no blur). */}
      <svg className="in-abs odi-planet" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        <defs>
          <radialGradient id="odi-face" cx={CX} cy={LIMB} r="760" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#1b2a44" />
            <stop offset=".4" stopColor="#09111e" />
            <stop offset="1" stopColor="#04060c" />
          </radialGradient>
          <linearGradient id="odi-rim" x1={CX - 600} y1="0" x2={CX + 600} y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#9fd8ff" stopOpacity="0" />
            <stop offset=".4" stopColor="#bfe6ff" stopOpacity=".85" />
            <stop offset=".5" stopColor="#fff" />
            <stop offset=".6" stopColor="#bfe6ff" stopOpacity=".85" />
            <stop offset="1" stopColor="#9fd8ff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <circle cx={CX} cy={LIMB + R} r={R} fill="url(#odi-face)" />
        {[
          [34, 0.05],
          [14, 0.12],
          [6, 0.25],
          [2.2, 0.9],
        ].map(([w, o]) => (
          <circle key={w} cx={CX} cy={LIMB + R} r={R} fill="none" stroke="url(#odi-rim)" strokeWidth={w} opacity={o} />
        ))}
      </svg>
      {/* The slab rising into the frame (1 : 4 : 9-ish), rim-lit from the sun's side. */}
      <div className="in-abs odi-slab" style={{ left: 150, top: 236, width: 62, height: 520 }}>
        <svg viewBox="0 0 62 520" width="62" height="520" aria-hidden="true">
          <defs>
            <linearGradient id="odi-slab" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#000" />
              <stop offset=".86" stopColor="#06080b" />
              <stop offset="1" stopColor="#1a1f28" />
            </linearGradient>
          </defs>
          <rect width="62" height="520" fill="url(#odi-slab)" />
          <rect x="60.6" width="1.4" height="520" fill="#d6e0ee" opacity=".7" />
          <rect width="62" height="1.2" fill="#d6e0ee" opacity=".45" />
        </svg>
      </div>
      {/* The wordmark over the night side, a thin rule and the red status light. */}
      <div className="in-abs odi-word" style={{ top: 470, width: 1280, textAlign: "center", ...delay(1.95) }}>
        <span style={{ fontFamily: "Unbounded, 'Onest', sans-serif", fontWeight: 300, fontSize: 62, lineHeight: 1, letterSpacing: ".42em", paddingLeft: ".42em", color: "#f4f6fa" }}>CINEKO</span>
      </div>
      <div className="in-abs odi-rule" style={{ left: 440, top: 566, width: 400, height: 1, background: "rgba(255,255,255,.55)", ...delay(2.2) }} />
      <div className="in-abs odi-eye" style={{ left: 634, top: 588, width: 12, height: 12, borderRadius: 6, background: "radial-gradient(circle, #fff3dc 0px, #ffb08a 2px, #ff3b2f 4.5px, #b3120a 6px)", boxShadow: "0 0 10px 3px rgba(255,59,47,.75), 0 0 26px 8px rgba(255,59,47,.3)", ...delay(2.45) }} />
    </>
  );
}
