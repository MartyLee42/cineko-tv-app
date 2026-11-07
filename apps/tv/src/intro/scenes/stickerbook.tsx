// The startup intro in «stickerbook» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import type { ReactNode } from "react";
import { DESIGN_SWATCH } from "@martytv/ui";
import { delay, Mascot } from "../parts";
import "./stickerbook.css";

// ================================================================ Стикербук

const CREAM = "#fffaf0";
const hand = "Caveat, Onest, sans-serif";

/** Little drawings on the stickers (viewBox 0 0 100 100). */
const ART: Record<string, ReactNode> = {
  star: <path d="M50 10 L61 38 L91 39 L67 58 L76 88 L50 70 L24 88 L33 58 L9 39 L39 38 Z" fill="#ffd166" stroke="#2a2438" strokeWidth="5" strokeLinejoin="round" />,
  heart: <path d="M50 86 C 14 62 8 40 20 26 C 30 14 46 18 50 32 C 54 18 70 14 80 26 C 92 40 86 62 50 86 Z" fill="#ff6fa5" stroke="#2a2438" strokeWidth="5" strokeLinejoin="round" />,
  film: (
    <g stroke="#2a2438" strokeWidth="5" strokeLinejoin="round">
      <rect x="14" y="20" width="72" height="60" rx="6" fill="#2a2438" />
      <rect x="28" y="32" width="44" height="36" rx="3" fill="#5fd3c4" />
      {[26, 42, 58, 74].map((x) => (
        <g key={x} fill={CREAM} stroke="none">
          <rect x={x - 4} y="22" width="8" height="6" rx="1.5" />
          <rect x={x - 4} y="72" width="8" height="6" rx="1.5" />
        </g>
      ))}
    </g>
  ),
  popcorn: (
    <g stroke="#2a2438" strokeWidth="5" strokeLinejoin="round">
      <circle cx="34" cy="32" r="13" fill={CREAM} />
      <circle cx="52" cy="24" r="14" fill={CREAM} />
      <circle cx="68" cy="34" r="12" fill={CREAM} />
      <path d="M22 40 L78 40 L70 90 L30 90 Z" fill="#ff6fa5" />
      <path d="M40 40 L43 90 M57 40 L56 90" stroke={CREAM} strokeWidth="7" />
    </g>
  ),
  clapper: (
    <g stroke="#2a2438" strokeWidth="5" strokeLinejoin="round">
      <rect x="14" y="40" width="72" height="44" rx="4" fill="#b296ff" />
      <path d="M12 26 L84 14 L88 32 L16 44 Z" fill={CREAM} />
      <path d="M30 23 L38 40 M50 20 L58 37 M70 17 L78 34" stroke="#2a2438" strokeWidth="6" />
    </g>
  ),
  ticket: (
    <g stroke="#2a2438" strokeWidth="5" strokeLinejoin="round">
      <path d="M10 30 L90 30 L90 44 A 7 7 0 0 0 90 58 L90 72 L10 72 L10 58 A 7 7 0 0 0 10 44 Z" fill="#5fd3c4" />
      <path d="M66 32 L66 70" strokeDasharray="5 6" />
      <circle cx="38" cy="51" r="8" fill="#ffd166" />
    </g>
  ),
};

/** [art, left, top, size, rotation°, slap delay s, sticker fill, tape?] */
const STICKERS: [string, number, number, number, number, number, string, boolean][] = [
  ["film", 120, 96, 170, -9, 0.1, "#3a3250", true],
  ["heart", 1000, 70, 150, 8, 0.32, "#fff1f6", false],
  ["popcorn", 1030, 450, 180, -6, 0.54, "#3a3250", true],
  ["star", 150, 470, 150, 12, 0.76, "#3a3250", false],
  ["clapper", 430, 568, 130, -4, 0.96, "#f1ecff", false],
  ["ticket", 790, 560, 140, 7, 1.14, "#3a3250", true],
];

function Sticker({ art, left, top, size, rot, at, fill, tape }: { art: string; left: number; top: number; size: number; rot: number; at: number; fill: string; tape: boolean }) {
  return (
    <div className="in-abs" style={{ left, top, transform: `rotate(${rot}deg)` }}>
      <div className="sbi-slap" style={{ width: size, height: size, ...delay(at) }}>
        <div className="sbi-sticker" style={{ width: size, height: size, background: fill }}>
          <svg viewBox="0 0 100 100" width={size - 40} height={size - 40} aria-hidden="true" style={{ margin: 6 }}>
            {ART[art]}
          </svg>
        </div>
        {tape && <span className="sbi-tape" style={{ left: size / 2 - 46, ...delay(at + 0.12) }} />}
      </div>
    </div>
  );
}

/** A dark album page: stickers are slapped on one by one, the Cineko logo sticker last, then taped down. */
export function Scene() {
  const sw = DESIGN_SWATCH.stickerbook;
  return (
    <>
      <div className="in-abs sbi-board" style={{ width: 1280, height: 720, backgroundColor: sw.bg }} />
      {STICKERS.map(([art, left, top, size, rot, at, fill, tape]) => (
        <Sticker key={art} art={art} left={left} top={top} size={size} rot={rot} at={at} fill={fill} tape={tape} />
      ))}
      {/* The logo sticker: Cineko + «cineko tv» on a big die-cut label. */}
      <div className="in-abs" style={{ left: 250, top: 226, width: 780, transform: "rotate(-3deg)" }}>
        <div className="sbi-slap sbi-slap-big" style={delay(1.45)}>
          <div className="sbi-logo" style={{ background: sw.surface, color: sw.text }}>
            <Mascot color={sw.accent} ink={sw.bg} size={130} />
            <span style={{ marginLeft: 18, fontFamily: "Unbounded, Onest, sans-serif", fontSize: 92, fontWeight: 800, letterSpacing: -3, lineHeight: 1 }}>cineko</span>
            <span style={{ marginLeft: 14, background: sw.accent, color: "#2a0c1a", fontFamily: "Unbounded, Onest, sans-serif", fontSize: 70, fontWeight: 800, lineHeight: 1, padding: "4px 16px 12px", borderRadius: 22 }}>tv</span>
          </div>
          <span className="sbi-tape sbi-tape-sun" style={{ left: -26, top: -8, transform: "rotate(-32deg)", ...delay(1.9) }} />
          <span className="sbi-tape sbi-tape-mint" style={{ right: -26, left: "auto", top: -8, transform: "rotate(30deg)", ...delay(2.02) }} />
        </div>
      </div>
      <p className="in-abs in-up" style={{ top: 476, width: 1280, textAlign: "center", fontFamily: hand, fontWeight: 700, fontSize: 56, color: sw.accent2, ...delay(2.15) }}>
        вклеиваем лучшее…
      </p>
    </>
  );
}
