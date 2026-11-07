// The startup intro in «silent» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import { delay, Mascot } from "../parts";
import "./silent.css";

// ================================================================ Немое кино

const SERIF = "'Old Standard TT', 'Playfair Display', Georgia, serif";

/** One art-nouveau corner (top-left; the others are mirrored). */
const CORNER = "M14 50c14 0 24-9 24-23 0-9-7-13-13-9-5 3-2 10 4 9M50 14c0 14-9 24-23 24";

/** The leader countdown 3-2-1 (a sweep hand turns), a flash, then the intertitle card and an iris-out. */
export function Scene() {
  return (
    <>
      <div className="in-abs" style={{ width: 1280, height: 720, background: "#0a0a0a" }} />
      {/* Film leader: rings, cross hairs, a turning sweep and the numbers. */}
      <div className="in-abs sli-leader" style={{ width: 1280, height: 720 }}>
        <svg className="in-abs" width="1280" height="720" viewBox="0 0 1280 720" aria-hidden="true">
          <rect width="1280" height="720" fill="#8a8a8a" />
          <line x1="0" y1="360" x2="1280" y2="360" stroke="#1a1a1a" strokeWidth="3" />
          <line x1="640" y1="0" x2="640" y2="720" stroke="#1a1a1a" strokeWidth="3" />
          <circle cx="640" cy="360" r="250" fill="none" stroke="#f2f2f2" strokeWidth="6" />
          <circle cx="640" cy="360" r="210" fill="none" stroke="#1a1a1a" strokeWidth="4" />
        </svg>
        <div className="in-abs sli-sweep" style={{ left: 640, top: 110, width: 0, height: 250 }}>
          <svg className="in-abs" style={{ left: -250, top: 0 }} width="500" height="500" viewBox="-250 0 500 500" aria-hidden="true">
            <path d="M0 250 L0 0 A250 250 0 0 1 250 250 Z" fill="#1a1a1a" opacity=".35" />
          </svg>
        </div>
        {["3", "2", "1"].map((n, i) => (
          <span key={n} className="in-abs sli-num" style={{ top: 214, width: 1280, textAlign: "center", fontFamily: SERIF, fontWeight: 700, fontSize: 260, lineHeight: 1, color: "#0a0a0a", ...delay(i * 0.3) }}>
            {n}
          </span>
        ))}
      </div>
      <div className="in-abs sli-flash" style={{ width: 1280, height: 720, background: "#fff" }} />
      {/* The intertitle card. */}
      <div className="in-abs sli-card" style={{ left: 250, top: 120, width: 780, height: 480 }}>
        <svg className="in-abs" width="780" height="480" viewBox="0 0 780 480" aria-hidden="true">
          <rect x="4" y="4" width="772" height="472" fill="#0a0a0a" stroke="#f2f2f2" strokeWidth="5" />
          <rect x="22" y="22" width="736" height="436" fill="none" stroke="#f2f2f2" strokeWidth="2" />
          <g fill="none" stroke="#f2f2f2" strokeWidth="3" strokeLinecap="round">
            <path d={CORNER} />
            <path d={CORNER} transform="matrix(-1 0 0 1 780 0)" />
            <path d={CORNER} transform="matrix(1 0 0 -1 0 480)" />
            <path d={CORNER} transform="matrix(-1 0 0 -1 780 480)" />
          </g>
          <line x1="250" y1="330" x2="530" y2="330" stroke="#f2f2f2" strokeWidth="2" />
          <circle cx="390" cy="330" r="5" fill="#f2f2f2" />
        </svg>
        <span className="in-abs" style={{ top: 70, width: 780, textAlign: "center", fontFamily: SERIF, fontSize: 30, letterSpacing: ".3em", color: "#d8d8d8" }}>
          КИНОТЕАТР
        </span>
        <span className="in-abs" style={{ top: 120, width: 780, textAlign: "center", fontFamily: SERIF, fontWeight: 700, fontSize: 132, lineHeight: 1.2, color: "#f4f4f4" }}>
          Cineko
        </span>
        <span className="in-abs sli-sub" style={{ top: 352, width: 780, textAlign: "center", fontFamily: SERIF, fontSize: 34, fontStyle: "italic", color: "#e6e6e6", ...delay(1.75) }}>
          имеет честь представить
        </span>
      </div>
      {/* Cineko peeks in from the corner (in black and white). */}
      <div className="in-abs sli-cat" style={{ left: 1010, top: 470, ...delay(1.9) }}>
        <Mascot color="#fff" ink="#000" size={150} />
      </div>
      {/* Grain, flicker and the closing iris. */}
      <div className="in-abs sli-grain" style={{ width: 1280, height: 720 }} />
      <div className="in-abs sli-flick" style={{ width: 1280, height: 720, background: "#fff" }} />
      <div className="in-abs sli-iris" style={{ left: 240, top: -40, width: 800, height: 800 }} />
    </>
  );
}
