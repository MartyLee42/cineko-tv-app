// «Ретро 80-е»: a navy VHS night with a striped sunset and tape stripes.
import "./retro80.css";
import type { Look } from "./types";
import { layer } from "./common";

/** The four tape-label stripes of an 80s cassette / VHS sleeve. */
const RETRO_STRIPES = ["#ff3b5c", "#ff7a1a", "#ffd23a", "#16e0d0"];

/** Rainbow tape stripes rising to the right (a static SVG band, bottom-anchored). */
function TapeStripes({ width, height, className = "", style }: { width: number; height: number; className?: string; style?: React.CSSProperties }) {
  const band = height / 6;
  return (
    <svg className={`pointer-events-none ${className}`} style={style} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      {RETRO_STRIPES.map((c, i) => {
        const y0 = height - band * (i + 1) * 1.05;
        return <polygon key={c} points={`0,${y0 + band} 0,${y0} ${width},${y0 - height * 0.35} ${width},${y0 - height * 0.35 + band}`} fill={c} />;
      })}
    </svg>
  );
}

/** Navy VHS night: a striped sunset low on the right, tape stripes and faint tracking lines (static). */
function VhsBackground({ sun }: { sun: boolean }) {
  return (
    <div data-skin-bg="vhs" className={`r8-vhs ${layer}`}>
      {sun && (
        <svg className="absolute left-0 top-0" width="1920" height="1080" viewBox="0 0 1920 1080" aria-hidden>
          <defs>
            <linearGradient id="r8-sun" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#ffd23a" />
              <stop offset=".5" stopColor="#ff7a1a" />
              <stop offset="1" stopColor="#ff3b8c" />
            </linearGradient>
          </defs>
          <g opacity=".34">
            <circle cx="1560" cy="1010" r="300" fill="url(#r8-sun)" />
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <rect key={i} x="1200" y={830 + i * 34 + i * i * 2} width="720" height={4 + i * 3} fill="rgb(11,14,42)" />
            ))}
          </g>
        </svg>
      )}
      <TapeStripes width={1920} height={150} className="absolute bottom-0 left-0 opacity-[.16]" />
      <div className="r8-tracking absolute left-0 top-0 h-full w-full" />
    </div>
  );
}

/** Over Home's hero artwork: tape stripes and a tracking band. */
function TapeHeroEdges({ height }: { height: number }) {
  return (
    <>
      <TapeStripes width={520} height={120} className="absolute bottom-0 right-0 opacity-[.85]" />
      <div className="r8-tracking-band pointer-events-none absolute left-0 w-full" style={{ top: Math.round(height * 0.72), height: 10 }} />
    </>
  );
}

export const look: Look = { Background: ({ dim }) => <VhsBackground sun={!dim} />, HeroEdges: TapeHeroEdges };
