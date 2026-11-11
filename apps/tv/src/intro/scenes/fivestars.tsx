// The startup intro in «fivestars» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import type { ReactNode } from "react";
import { starPath } from "@martytv/ui/decor";
import { ComicBay } from "@martytv/ui/decor/collage";
import { delay, Mascot } from "../parts";
import "./fivestars.css";

// ================================================================ Пять звёзд

const DISPLAY = "'Oswald', 'Arial Narrow', Arial, sans-serif";
const SCRIPT = "'Pacifico', cursive";
const STAR = starPath(22);
/** A low sports car in profile, its front to the right (drawn in a 400 × 150 box). */
const CAR = "M24 118 L58 98 L118 90 L166 66 L246 62 L300 88 L358 94 L384 112 L384 128 L24 128 Z";
const CAR_GLASS = "M178 72 L242 68 L282 90 L168 92 Z";

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

/** A purple grid desk; three box-art panels slam in, the logo drops, five wanted stars light up and flash. */
export function Scene() {
  return (
    <>
      <div className="in-abs fsi-desk" style={{ width: 1280, height: 720 }} />
      <Panel x={64} y={70} w={300} h={430} tilt={-3} at={0.15} from="left">
        <div className="fsi-panel-bg fsi-bg-pink" />
        <div style={{ position: "absolute", left: 22, top: 70 }}>
          <Mascot color="#ff4fa3" ink="#0e0a24" size={256} />
        </div>
      </Panel>
      <Panel x={880} y={56} w={340} h={220} tilt={2.5} at={0.35} from="top">
        <ComicBay calm width={340} height={220} preserveAspectRatio="xMidYMid slice" />
      </Panel>
      <Panel x={860} y={300} w={360} h={230} tilt={-2} at={0.55} from="right">
        <div className="fsi-panel-bg fsi-bg-night" />
        <svg viewBox="0 0 400 230" width="360" height="230" style={{ position: "absolute", left: 0, top: 0 }} aria-hidden="true">
          <path d="M320 0 L340 0 L340 200 L320 200 Z" fill="#0e0a24" />
          <path d="M330 18 L250 210 L410 210 Z" fill="#fff1b0" opacity=".18" />
          <g transform="translate(0 52)">
            <g stroke="#ff9ccd" strokeWidth="4" strokeLinecap="round" opacity=".8">
              <line x1="-10" y1="84" x2="40" y2="84" />
              <line x1="-20" y1="104" x2="30" y2="104" />
            </g>
            <path d={CAR} fill="#ff4fa3" stroke="#0e0a24" strokeWidth="5" strokeLinejoin="round" />
            <path d={CAR_GLASS} fill="#3a1250" />
            <rect x="370" y="104" width="14" height="8" fill="#fff1b0" />
            <circle cx="104" cy="128" r="22" fill="#0e0a24" />
            <circle cx="104" cy="128" r="9" fill="#ffc83d" />
            <circle cx="310" cy="128" r="22" fill="#0e0a24" />
            <circle cx="310" cy="128" r="9" fill="#ffc83d" />
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
        <span style={{ color: "#ff9ccd" }}>Cineko:</span> Садись. Едем смотреть кино.
      </p>
    </>
  );
}
