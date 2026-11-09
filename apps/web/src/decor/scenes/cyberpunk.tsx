// «Киберпанк»: the TV's neon city — magenta and cyan haze, a street grid, a skyline of lit
// windows along the bottom (a few flicker), scanlines; chromatic edges and scanlines on Home's hero.
import { skyline } from "@martytv/ui/decor";
import type { WebLook } from "../look";
import "./cyberpunk.css";

const CITY = skyline(23);
/** Every 9th window flickers (one group, opacity only). */
const flickers = (i: number) => i % 9 === 4;

function Scene() {
  return (
    <div className="cp-scene wd-fill">
      <svg className="cp-skyline" viewBox="0 700 1920 380" preserveAspectRatio="xMidYMax slice">
        {CITY.map((b) => (
          <rect key={b.x} x={b.x} y={1080 - b.h} width={b.w} height={b.h} fill="#0c0c16" stroke="#2a2a44" strokeWidth="1" />
        ))}
        <g opacity=".6">
          {CITY.flatMap((b) => b.win)
            .filter((_, i) => !flickers(i))
            .map((w, i) => (
              <rect key={i} x={w.x} y={w.y} width="6" height="3" fill={w.c} />
            ))}
        </g>
        <g className="cp-flicker">
          {CITY.flatMap((b) => b.win)
            .filter((_, i) => flickers(i))
            .map((w, i) => (
              <rect key={i} x={w.x} y={w.y} width="6" height="3" fill={w.c} />
            ))}
        </g>
      </svg>
      <div className="cp-scan wd-fill" />
    </div>
  );
}

function HeroEdges() {
  return (
    <>
      <div className="cp-hero-scan wd-fill" />
      <div className="cp-hero-edge" />
    </>
  );
}

export const look: WebLook = { Scene, HeroEdges };
