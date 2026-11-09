// «Каркас»: the TV's synthwave night for any window — a starry sky, a striped sun sinking
// behind wireframe mountains, a neon horizon and a grid floor running towards the viewer
// (one CSS 3D plane; transform-only animation). A perspective grid over Home's hero.
import { floorLines, starField, sunGaps, wireRidge } from "@martytv/ui/decor";
import type { WebLook } from "../look";
import "./wireframe.css";

const STARS = starField(46, 7, 1920, 560);
/** Wide windows: the TV's three ridges (a 1920×240 strip standing on the horizon). */
const RIDGES_WIDE = [wireRidge(-40, 760, 230, 3, 240), wireRidge(1460, 1960, 190, 11, 240), wireRidge(620, 1180, 110, 5, 240)];
/** Phones: a 600-wide strip, one ridge each side and a low one in the middle. */
const RIDGES_NARROW = [wireRidge(-30, 300, 170, 3, 240), wireRidge(330, 640, 140, 11, 240), wireRidge(180, 440, 70, 5, 240)];
const GAPS = sunGaps(7, 226, 19, 1.3, 3, 2.3);
/** Floor: lines converging on the horizon's centre, and cross lines spaced by FLOOR_R (one animation step scales by 1/FLOOR_R). */
const FLOOR_R = 0.78;
const FLOOR_XS = Array.from({ length: 31 }, (_, i) => -3840 + i * 320);
const FLOOR_LINES = floorLines(760, FLOOR_R, 22);

function Ridges({ ridges, width, className }: { ridges: ReturnType<typeof wireRidge>[]; width: number; className: string }) {
  return (
    <svg className={`wf-mtn ${className}`} viewBox={`0 0 ${width} 240`} preserveAspectRatio="xMidYMax slice">
      {ridges.map((r, i) => (
        <g key={i} opacity={i === 2 ? 0.75 : 1}>
          <polygon points={r.poly} fill="#14062c" stroke="#3ce8ff" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {r.wires.map(([x1, y1, x2, y2], j) => (
            <line key={j} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#3ce8ff" strokeOpacity=".38" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
          ))}
        </g>
      ))}
    </svg>
  );
}

/** The striped sun (its own square SVG, sized and placed by CSS). */
export function SynthSun({ id = "wf", className = "" }: { id?: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 420 420">
      <defs>
        <linearGradient id={`${id}-sun`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe66b" />
          <stop offset=".45" stopColor="#ff9a3d" />
          <stop offset="1" stopColor="#ff2fa8" />
        </linearGradient>
        <mask id={`${id}-sun-mask`}>
          <rect width="420" height="420" fill="#fff" />
          {GAPS.map((g) => (
            <rect key={g.y} x="0" y={g.y} width="420" height={g.h} fill="#000" />
          ))}
        </mask>
      </defs>
      <circle cx="210" cy="210" r="200" fill={`url(#${id}-sun)`} mask={`url(#${id}-sun-mask)`} />
    </svg>
  );
}

function Scene() {
  return (
    <div className="wf-scene wd-fill">
      <svg className="wf-stars" viewBox="0 0 1920 560" preserveAspectRatio="xMidYMid slice">
        {STARS.map((s, i) => (
          <circle key={i} cx={s.x} cy={s.y} r={s.r} fill="#fff" opacity={s.o} />
        ))}
      </svg>
      <div className="wf-sunbox">
        <div className="wf-glow" />
        <SynthSun className="wf-sun" />
      </div>
      <Ridges ridges={RIDGES_WIDE} width={1920} className="wd-wide" />
      <Ridges ridges={RIDGES_NARROW} width={600} className="wd-narrow" />
      <div className="wf-floor">
        <svg className="wd-fill" viewBox="0 0 1920 480" preserveAspectRatio="none">
          {FLOOR_XS.map((x) => (
            <line key={x} x1="960" y1="0" x2={x} y2="480" stroke="#ff4fd8" strokeOpacity=".7" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
        <div className="wf-lines">
          <svg className="wd-fill" viewBox="0 0 1920 800" preserveAspectRatio="none">
            {FLOOR_LINES.map((y) => (
              <rect key={y} x="0" y={y} width="1920" height={1.4 + y * 0.006} fill="#ff4fd8" opacity=".8" />
            ))}
          </svg>
        </div>
        <div className="wf-floor-fade wd-fill" />
      </div>
      <div className="wf-horizon" />
      <div className="wf-veil" />
    </div>
  );
}

/** A static perspective grid on the lower part of the artwork, fading out under the text. */
function HeroEdges() {
  const xs = Array.from({ length: 25 }, (_, i) => -2400 + i * 300);
  const ys = [0.02, 0.06, 0.12, 0.2, 0.31, 0.45, 0.63, 0.85];
  return (
    <svg className="wf-hero-grid" viewBox="0 0 1920 400" preserveAspectRatio="none">
      {xs.map((x) => (
        <line key={x} x1={960 + (x - 960) * 0.04} y1="0" x2={x} y2="400" stroke="#ff4fd8" strokeOpacity=".55" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      ))}
      {ys.map((f) => (
        <line key={f} x1="0" y1={f * 400} x2="1920" y2={f * 400} stroke="#ff4fd8" strokeOpacity={0.25 + f * 0.5} strokeWidth={1 + f * 1.6} vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

export const look: WebLook = { Scene, HeroEdges };
