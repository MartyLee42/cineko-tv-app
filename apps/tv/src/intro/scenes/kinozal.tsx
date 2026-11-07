// The startup intro in «kinozal» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import { DESIGN_SWATCH } from "@martytv/ui";
import { delay, Mascot } from "../parts";
import "./kinozal.css";

// ================================================================ Кинозал

export function Scene() {
  const sw = DESIGN_SWATCH.kinozal;
  const bulbs = (top: number) => (
    <div className="in-abs" style={{ top, left: 40, width: 1200, display: "flex", justifyContent: "space-between" }}>
      {Array.from({ length: 30 }, (_, i) => (
        <div key={i} className="in-bulb" style={{ background: sw.accent, ...delay((i % 6) * 0.13) }} />
      ))}
    </div>
  );
  return (
    <>
      <div className="in-abs" style={{ width: 1280, height: 720, background: `radial-gradient(ellipse 55% 45% at 50% 48%, rgba(200,255,61,.16), transparent)` }} />
      <div className="in-center in-zoom" style={{ top: 250, gap: 24, color: sw.text, fontFamily: "Unbounded, Onest, sans-serif", ...delay(0.95) }}>
        <Mascot color={sw.accent} ink={sw.bg} size={130} />
        <div style={{ display: "flex", alignItems: "center", gap: 14, paddingBottom: 8 }}>
          <span style={{ fontSize: 112, fontWeight: 800, letterSpacing: -4, lineHeight: 1 }}>cineko</span>
          <span style={{ background: sw.accent, color: sw.bg, fontSize: 84, fontWeight: 800, lineHeight: 1, padding: "6px 20px 14px", borderRadius: 26 }}>tv</span>
        </div>
      </div>
      <p className="in-abs in-up" style={{ top: 470, width: 1280, textAlign: "center", fontSize: 24, letterSpacing: ".4em", color: "rgba(242,244,248,.6)", fontFamily: "Onest, sans-serif", ...delay(1.4) }}>
        КИНОЗАЛ ОТКРЫТ
      </p>
      <div className="in-curtain in-curtain-l" />
      <div className="in-curtain in-curtain-r" />
      {bulbs(18)}
      {bulbs(692)}
    </>
  );
}
