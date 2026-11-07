// The startup intro in «vague» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import type { CSSProperties } from "react";
import { DESIGN_SWATCH } from "@martytv/ui";
import { delay, Mascot } from "../parts";
import "./vague.css";

const RED = "#e6281e";
const BLUE = "#345cde";
const WHITE = "#fafaf8";
const INK = "#0a0a0c";

/** Three word cards cut in hard, one after another (each jolts once mid-shot), then the title card. */
const CARDS: { word: string; bg: string; fg: string; at: number; style: CSSProperties }[] = [
  { word: "СМОТРИ", bg: RED, fg: WHITE, at: 0.15, style: { left: 90, top: 150, fontSize: 132 } },
  { word: "СЛУШАЙ", bg: BLUE, fg: WHITE, at: 0.6, style: { left: 300, top: 330, fontSize: 132 } },
  { word: "ЛЮБИ", bg: WHITE, fg: INK, at: 1.05, style: { left: 180, top: 220, fontSize: 168 } },
];

/**
 * «Новая волна»: no fades — jump cuts. Word cards in red, blue and white flash
 * up one after another, then the name sits on black with a pencilled note and
 * Cineko pops into the corner.
 */
export function Scene() {
  const sw = DESIGN_SWATCH.vague;
  const display = "Unbounded, Onest, sans-serif";
  return (
    <>
      {CARDS.map((c) => (
        <div key={c.word} className="in-abs nvi-flash" style={{ ...delay(c.at), left: c.style.left, top: c.style.top }}>
          <span style={{ display: "inline-block", fontFamily: display, fontWeight: 800, fontSize: c.style.fontSize, lineHeight: 1, letterSpacing: "-.02em", padding: "18px 34px 24px", background: c.bg, color: c.fg }}>{c.word}</span>
        </div>
      ))}
      {/* The title card. */}
      <div className="in-abs nvi-on" style={{ left: 110, top: 168, width: 66, height: 16, background: BLUE, ...delay(1.5) }} />
      <div className="in-abs nvi-on" style={{ left: 176, top: 168, width: 66, height: 16, background: WHITE, ...delay(1.5) }} />
      <div className="in-abs nvi-on" style={{ left: 242, top: 168, width: 66, height: 16, background: RED, ...delay(1.5) }} />
      <div className="in-abs nvi-on nvi-jolt" style={{ left: 104, top: 222, fontFamily: display, fontWeight: 800, fontSize: 150, lineHeight: 1, letterSpacing: "-.03em", color: sw.text, ...delay(1.5) }}>
        CINEKO
      </div>
      <div className="in-abs nvi-on" style={{ left: 110, top: 410, ...delay(1.75) }}>
        <span style={{ display: "inline-block", fontFamily: display, fontWeight: 800, fontSize: 44, lineHeight: 1, padding: "10px 20px 12px", background: RED, color: WHITE }}>ТВ</span>
      </div>
      <div className="in-abs nvi-on" style={{ left: 260, top: 418, fontFamily: "Caveat, Onest, sans-serif", fontWeight: 700, fontSize: 52, lineHeight: 1, color: WHITE, transform: "rotate(-4deg)", ...delay(2.0) }}>
        фильм начинается…
      </div>
      <div className="in-abs" style={{ left: 1000, top: 410, width: 190, height: 200, overflow: "hidden" }}>
        <div className="in-abs in-pop" style={{ left: 10, top: 20, ...delay(2.2) }}>
          <Mascot color={sw.text} ink={sw.bg} size={170} />
        </div>
      </div>
    </>
  );
}
