// The startup intro in «fivestars» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import type { ReactNode } from "react";
import { palm, starPath } from "@martytv/ui/decor";
import { delay, Mascot } from "../parts";
import "./fivestars.css";

// ================================================================ Пять звёзд

const DISPLAY = "'Oswald', 'Arial Narrow', Arial, sans-serif";
const SCRIPT = "'Pacifico', cursive";
const PALM = palm(150, 230, 200, -24);
const STAR = starPath(22);
/** A low sports car in profile, its front to the right (drawn in a 400 × 150 box). */
const CAR = "M24 118 L58 98 L118 90 L166 66 L246 62 L300 88 L358 94 L384 112 L384 128 L24 128 Z";
const CAR_GLASS = "M178 72 L242 68 L282 90 L168 92 Z";
/** Lit windows in the skyline: [x, y, colour]. */
const WINDOWS: [number, number, string][] = [
  [72, 572, "#ffd38a"], [96, 520, "#ff7ab6"], [134, 556, "#ffd38a"], [184, 470, "#8ff3ff"], [206, 496, "#ffd38a"], [190, 590, "#ffd38a"],
  [244, 540, "#ff7ab6"], [268, 586, "#ffd38a"], [316, 490, "#ffd38a"], [330, 560, "#8ff3ff"], [372, 562, "#ffd38a"], [874, 540, "#ffd38a"],
  [934, 452, "#ff7ab6"], [956, 500, "#ffd38a"], [940, 560, "#ffd38a"], [998, 520, "#8ff3ff"], [1030, 580, "#ffd38a"], [1066, 480, "#ffd38a"],
  [1090, 540, "#ff7ab6"], [1130, 560, "#ffd38a"], [1196, 510, "#ffd38a"], [1240, 572, "#8ff3ff"], [1258, 520, "#ffd38a"],
];

/** A collage panel of the box art: thick black frame, white keyline, slammed in from `from`. */
function Panel({ x, y, w, h, tilt, at, from, children }: { x: number; y: number; w: number; h: number; tilt: number; at: number; from: string; children: ReactNode }) {
  return (
    <div className="in-abs" style={{ left: x, top: y, width: w, height: h, transform: `rotate(${tilt}deg)` }}>
      <div className={`fsi-panel fsi-from-${from}`} style={{ width: w, height: h, ...delay(at) }}>
        {children}
      </div>
    </div>
  );
}

/** Sunset over the city; three panels slam in, the logo drops, five wanted stars light up and flash. */
export function Scene() {
  return (
    <>
      <div className="in-abs fsi-sky" style={{ width: 1280, height: 720 }} />
      <svg className="in-abs" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        <circle className="fsi-sun" cx="640" cy="560" r="170" fill="#ffb85a" />
        <path d="M0 720 L0 560 L60 560 L60 500 L120 500 L120 540 L170 540 L170 450 L230 450 L230 520 L300 520 L300 470 L350 470 L350 540 L420 540 L420 600 L860 600 L860 520 L920 520 L920 430 L980 430 L980 500 L1050 500 L1050 460 L1110 460 L1110 540 L1180 540 L1180 490 L1280 490 L1280 720 Z" fill="#1a0b28" />
        {/* Lit windows, then the shore road with its lights. */}
        <g opacity=".75">
          {WINDOWS.map(([x, y, c], i) => (
            <rect key={i} x={x} y={y} width="6" height="9" fill={c} />
          ))}
        </g>
        <rect x="0" y="652" width="1280" height="3" fill="#ff6a8f" opacity=".7" />
        <g className="fsi-road">
          {[30, 180, 300, 470, 610, 760, 900, 1040, 1190, 1310, 1460, 1610, 1750, 1900, 2050, 2200, 2350, 2490].map((x) => (
            <rect key={x} x={x} y="664" width={x % 3 ? 26 : 38} height="3" rx="1.5" fill={x % 2 ? "#ff4a5a" : "#fff2d6"} />
          ))}
        </g>
      </svg>
      <Panel x={64} y={70} w={300} h={430} tilt={-3} at={0.15} from="left">
        <div className="fsi-panel-bg fsi-bg-pink" />
        <div style={{ position: "absolute", left: 22, top: 70 }}>
          <Mascot color="#ff3d8b" ink="#0b0612" size={256} />
        </div>
      </Panel>
      <Panel x={880} y={56} w={340} h={220} tilt={2.5} at={0.35} from="top">
        <div className="fsi-panel-bg fsi-bg-sun" />
        <svg viewBox="0 0 340 220" width="340" height="220" style={{ position: "absolute", left: 0, top: 0 }} aria-hidden="true">
          <circle cx="230" cy="160" r="70" fill="#fff1b0" opacity=".9" />
          <rect x="0" y="176" width="340" height="44" fill="#2a0f40" />
          <g fill="#0b0612">
            <path d={PALM.trunk} />
            {PALM.fronds.map((f) => (
              <path key={f} d={f} />
            ))}
          </g>
        </svg>
      </Panel>
      <Panel x={860} y={300} w={360} h={230} tilt={-2} at={0.55} from="right">
        <div className="fsi-panel-bg fsi-bg-night" />
        <svg viewBox="0 0 400 230" width="360" height="230" style={{ position: "absolute", left: 0, top: 0 }} aria-hidden="true">
          <path d="M320 0 L340 0 L340 200 L320 200 Z" fill="#0b0612" />
          <path d="M330 18 L250 210 L410 210 Z" fill="#fff1b0" opacity=".18" />
          <g transform="translate(0 52)">
            <g stroke="#ff80b4" strokeWidth="4" strokeLinecap="round" opacity=".8">
              <line x1="-10" y1="84" x2="40" y2="84" />
              <line x1="-20" y1="104" x2="30" y2="104" />
            </g>
            <path d={CAR} fill="#ff3d8b" stroke="#0b0612" strokeWidth="5" strokeLinejoin="round" />
            <path d={CAR_GLASS} fill="#3a1250" />
            <rect x="370" y="104" width="14" height="8" fill="#fff1b0" />
            <circle cx="104" cy="128" r="22" fill="#0b0612" />
            <circle cx="104" cy="128" r="9" fill="#ffb840" />
            <circle cx="310" cy="128" r="22" fill="#0b0612" />
            <circle cx="310" cy="128" r="9" fill="#ffb840" />
          </g>
        </svg>
      </Panel>
      {/* The logo drops in, a little tilted, with a heavy black outline. */}
      <div className="in-abs" style={{ left: 380, top: 120, width: 500, textAlign: "center" }}>
        <p className="fsi-logo" style={{ fontFamily: SCRIPT, ...delay(0.95) }}>
          Cineko
        </p>
        <p className="in-fade fsi-tag" style={{ fontFamily: DISPLAY, ...delay(1.3) }}>
          ФИЛЬМЫ · СЕРИАЛЫ · ТВ
        </p>
      </div>
      {/* Five wanted stars light up one by one, then flash police red and blue. */}
      <svg className="in-abs" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i} transform={`translate(${532 + i * 54} 410)`}>
            <g className="fsi-star-pop" style={delay(1.45 + i * 0.12)}>
              <path className="fsi-star" d={STAR} />
            </g>
          </g>
        ))}
      </svg>
      {/* A mission subtitle at the bottom: the speaker in pink, the line in white. */}
      <p className="in-abs in-fade fsi-sub" style={{ top: 600, width: 1280, textAlign: "center", fontFamily: DISPLAY, ...delay(1.7) }}>
        <span style={{ color: "#ff80b4" }}>Cineko:</span> Садись. Едем смотреть кино.
      </p>
    </>
  );
}
