// The startup intro in «mult» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import { DESIGN_SWATCH } from "@martytv/ui";
import { delay, Mascot } from "../parts";
import "./mult.css";

// ================================================================ Мультфильм

const PAPER = "#fffaf0";
const hand = "Neucha, Onest, sans-serif";

/** A wavy hill over `base` across the 1280 px stage, closed at the bottom. */
function hill(base: number, amp: number, len: number, ph: number): string {
  let d = `M0 720 L0 ${base}`;
  for (let x = 0; x <= 1280; x += 32) d += ` L${x} ${(base + amp * Math.sin((x / len) * Math.PI * 2 + ph)).toFixed(1)}`;
  return `${d} L1280 720 Z`;
}

/** [path, fill, slide-in delay s] — the paper hills are slid in from below, far to near. */
const HILLS: [string, string, number][] = [
  [hill(500, 22, 700, 0.6), "#d5dccd", 0.05],
  [hill(560, 26, 900, 2.2), "#c3cea5", 0.25],
  [hill(625, 18, 560, 4.1), "#afbd8b", 0.45],
];

/** A paper set being laid out: sky, sun, hills slide up, fog drifts in, then the oval title card. */
export function Scene() {
  const sw = DESIGN_SWATCH.mult;
  return (
    <>
      <div className="in-abs mui-sky" style={{ width: 1280, height: 720 }} />
      <div className="in-abs mui-sun" style={{ left: 1010, top: 70, ...delay(0.2) }} />
      {HILLS.map(([d, fill, at]) => (
        <svg key={fill} className="in-abs mui-hill" width="1280" height="720" viewBox="0 0 1280 720" aria-hidden style={delay(at)}>
          <path d={d} fill="rgba(96,64,40,.12)" transform="translate(0 -4)" />
          <path d={d} fill={fill} />
        </svg>
      ))}
      <div className="in-abs mui-fog" style={{ top: 470, ...delay(0.7) }} />
      {/* The title card: an oval in a double terracotta frame with Cineko and the name. */}
      <div className="in-abs" style={{ left: 290, top: 150, width: 700 }}>
        <div className="mui-card in-zoom" style={{ background: PAPER, color: sw.text, ...delay(1.15) }}>
          <Mascot color={sw.accent} ink={sw.bg} size={120} />
          <span style={{ marginLeft: 16, fontFamily: hand, fontSize: 104, lineHeight: 1 }}>cineko</span>
        </div>
      </div>
      <p className="in-abs in-up" style={{ top: 452, width: 1280, textAlign: "center", fontFamily: hand, fontSize: 46, color: sw.accent, ...delay(1.75) }}>
        Жили-были…
      </p>
    </>
  );
}
