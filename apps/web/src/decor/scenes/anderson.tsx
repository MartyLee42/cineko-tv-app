// «Симметрия»: a pastel storybook in perfect symmetry — powder-pink striped wallpaper, a mustard
// double frame round the window with a mint crest at the bottom centre, the striped awning's
// scalloped fringe under the header; a cream frame inside Home's hero. Static.
import type { WebLook } from "../look";
import "./anderson.css";

function Scene() {
  return (
    <div className="an-scene wd-fill">
      <div className="an-frame" />
      <svg className="an-crest" viewBox="-70 -16 140 32">
        <path d="M-60 0 H-14 M14 0 H60" stroke="#d9a520" strokeWidth="2" />
        <path d="M0 -12 L12 0 L0 12 L-12 0 Z" fill="#8fcfb8" stroke="#d9a520" strokeWidth="2" />
        <circle cx="-66" cy="0" r="3" fill="#d9a520" />
        <circle cx="66" cy="0" r="3" fill="#d9a520" />
      </svg>
    </div>
  );
}

function HeroEdges() {
  return <div className="an-hero-frame" />;
}

export const look: WebLook = { Scene, HeroEdges };
