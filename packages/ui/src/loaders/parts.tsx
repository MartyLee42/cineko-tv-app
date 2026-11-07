// Shared bits of the drawn loading styles: the scaled art box, Cineko's
// face, stall tracking and the common CSS. Old TV engines: absolutely
// positioned HTML boxes with small inline SVGs, animated with transform /
// opacity only (no SVG transform-box, gap, inset or aspect-ratio).
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { isStalled, stallStep, STALL_MS, type StallState } from "./logic";

/** The art's own coordinate box (px); `width` scales it. */
export const ART_W = 1200;
export const ART_H = 560;

export interface ArtProps {
  /** Monotonic 0..1. */
  p: number;
  /** Rendered width in px (the art is drawn at ART_W × ART_H and scaled). */
  width?: number;
  /** Settings → motion «calm»: no idle loops. */
  calm?: boolean;
  /** The film is starting: play the end flourish. */
  done?: boolean;
  /** A preview: no sounds. */
  quiet?: boolean;
}

const COMMON_CSS = `
.ld-box, .ld-box * { box-sizing: border-box; }
.ld-abs { position: absolute; left: 0; top: 0; }
.ld-pop { animation: ld-pop .5s cubic-bezier(.3,1.6,.5,1) both; }
@keyframes ld-pop { from { opacity: 0; transform: scale(.2); } to { opacity: 1; transform: scale(1); } }
.ld-bob { animation: ld-bob 2.4s ease-in-out infinite; }
@keyframes ld-bob { 0%,100% { transform: translate3d(0,0,0); } 50% { transform: translate3d(0,-8px,0); } }
.ld-ease { transition: transform .6s cubic-bezier(.25,.6,.4,1), opacity .6s ease; }
.ld-calm *, .ld-calm { animation: none !important; }
@media (prefers-reduced-motion: reduce) { .ld-box * { animation: none !important; } }
`;

/** The art at ART_W × ART_H scaled to `width` (kept in the flow at the scaled size). */
export function ArtBox({ width = ART_W, calm, children, css, label }: { width?: number; calm?: boolean; children: ReactNode; css: string; label?: string }) {
  const s = width / ART_W;
  return (
    <div role="img" aria-label={label} className="ld-box" style={{ position: "relative", width, height: ART_H * s, overflow: "visible" }}>
      <style>{COMMON_CSS + css}</style>
      <div className={calm ? "ld-calm" : undefined} style={{ position: "absolute", left: 0, top: 0, width: ART_W, height: ART_H, transform: `scale(${s})`, transformOrigin: "0 0" }}>
        {children}
      </div>
    </div>
  );
}

/** Absolutely placed box at (x, y) of size w × h. */
export function At({ x, y, w, h, className, style, children }: { x: number; y: number; w?: number; h?: number; className?: string; style?: CSSProperties; children?: ReactNode }) {
  return (
    <div className={className} style={{ position: "absolute", left: x, top: y, width: w, height: h, ...style }}>
      {children}
    </div>
  );
}

/** Whether progress has not risen for STALL_MS (re-checked every second). */
export function useStalled(p: number, ms = STALL_MS): boolean {
  const [view, setView] = useState<{ s: StallState | null; now: number }>({ s: null, now: 0 });
  useEffect(() => {
    const tick = () => setView((v) => ({ s: stallStep(v.s, p, Date.now()), now: Date.now() }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [p]);
  return isStalled(view.s, view.now, ms);
}

export type FaceMood = "watch" | "lick" | "happy" | "worried";

/**
 * Cineko's face (the robot-cat mascot, drawn simply): a dark rounded head
 * with ears and glowing pink eyes. `look` moves the pupils (-1..1).
 */
export function CinekoFace({ size, look = { dx: 0, dy: 0 }, mood = "watch" }: { size: number; look?: { dx: number; dy: number }; mood?: FaceMood }) {
  const px = look.dx * 7;
  const py = look.dy * 6;
  const eye = (cx: number) =>
    mood === "happy" || mood === "lick" ? (
      <path d={`M${cx - 15} 112 Q${cx} 94 ${cx + 15} 112`} stroke="#ff5fa2" strokeWidth="7" strokeLinecap="round" fill="none" />
    ) : (
      <g>
        <ellipse cx={cx} cy={108} rx="17" ry={mood === "worried" ? 13 : 19} fill="#ff4f99" opacity=".28" />
        <ellipse cx={cx + px} cy={108 + py} rx="10" ry={mood === "worried" ? 9 : 13} fill="#ff6fae" />
        <circle cx={cx + px + 3} cy={103 + py} r="3.5" fill="#ffe3f0" />
      </g>
    );
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" aria-hidden>
      <defs>
        <radialGradient id="ld-head" cx="45%" cy="38%" r="70%">
          <stop offset="0" stopColor="#3a3550" />
          <stop offset="1" stopColor="#15131f" />
        </radialGradient>
      </defs>
      {/* ears */}
      <path d="M38 78 L52 18 L92 56 Z" fill="#1d1a29" stroke="#ff5fa2" strokeOpacity=".55" strokeWidth="3" strokeLinejoin="round" />
      <path d="M162 78 L148 18 L108 56 Z" fill="#1d1a29" stroke="#ff5fa2" strokeOpacity=".55" strokeWidth="3" strokeLinejoin="round" />
      <path d="M52 34 L60 60 L76 54 Z" fill="#ff5fa2" opacity=".35" />
      <path d="M148 34 L140 60 L124 54 Z" fill="#ff5fa2" opacity=".35" />
      {/* head */}
      <ellipse cx="100" cy="112" rx="78" ry="68" fill="url(#ld-head)" stroke="#ff5fa2" strokeOpacity=".5" strokeWidth="3" />
      {/* antenna bolt */}
      <rect x="95" y="38" width="10" height="12" rx="3" fill="#5b5675" />
      <circle cx="100" cy="36" r="6" fill="#ff6fae" />
      {eye(70)}
      {eye(130)}
      {/* mouth */}
      {mood === "lick" ? (
        <g>
          <path d="M86 146 Q100 156 114 146" stroke="#ff8fc0" strokeWidth="4" strokeLinecap="round" fill="none" />
          <path d="M104 148 Q116 166 126 150 Q122 144 112 146 Z" fill="#ff7aa8" />
        </g>
      ) : mood === "worried" ? (
        <path d="M88 152 Q100 144 112 152" stroke="#ff8fc0" strokeWidth="4" strokeLinecap="round" fill="none" />
      ) : (
        <path d="M90 146 Q95 152 100 146 Q105 152 110 146" stroke="#ff8fc0" strokeWidth="4" strokeLinecap="round" fill="none" />
      )}
      {/* whisker lines */}
      <path d="M30 128 L56 132 M30 142 L56 138 M170 128 L144 132 M170 142 L144 138" stroke="#ff8fc0" strokeOpacity=".45" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
