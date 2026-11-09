// «Мультфильм» (light): the TV's gouache scenery — a warm paper sky with a sun and paper clouds
// drifting by, three cut-out hills with firs and round ochre trees along the bottom, a slow fog
// band; paper clouds hang over Home's hero. Motion: transform-only drifts.
import { hillPath } from "@martytv/ui/decor";
import type { WebLook } from "../look";
import "./mult.css";

const FIR = "#8ea582";
const FIR_DARK = "#7a926f";
const CROWN = "#d4a861";
const TRUNK = "#8c6b4f";
const PAPER = "#fffaf0";
const SHADE = "rgba(96,64,40,.12)";

const HILLS: [string, string][] = [
  [hillPath(938, [[18, 900, 0.4], [9, 380, 1.7]]), "#d5dccd"],
  [hillPath(985, [[22, 1150, 2.1], [8, 300, 0.2]]), "#c3cea5"],
  [hillPath(1035, [[14, 760, 4.0], [6, 260, 1.1]]), "#afbd8b"],
];

function Fir({ x, y, s, dark }: { x: number; y: number; s: number; dark?: boolean }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <rect x={-5} y={-8} width={10} height={20} fill={TRUNK} />
      {[0, 1, 2].map((i) => (
        <path key={i} d={`M0 ${-118 + i * 34} L${34 + i * 9} ${-50 + i * 30} L${-34 - i * 9} ${-50 + i * 30} Z`} fill={dark ? FIR_DARK : FIR} />
      ))}
    </g>
  );
}

function Round({ x, y, s }: { x: number; y: number; s: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <rect x={-4} y={-50} width={8} height={56} fill={TRUNK} />
      <ellipse cx={3} cy={-82} rx={40} ry={44} fill={SHADE} />
      <ellipse cx={0} cy={-86} rx={40} ry={44} fill={CROWN} />
    </g>
  );
}

/** A paper cloud (its own SVG, so CSS can drift it). */
export function Cloud({ className }: { className: string }) {
  const puffs: [number, number, number][] = [[-52, 6, 30], [-18, -10, 40], [24, -4, 34], [58, 8, 26]];
  return (
    <svg className={className} viewBox="-90 -56 184 100">
      {puffs.map(([cx, cy, r], i) => (
        <circle key={`s${i}`} cx={cx + 3} cy={cy + 6} r={r} fill={SHADE} />
      ))}
      <rect x={-77} y={10} width={164} height={30} rx={15} fill={SHADE} />
      {puffs.map(([cx, cy, r], i) => (
        <circle key={i} cx={cx} cy={cy} r={r} fill={PAPER} />
      ))}
      <rect x={-80} y={4} width={164} height={30} rx={15} fill={PAPER} />
    </svg>
  );
}

function Scene() {
  return (
    <div className="mu-scene wd-fill">
      <svg className="mu-sun" viewBox="0 0 240 240">
        <circle cx="120" cy="120" r="118" fill="#f8e2b8" opacity=".7" />
        <circle cx="120" cy="120" r="78" fill="#f4c586" />
      </svg>
      <Cloud className="mu-cloud mu-cloud-a" />
      <Cloud className="mu-cloud mu-cloud-b" />
      <svg className="mu-hills" viewBox="0 870 1920 210" preserveAspectRatio="xMidYMax slice">
        {HILLS.map(([d, fill], i) => (
          <g key={i}>
            <path d={d} fill={SHADE} transform="translate(0 -5)" />
            <path d={d} fill={fill} />
            {i === 0 && (
              <>
                <Fir x={1560} y={948} s={0.4} />
                <Fir x={1600} y={946} s={0.3} dark />
                <Round x={760} y={950} s={0.38} />
                <Fir x={1080} y={944} s={0.34} dark />
              </>
            )}
            {i === 1 && (
              <>
                <Fir x={150} y={1000} s={1.1} dark />
                <Fir x={250} y={1004} s={0.8} />
                <Fir x={890} y={996} s={0.62} />
                <Round x={1010} y={1000} s={0.5} />
                <Round x={1290} y={995} s={0.6} />
                <Fir x={1820} y={990} s={0.7} />
              </>
            )}
          </g>
        ))}
      </svg>
      <div className="mu-fog" />
    </div>
  );
}

function HeroEdges() {
  return (
    <>
      <Cloud className="mu-hero-cloud mu-hero-cloud-a" />
      <Cloud className="mu-hero-cloud mu-hero-cloud-b" />
    </>
  );
}

export const look: WebLook = { Scene, HeroEdges };
