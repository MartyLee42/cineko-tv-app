// «Ретро 90-е»: the Windows 95 desktop — flat teal with a faint dither and a few desktop icons
// down the left edge (wide windows); Home's hero gets a window title bar.
import type { WebLook } from "../look";
import "./retro90.css";

/** Desktop icons drawn in the 16-colour palette: a computer, a folder, the recycle bin. */
function Icons() {
  return (
    <svg className="r9-icons wd-wide" viewBox="0 0 64 300">
      <g transform="translate(16 10)">
        <rect x="0" y="0" width="32" height="24" fill="#c0c0c0" stroke="#000" />
        <rect x="4" y="4" width="24" height="16" fill="#000080" />
        <rect x="8" y="26" width="16" height="4" fill="#c0c0c0" stroke="#000" />
      </g>
      <g transform="translate(16 110)">
        <path d="M0 4 H12 L15 8 H32 V28 H0 Z" fill="#ffe85c" stroke="#000" />
        <path d="M0 10 H32" stroke="#a08000" />
      </g>
      <g transform="translate(20 210)">
        <path d="M2 6 H22 L20 32 H4 Z" fill="#c0c0c0" stroke="#000" />
        <rect x="0" y="2" width="24" height="4" fill="#808080" stroke="#000" />
        <path d="M8 10 V28 M12 10 V28 M16 10 V28" stroke="#404040" />
      </g>
    </svg>
  );
}

function Scene() {
  return (
    <div className="r9-scene wd-fill">
      <Icons />
    </div>
  );
}

/** A title bar across the top of Home's hero, with the three window buttons. */
function HeroEdges() {
  return (
    <div className="r9-titlebar">
      <span className="r9-tb-title">Cineko.exe</span>
      <span className="r9-tb-btns">
        <span>_</span>
        <span>□</span>
        <span>×</span>
      </span>
    </div>
  );
}

export const look: WebLook = { Scene, HeroEdges };
