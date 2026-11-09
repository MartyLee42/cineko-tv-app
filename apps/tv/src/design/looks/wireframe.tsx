// «Каркас»: a synthwave night — wireframe mountains, a striped sun, a moving grid floor; a grid horizon over Home's hero.
import "./wireframe.css";
import { FLOOR_R } from "../registry";
import type { Look } from "./types";
import { floorLines, starField, sunGaps, wireRidge } from "@martytv/ui/decor";
import { layer } from "./common";

const HORIZON = 600;

const STARS = starField(46, 7, 1920, HORIZON - 120);
const RIDGES = [wireRidge(-40, 760, 230, 3, HORIZON), wireRidge(1460, 1960, 190, 11, HORIZON), wireRidge(620, 1180, 110, 5, HORIZON)];
/** Sun stripes: gaps growing towards the horizon. */
const SUN_GAPS = sunGaps(7, 470, 21, 1.5, 3, 2.2);

/** Static sky, striped sun and wireframe mountains (one SVG, painted once). */
function SynthwaveSky({ sun = true }: { sun?: boolean }) {
  return (
    <svg className={layer} viewBox="0 0 1920 1080" preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id="sw-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0d0420" />
          <stop offset=".62" stopColor="#24073f" />
          <stop offset="1" stopColor="#4c0f63" />
        </linearGradient>
        <linearGradient id="sw-sun" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe66b" />
          <stop offset=".45" stopColor="#ff9a3d" />
          <stop offset="1" stopColor="#ff2fa8" />
        </linearGradient>
        <radialGradient id="sw-glow" cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#ff4fd8" stopOpacity=".45" />
          <stop offset="1" stopColor="#ff4fd8" stopOpacity="0" />
        </radialGradient>
        <mask id="sw-sun-mask">
          <rect x="0" y="0" width="1920" height="1080" fill="#fff" />
          {SUN_GAPS.map((g) => (
            <rect key={g.y} x="0" y={g.y} width="1920" height={g.h} fill="#000" />
          ))}
        </mask>
      </defs>
      <rect x="0" y="0" width="1920" height={HORIZON} fill="url(#sw-sky)" />
      {STARS.map((s, i) => (
        <circle key={i} cx={s.x} cy={s.y} r={s.r} fill="#fff" opacity={s.o} />
      ))}
      {sun && (
        <>
          <circle cx="1380" cy="440" r="330" fill="url(#sw-glow)" />
          <circle cx="1380" cy="440" r="210" fill="url(#sw-sun)" mask="url(#sw-sun-mask)" />
        </>
      )}
      {RIDGES.map((r, i) => (
        <g key={i} opacity={i === 2 ? 0.75 : 1}>
          <polygon points={r.poly} fill="#14062c" stroke="#3ce8ff" strokeWidth="2" strokeLinejoin="round" />
          {r.wires.map(([x1, y1, x2, y2], j) => (
            <line key={j} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#3ce8ff" strokeOpacity=".38" strokeWidth="1.2" />
          ))}
        </g>
      ))}
      <rect x="0" y={HORIZON - 3} width="1920" height="6" fill="#ff4fd8" />
      <rect x="0" y={HORIZON} width="1920" height={1080 - HORIZON} fill="#0d0420" />
    </svg>
  );
}

/** Floor lines: geometric spacing (FLOOR_R) below the horizon, so scaling the layer by 1/R about the horizon maps each line onto the next one. */
const FLOOR_H = 1080 - HORIZON;
const FLOOR_LINES = floorLines(760, FLOOR_R, 22);

/**
 * The neon floor. Converging lines are static; the cross lines are one
 * layer whose only animation is a scaleY about the horizon (transform-only,
 * seamless: 1 → 1/R moves every line onto its neighbour). `calm` stops it.
 */
function SynthwaveFloor({ calm }: { calm: boolean }) {
  const xs = Array.from({ length: 31 }, (_, i) => -3840 + i * 320);
  return (
    <div className="sw-floor pointer-events-none absolute left-0 w-[1920px] overflow-hidden" style={{ top: HORIZON, height: FLOOR_H }}>
      <svg className="absolute left-0 top-0" width="1920" height={FLOOR_H} viewBox={`0 0 1920 ${FLOOR_H}`} aria-hidden>
        {xs.map((x) => (
          <line key={x} x1="960" y1="0" x2={x} y2={FLOOR_H} stroke="#ff4fd8" strokeOpacity=".7" strokeWidth="2" />
        ))}
      </svg>
      <div className={`sw-lines absolute left-0 top-0 w-[1920px] ${calm ? "" : "sw-lines-run"}`} style={{ height: 800 }}>
        <svg width="1920" height="800" viewBox="0 0 1920 800" preserveAspectRatio="none" aria-hidden>
          {FLOOR_LINES.map((y) => (
            <rect key={y} x="0" y={y} width="1920" height={1.4 + y * 0.006} fill="#ff4fd8" opacity=".8" />
          ))}
        </svg>
      </div>
      <div className="sw-floor-fade absolute left-0 top-0 h-full w-full" />
    </div>
  );
}

function SynthwaveBackground({ calm, sun }: { calm: boolean; sun: boolean }) {
  return (
    <div data-skin-bg="synthwave" data-calm={calm ? "1" : undefined} className={layer}>
      <SynthwaveSky sun={sun} />
      <SynthwaveFloor calm={calm} />
      {/* Calms the left text column (titles, hints, empty states) over the mountains; the right stays vivid. */}
      <div className="sw-veil absolute left-0 top-0 h-full w-full" />
    </div>
  );
}

/** A static perspective grid (SVG lines) for overlays over artwork (Home hero). */
function WireGrid({ top, height, opacity = 1 }: { top: number; height: number; opacity?: number }) {
  const vx = 960;
  const xs = Array.from({ length: 25 }, (_, i) => -2400 + i * 300);
  const ys = [0.02, 0.06, 0.12, 0.2, 0.31, 0.45, 0.63, 0.85];
  return (
    <svg className="pointer-events-none absolute left-0 w-[1920px]" style={{ top, height, opacity }} viewBox={`0 0 1920 ${height}`} preserveAspectRatio="none" aria-hidden>
      {xs.map((x) => (
        <line key={x} x1={vx + (x - vx) * 0.04} y1="0" x2={x} y2={height} stroke="#ff4fd8" strokeOpacity=".55" strokeWidth="1.6" />
      ))}
      {ys.map((f) => (
        <line key={f} x1="0" y1={f * height} x2="1920" y2={f * height} stroke="#ff4fd8" strokeOpacity={0.25 + f * 0.5} strokeWidth={1 + f * 1.6} />
      ))}
    </svg>
  );
}

export const look: Look = {
  Background: ({ calm, dim }) => <SynthwaveBackground calm={calm} sun={!dim} />,
  HeroEdges: ({ height }) => <WireGrid top={Math.round(height * 0.6)} height={Math.round(height * 0.4)} opacity={0.55} />,
};
