// The startup intro in «anderson» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import { delay, Mascot } from "../parts";
import "./anderson.css";

// ================================================================ Симметрия

const FONT = "Jost, Onest, sans-serif";
const PINK = "#f6d6d6";
const CREAM = "#fbeee6";
const MUSTARD = "#d9a520";
const MINT = "#8fcfb8";
const INK = "#3a222c";
const RASP = "#7a223e";

/** A bellboy's desk bell on a raspberry counter; its button is pressed at 2.1 s and «дзынь» lines spring out. */
function Bell({ x }: { x: number }) {
  return (
    <div className="in-abs" style={{ left: x, top: 600, width: 120, height: 80 }}>
      <svg className="in-abs ani-press" width="120" height="80" viewBox="0 0 120 80" style={delay(2.1)} aria-hidden="true">
        <rect x="54" y="6" width="12" height="12" rx="3" fill={MUSTARD} />
      </svg>
      <svg className="in-abs" width="120" height="80" viewBox="0 0 120 80" aria-hidden="true">
        <path d="M18 62 a42 42 0 0 1 84 0 Z" fill={MUSTARD} stroke="#9a6b10" strokeWidth="3" />
        <rect x="58" y="16" width="4" height="6" fill="#9a6b10" />
        <rect x="8" y="62" width="104" height="10" fill={RASP} />
      </svg>
      <svg className="in-abs ani-ding" width="120" height="80" viewBox="0 0 120 80" style={{ left: 0, top: -40, overflow: "visible", ...delay(2.15) }} aria-hidden="true">
        <g stroke={RASP} strokeWidth="4" strokeLinecap="round">
          <path d="M60 12 v-16" />
          <path d="M30 22 l-10 -12" />
          <path d="M90 22 l10 -12" />
        </g>
      </svg>
    </div>
  );
}

/** A symmetric pastel façade rises, the title card drops in front, Cineko appears in the doorway, two desk bells ring. */
export function Scene() {
  const n = 16;
  const sw = 1280 / n;
  return (
    <>
      <div className="in-abs" style={{ width: 1280, height: 720, background: PINK }} />
      {/* The façade (an original toy-box building, mirrored about the centre). */}
      <svg className="in-abs ani-rise" width="1280" height="720" viewBox="0 0 1280 720" aria-hidden="true">
        <rect x="290" y="150" width="700" height="520" fill="#f2b8c0" stroke={MUSTARD} strokeWidth="4" />
        <path d="M270 150 L640 70 L1010 150 Z" fill="#e89aa8" stroke={MUSTARD} strokeWidth="4" />
        <circle cx="640" cy="118" r="18" fill={CREAM} stroke={MUSTARD} strokeWidth="3" />
        {[0, 1, 2].map((row) =>
          [340, 450, 760, 870].map((x) => <rect key={`${row}-${x}`} x={x} y={190 + row * 110} width="70" height="80" fill={CREAM} stroke={MUSTARD} strokeWidth="3" />),
        )}
        <rect x="575" y="470" width="130" height="200" fill={MINT} stroke={MUSTARD} strokeWidth="4" />
        <path d="M575 470 a65 50 0 0 1 130 0 Z" fill={CREAM} stroke={MUSTARD} strokeWidth="3" />
        {/* Awning over the door. */}
        {Array.from({ length: 6 }, (_, i) => (
          <path key={i} d={`M${550 + i * 30} 440 h30 v22 a15 10 0 0 1 -30 0 Z`} fill={i % 2 ? CREAM : MINT} stroke={MUSTARD} strokeWidth="1.5" />
        ))}
        <rect x="0" y="670" width="1280" height="50" fill="#e7c3b0" />
      </svg>
      {/* The top awning, scalloped. */}
      <svg className="in-abs ani-drop" width="1280" height="60" viewBox="0 0 1280 60" aria-hidden="true">
        {Array.from({ length: n }, (_, i) => (
          <path key={i} d={`M${i * sw} 0 h${sw} v34 a${sw / 2} 16 0 0 1 ${-sw} 0 Z`} fill={i % 2 ? CREAM : MINT} />
        ))}
      </svg>
      {/* Cineko in the doorway. */}
      <div className="in-abs in-pop" style={{ left: 578, top: 528, ...delay(1.6) }}>
        <Mascot color={RASP} ink={INK} size={124} />
      </div>
      {/* The title card. */}
      <div className="in-abs ani-card" style={{ left: 390, top: 236, width: 500, height: 160, ...delay(0.75) }}>
        <div style={{ position: "absolute", left: 0, top: 0, width: 500, height: 160, background: CREAM, boxShadow: `0 0 0 3px ${MUSTARD}, 0 0 0 9px ${CREAM}, 0 0 0 11px ${MUSTARD}` }} />
        <span style={{ position: "absolute", left: 0, top: 22, width: 500, textAlign: "center", fontFamily: FONT, fontWeight: 500, fontSize: 20, letterSpacing: ".42em", color: "#9a6b10" }}>ЧАСТЬ ПЕРВАЯ</span>
        <span style={{ position: "absolute", left: 0, top: 54, width: 500, textAlign: "center", fontFamily: FONT, fontWeight: 500, fontSize: 70, lineHeight: 1.1, letterSpacing: ".22em", color: INK }}>CINEKO</span>
      </div>
      {/* Two desk bells, mirrored, pressed together at 2.1 s: «дзынь». */}
      <Bell x={140} />
      <Bell x={1020} />
    </>
  );
}
