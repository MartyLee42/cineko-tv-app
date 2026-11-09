// «Нуар»: a dark office at night — light through window blinds falling across the room from the
// top right, the window frame's shadow, a vignette, rain on the glass with a few drops running
// down (transform only); a slow ceiling-fan shadow sweeps across Home's hero.
import { rand } from "@martytv/ui/decor";
import type { WebLook } from "../look";
import "./noir.css";

const STREAKS = (() => {
  const r = rand(1946);
  return Array.from({ length: 70 }, (_, i) => ({
    x: +((i / 70) * 100 + r() * 1.2).toFixed(2),
    y: Math.round(-6 + r() * 100),
    len: Math.round(30 + r() * 110),
    o: +(0.05 + r() * 0.14).toFixed(2),
    run: i % 6 === 2,
    d: -Math.round(r() * 16),
  }));
})();

function Blinds() {
  return (
    <svg className="wd-fill" viewBox="0 0 1920 1080" preserveAspectRatio="xMaxYMin slice">
      <defs>
        <linearGradient id="nrw-slat" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#f2efe6" stopOpacity="0" />
          <stop offset=".18" stopColor="#f2efe6" stopOpacity=".13" />
          <stop offset=".55" stopColor="#f2efe6" stopOpacity=".055" />
          <stop offset="1" stopColor="#f2efe6" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="nrw-glow" cx="1500" cy="260" r="900" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f2efe6" stopOpacity=".07" />
          <stop offset="1" stopColor="#f2efe6" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="1920" height="1080" fill="url(#nrw-glow)" />
      <g transform="translate(1180 -330) rotate(148)">
        {Array.from({ length: 11 }, (_, i) => (
          <rect key={i} x="0" y={-i * 76 - 46} width="2100" height="46" fill="url(#nrw-slat)" />
        ))}
        <rect x="520" y="-860" width="26" height="900" fill="#0c0c0d" opacity=".6" />
      </g>
    </svg>
  );
}

function Scene() {
  return (
    <div className="nr-scene wd-fill">
      <Blinds />
      <div className="nr-rain wd-fill">
        {STREAKS.map((s) => (
          <span key={s.x} className={`nr-streak ${s.run ? "nr-run" : ""}`} style={{ left: `${s.x}%`, top: `${s.y}%`, height: s.len, opacity: s.o, animationDelay: s.run ? `${s.d}s` : undefined }} />
        ))}
      </div>
      <div className="nr-vignette wd-fill" />
    </div>
  );
}

function HeroEdges() {
  return <div className="nr-fan" />;
}

export const look: WebLook = { Scene, HeroEdges };
