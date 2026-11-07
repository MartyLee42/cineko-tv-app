// The startup intro in «western» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import { delay, Mascot } from "../parts";
import "./western.css";

// ================================================================ Вестерн

const SLAB = "'Kelly Slab', Georgia, serif";

/** High noon: the letterbox closes in, a tumbleweed rolls by, Cineko's wanted bill is slapped up. */
export function Scene() {
  return (
    <>
      <div className="in-abs wwi-sky" style={{ width: 1280, height: 720 }} />
      <svg className="in-abs" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        <circle className="wwi-sun" cx="1040" cy="170" r="92" fill="#fff8e6" />
        <path d="M0 540 L90 536 L120 500 L230 498 L262 536 L420 542 L470 520 L510 470 L640 466 L668 512 L820 528 L880 470 L920 410 L1030 406 L1052 452 L1100 526 L1280 532 L1280 720 L0 720 Z" fill="#ddb57e" />
        <path d="M0 600 L180 592 L220 572 L340 570 L370 596 L620 606 L900 598 L960 580 L1080 578 L1110 600 L1280 596 L1280 720 L0 720 Z" fill="#cf9a5c" />
        <path d="M1150 610 L1150 470 C 1150 452 1172 452 1172 470 L1172 540 L1192 540 L1192 506 C 1192 494 1208 494 1208 506 L1208 556 L1172 560 L1172 610 Z M1150 548 L1128 548 L1128 516 C 1128 504 1142 504 1142 516 L1142 532 L1150 532 Z" fill="#7a4a26" opacity=".7" />
      </svg>
      {/* A tumbleweed bouncing across the ground. */}
      <div className="in-abs wwi-roll" style={{ left: 0, top: 560 }}>
        <svg className="wwi-spin" viewBox="-40 -40 80 80" width="80" height="80" aria-hidden="true">
          <g fill="none" stroke="#8a5a2c" strokeWidth="3" strokeLinecap="round">
            <circle r="30" />
            <path d="M-28 -6 C -10 -30 14 -26 26 -10 M-24 14 C -4 -6 18 2 28 12 M-12 -26 C 4 -4 -4 16 6 28 M10 -28 C -6 -10 2 12 -14 26" />
          </g>
        </svg>
      </div>
      {/* The bill: slapped onto an invisible wall, then a nail in each top corner. */}
      <div className="in-abs" style={{ left: 440, top: 96, width: 400, transform: "rotate(-2deg)" }}>
        <div className="wwi-slap wwi-bill" style={delay(0.85)}>
          <span className="wwi-nail" style={{ left: 14, ...delay(1.25) }} />
          <span className="wwi-nail" style={{ right: 14, ...delay(1.35) }} />
          <p style={{ fontFamily: SLAB, fontSize: 40, lineHeight: 1, letterSpacing: ".02em", color: "#7a2410" }}>РАЗЫСКИВАЕТСЯ</p>
          <div className="wwi-photo">
            <Mascot color="#a33a1c" ink="#2b1a0e" size={150} />
          </div>
          <p style={{ marginTop: 12, fontFamily: SLAB, fontSize: 64, lineHeight: 1, letterSpacing: ".08em", color: "#2b1a0e" }}>CINEKO</p>
          <p style={{ marginTop: 10, fontFamily: SLAB, fontSize: 26, lineHeight: 1, letterSpacing: ".1em", color: "#8a2e14" }}>НАГРАДА: ПОПКОРН</p>
        </div>
      </div>
      {/* Letterbox bars close in last-but-one, like a widescreen frame. */}
      <div className="in-abs wwi-bar wwi-bar-top" style={{ width: 1280, height: 70, background: "#0b0806" }} />
      <div className="in-abs wwi-bar wwi-bar-bottom" style={{ top: 650, width: 1280, height: 70, background: "#0b0806" }} />
      {/* A subtitle in the bottom bar. */}
      <p className="in-abs in-fade" style={{ top: 664, width: 1280, textAlign: "center", fontFamily: SLAB, fontSize: 34, lineHeight: 1.2, color: "#f1dfb8", ...delay(1.9) }}>
        за пригоршню фильмов…
      </p>
    </>
  );
}
