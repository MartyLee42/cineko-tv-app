// «Ретро 80-е»: a navy VHS night — a striped sunset low on the right, the four tape-label
// stripes rising across the bottom, tracking lines; over Home's hero tape stripes and a tracking band.
import type { WebLook } from "../look";
import "./retro80.css";

const STRIPES = ["#ff3b5c", "#ff7a1a", "#ffd23a", "#16e0d0"];

/** Rainbow tape stripes rising to the right (a stretchable band). */
function TapeStripes({ className }: { className: string }) {
  const w = 1920;
  const h = 150;
  const band = h / 6;
  return (
    <svg className={className} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      {STRIPES.map((c, i) => {
        const y0 = h - band * (i + 1) * 1.05;
        return <polygon key={c} points={`0,${y0 + band} 0,${y0} ${w},${y0 - h * 0.35} ${w},${y0 - h * 0.35 + band}`} fill={c} />;
      })}
    </svg>
  );
}

function Sun() {
  return (
    <svg className="r8-sun" viewBox="0 0 600 600">
      <defs>
        <linearGradient id="r8w-sun" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffd23a" />
          <stop offset=".5" stopColor="#ff7a1a" />
          <stop offset="1" stopColor="#ff3b8c" />
        </linearGradient>
      </defs>
      <circle cx="300" cy="300" r="300" fill="url(#r8w-sun)" />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <rect key={i} x="0" y={120 + i * 34 + i * i * 2} width="600" height={4 + i * 3} fill="rgb(11,14,42)" />
      ))}
    </svg>
  );
}

function Scene() {
  return (
    <div className="r8-scene wd-fill">
      <Sun />
      <TapeStripes className="r8-stripes" />
      <div className="r8-tracking wd-fill" />
      <div className="r8-band" />
    </div>
  );
}

function HeroEdges() {
  return (
    <>
      <TapeStripes className="r8-hero-stripes" />
      <div className="r8-hero-band" />
    </>
  );
}

export const look: WebLook = { Scene, HeroEdges };
