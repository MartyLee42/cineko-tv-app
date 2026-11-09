// «Созерцание»: the calmest design — wet slate over still water, fine slanted rain falling
// slowly (one layer, transform only), ripples spreading on the water, a very slow mist;
// rain on the glass over Home's hero.
import { rainStreaks } from "@martytv/ui/decor";
import type { WebLook } from "../look";
import "./tarkovsky.css";

const RAIN = rainStreaks(120, 1972, 1960, 1000);
const GLASS = rainStreaks(46, 1979, 1320, 690);
const SLANT = 0.12;
/** Ripples on the water (in a 1920×200 strip): centre, radius, delay (s). */
const RIPPLES: [number, number, number, number][] = [
  [380, 90, 70, 0],
  [1240, 140, 110, -3],
  [1680, 70, 54, -6],
  [820, 160, 46, -8],
  [180, 150, 40, -4.5],
];

function Streaks({ list, stroke }: { list: [number, number, number, number][]; stroke: string }) {
  return (
    <g stroke={stroke} strokeWidth="1.4" strokeLinecap="round">
      {list.map(([x, y, l, o], i) => (
        <line key={i} x1={x} y1={y} x2={x - l * SLANT} y2={y + l} opacity={o} />
      ))}
    </g>
  );
}

function Scene() {
  return (
    <div className="tk-scene wd-fill">
      {/* Two stacked copies of the same rain: sliding by one copy's height loops seamlessly. */}
      <div className="tk-rain">
        <svg viewBox="0 0 1920 1000" preserveAspectRatio="xMidYMid slice">
          <Streaks list={RAIN} stroke="#d8d2bf" />
        </svg>
        <svg viewBox="0 0 1920 1000" preserveAspectRatio="xMidYMid slice">
          <Streaks list={RAIN} stroke="#d8d2bf" />
        </svg>
      </div>
      <div className="tk-water">
        <svg className="wd-fill" viewBox="0 0 1920 200" preserveAspectRatio="xMidYMax slice">
          {RIPPLES.map(([cx, cy, r, d], i) => (
            <g key={i} className="tk-ripple" style={{ transformOrigin: `${cx}px ${cy}px`, animationDelay: `${d}s` }}>
              <ellipse cx={cx} cy={cy} rx={r} ry={r * 0.16} fill="none" stroke="#d8d2bf" strokeWidth="1.5" />
              <ellipse cx={cx} cy={cy} rx={r * 0.55} ry={r * 0.09} fill="none" stroke="#d8d2bf" strokeWidth="1.5" />
            </g>
          ))}
        </svg>
      </div>
      <div className="tk-mist" />
    </div>
  );
}

function HeroEdges() {
  return (
    <svg className="tk-glass" viewBox="0 0 1320 690" preserveAspectRatio="xMidYMid slice">
      <Streaks list={GLASS} stroke="#e8e2d0" />
    </svg>
  );
}

export const look: WebLook = { Scene, HeroEdges };
