// «Созерцание» (a homage to Tarkovsky): the calmest design. A dim ground of wet slate over still
// water, rain as a static texture, ripples, and one very slow mist drift (stopped in calm motion);
// rain on the glass over Home's hero. Posters rest in sepia and their colour slowly returns on focus
// (tarkovsky.css: an opacity fade of a colour-blend veil).
import "./tarkovsky.css";
import type { Look } from "./types";
import { rainStreaks } from "@martytv/ui/decor";
import { layer } from "./common";

/** Rain streaks, fixed once: x, y, length, opacity. Slightly slanted, thin, faint. */
const streaks = rainStreaks;
const RAIN = streaks(150, 1972, 1960, 1000);
const GLASS = streaks(46, 1979, 1320, 690);
const SLANT = 0.12;

/** Ripples on the water: centre, radius. */
const RIPPLES: [number, number, number][] = [
  [380, 1004, 70],
  [1240, 1040, 110],
  [1680, 980, 54],
  [820, 1060, 46],
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

/** The ground: slate gradient and water (CSS), static rain and ripples (SVG), one slow mist layer. */
function RainWater({ calm, dim }: { calm: boolean; dim: boolean }) {
  return (
    <div data-skin-bg="rainwater" data-motion={calm ? "calm" : "on"} className={`tk-ground ${layer}`}>
      <div className="tk-water absolute left-0 w-full" />
      <svg className="absolute left-0 top-0" width="1920" height="1080" viewBox="0 0 1920 1080" aria-hidden>
        <Streaks list={dim ? RAIN.slice(0, 50) : RAIN} stroke="#d8d2bf" />
        <g fill="none" stroke="#d8d2bf" strokeWidth="1.5">
          {RIPPLES.map(([cx, cy, r], i) => (
            <g key={i} opacity={dim ? 0.05 : 0.1}>
              <ellipse cx={cx} cy={cy} rx={r} ry={r * 0.16} />
              <ellipse cx={cx} cy={cy} rx={r * 0.55} ry={r * 0.09} />
            </g>
          ))}
        </g>
      </svg>
      {/* The mist: a doubled soft band slid one width to the left over four minutes (transform only). */}
      <div className={`tk-mist ${calm ? "" : "tk-mist-on"}`} />
    </div>
  );
}

/** Over Home's hero artwork: rain on the glass (static, faint). */
function TarkovskyHeroEdges({ height }: { height: number }) {
  return (
    <svg className="pointer-events-none absolute left-0 top-0" width="1320" height={height} viewBox={`0 0 1320 ${height}`} aria-hidden>
      <Streaks list={GLASS} stroke="#e8e2d0" />
    </svg>
  );
}

export const look: Look = { Background: RainWater, HeroEdges: TarkovskyHeroEdges };
