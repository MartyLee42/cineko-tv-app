// The startup intro in «popart» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import { DESIGN_SWATCH } from "@martytv/ui";
import { delay, Mascot } from "../parts";
import "./popart.css";

// ================================================================ Поп-арт

/** A regular comic starburst (spikes alternating between r1 and r2, wider than tall). */
function burst(cx: number, cy: number, r1: number, r2: number, n: number): string {
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = (i % 2 ? r1 : r2) * (i % 4 === 0 ? 1.06 : 1);
    pts.push(`${(cx + Math.cos(a) * r * 1.25).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`);
  }
  return pts.join(" ");
}

const POP_BURST = burst(640, 372, 178, 262, 16);

/** Comic page: Ben-Day dots, panels slide in, speed lines, a white burst, the logo drops in, Cineko says «ВАУ!». */
export function Scene() {
  const sw = DESIGN_SWATCH.popart;
  const comic = "'Rubik Mono One', Unbounded, sans-serif";
  const ink = "3px 0 #000, -3px 0 #000, 0 3px #000, 0 -3px #000, 2px 2px #000, -2px -2px #000, 2px -2px #000, -2px 2px #000";
  return (
    <>
      <div className="in-abs" style={{ width: 1280, height: 720, backgroundColor: sw.bg, backgroundImage: "radial-gradient(circle, rgba(255,255,255,.16) 0px, rgba(255,255,255,.16) 3px, rgba(255,255,255,0) 3.6px)", backgroundSize: "20px 20px" }} />
      <svg className="in-abs pai-lines" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        {Array.from({ length: 36 }, (_, i) => {
          const a = (i / 36) * Math.PI * 2;
          return <line key={i} x1={640 + Math.cos(a) * 320} y1={372 + Math.sin(a) * 250} x2={640 + Math.cos(a) * 1000} y2={372 + Math.sin(a) * 800} stroke="#fff" strokeOpacity=".28" strokeWidth={i % 2 ? 4 : 9} />;
        })}
      </svg>
      {/* Corner panels in black ink: red and yellow. */}
      <svg className="in-abs pai-slide-l" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        <polygon points="-10,-10 470,-10 290,230 -10,180" fill={sw.accent2} stroke="#000" strokeWidth="8" />
      </svg>
      <svg className="in-abs pai-slide-r" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        <polygon points="1290,730 800,730 990,500 1290,540" fill={sw.accent} stroke="#000" strokeWidth="8" />
      </svg>
      <svg className="in-abs pai-burst" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        <polygon points={POP_BURST} fill="#000" transform="translate(14 14)" />
        <polygon points={POP_BURST} fill="#fff" stroke="#000" strokeWidth="8" strokeLinejoin="round" />
      </svg>
      <div className="in-abs in-pop" style={{ left: 120, top: 150, ...delay(0.85) }}>
        <Mascot color={sw.accent} ink="#000" size={175} />
      </div>
      {/* Speech balloon from Cineko. */}
      <div className="in-abs pai-bubble" style={{ left: 290, top: 70, width: 220, height: 130, ...delay(1.75) }}>
        <svg viewBox="0 0 220 130" width="220" height="130" aria-hidden="true" style={{ position: "absolute", left: 0, top: 0 }}>
          <path d="M110 6 C 168 6 214 30 214 58 C 214 86 168 108 110 108 C 98 108 88 107 78 105 L 40 126 L 52 98 C 22 89 6 74 6 58 C 6 30 52 6 110 6 Z" fill="#fff" stroke="#000" strokeWidth="6" strokeLinejoin="round" />
        </svg>
        <span style={{ position: "absolute", left: 0, top: 36, width: 220, textAlign: "center", fontFamily: comic, fontSize: 34, lineHeight: 1, color: sw.accent2, textShadow: "2px 2px 0 #000" }}>ВАУ!</span>
      </div>
      <div className="in-abs" style={{ top: 312, width: 1280, display: "flex", justifyContent: "center", alignItems: "center", paddingLeft: 90 }}>
        <div style={{ display: "flex", fontFamily: comic, fontSize: 104, lineHeight: 1, color: sw.accent, textShadow: `${ink}, 8px 8px 0 ${sw.accent2}, 10px 10px 0 #000` }}>
          {"CINEKO".split("").map((c, i) => (
            <span key={i} className="in-drop" style={delay(1.05 + i * 0.07)}>
              {c}
            </span>
          ))}
        </div>
        <span className="pai-tv" style={{ marginLeft: 26, fontFamily: comic, fontSize: 80, lineHeight: 1, padding: "10px 20px 14px", background: sw.accent2, color: "#fff", border: "6px solid #000", boxShadow: "9px 9px 0 #000", textShadow: "3px 3px 0 #000" }}>
          TV
        </span>
      </div>
      {/* The narration box. */}
      <div className="in-abs in-up" style={{ top: 584, width: 1280, textAlign: "center", ...delay(1.95) }}>
        <span style={{ display: "inline-block", fontFamily: comic, fontSize: 24, wordSpacing: "-.35em", color: "#000", background: sw.accent, padding: "10px 22px", border: "5px solid #000", boxShadow: "7px 7px 0 #000" }}>ТЕМ ВРЕМЕНЕМ В КИНОЗАЛЕ…</span>
      </div>
    </>
  );
}
