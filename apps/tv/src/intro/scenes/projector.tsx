// The startup intro in «projector» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import { DESIGN_SWATCH } from "@martytv/ui";
import { delay, Mascot } from "../parts";
import "./projector.css";

// ================================================================ Проектор

export function Scene() {
  const sw = DESIGN_SWATCH.projector;
  const strip = (left: number) => (
    <div className="in-abs" style={{ left, top: 0, width: 46, height: 720, overflow: "hidden", background: "rgba(255,255,255,.04)" }}>
      <div className="in-perf" style={{ display: "flex", flexDirection: "column", gap: 34, paddingTop: 14 }}>
        {Array.from({ length: 13 }, (_, i) => (
          <div key={i} style={{ width: 22, height: 30, marginLeft: 12, borderRadius: 5, background: "rgba(244,248,248,.18)" }} />
        ))}
      </div>
    </div>
  );
  return (
    <>
      {strip(24)}
      {strip(1210)}
      <svg className="in-abs in-leader" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        <line x1="640" y1="110" x2="640" y2="550" stroke={sw.text} strokeOpacity=".35" strokeWidth="2" />
        <line x1="380" y1="330" x2="900" y2="330" stroke={sw.text} strokeOpacity=".35" strokeWidth="2" />
        <path className="in-sweep" d="M640 330 L640 140 A190 190 0 0 1 830 330 Z" fill={sw.accent} fillOpacity=".28" />
        <circle cx="640" cy="330" r="190" fill="none" stroke={sw.text} strokeOpacity=".7" strokeWidth="4" />
        <circle cx="640" cy="330" r="150" fill="none" stroke={sw.text} strokeOpacity=".45" strokeWidth="3" />
        {["3", "2", "1"].map((n, i) => (
          <text key={n} className="in-count" style={delay(i * 0.5)} x="640" y="378" textAnchor="middle" fontSize="150" fontWeight="700" fill={sw.text} fontFamily="Onest, sans-serif">
            {n}
          </text>
        ))}
      </svg>
      <svg className="in-abs in-beam" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        <defs>
          <linearGradient id="in-beam-g" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={sw.accent} stopOpacity=".55" />
            <stop offset="1" stopColor={sw.accent} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points="610,0 670,0 1000,720 280,720" fill="url(#in-beam-g)" />
      </svg>
      <div className="in-center in-flicker" style={{ top: 228, gap: 24, color: sw.text, fontFamily: "Unbounded, Onest, sans-serif" }}>
        <Mascot color={sw.accent} ink={sw.bg} size={130} />
        <div style={{ display: "flex", alignItems: "center", gap: 14, paddingBottom: 8 }}>
          <span style={{ fontSize: 112, fontWeight: 800, letterSpacing: -4, lineHeight: 1 }}>cineko</span>
          <span style={{ border: `5px solid ${sw.accent}`, color: sw.accent, fontSize: 78, fontWeight: 800, lineHeight: 1, padding: "4px 18px 12px", borderRadius: 999 }}>tv</span>
        </div>
      </div>
    </>
  );
}
