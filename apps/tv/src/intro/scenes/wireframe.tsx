// The startup intro in «wireframe» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import { useMemo, type CSSProperties } from "react";
import { DESIGN_SWATCH } from "@martytv/ui";
import { delay, Mascot } from "../parts";
import "./wireframe.css";

const STAR = "M12 0 L14.5 9.5 L24 12 L14.5 14.5 L12 24 L9.5 14.5 L0 12 L9.5 9.5 Z";

// ================================================================ Каркас

/** The mockup's 20 terrain rows (perspective: far rows small and faint).
 *  Each row is its own band (from its crests down to the next row's lowest
 *  point, which hides it) drawn once and slid as a compositor layer: the TV
 *  never repaints the SVG while the waves drift, so the lines don't flicker. */
function terrainRows() {
  const N = 20, L = 200, k = (2 * Math.PI) / L;
  const geo = Array.from({ length: N }, (_, i) => {
    const t = i / (N - 1);
    return { t, y0: 362 + Math.pow(t, 1.8) * 345, s: 0.45 + t * 1.75, amp: 15 + 11 * Math.pow(Math.sin(i * 0.9), 2) };
  });
  return geo.map(({ t, y0, s, amp }, i) => {
    const half = 640 / s + L + 24;
    const p1 = i * 1.37, p2 = i * 0.61, p3 = i * 2.11;
    const pts: string[] = [];
    let lastX = -half;
    for (let x = -half; x <= half; x += 8) {
      const y = -amp * (0.55 * Math.sin(k * x + p1) + 0.3 * Math.sin(2 * k * x + p2) + 0.15 * Math.sin(3 * k * x + p3));
      pts.push(`${x.toFixed(1)} ${y.toFixed(1)}`);
      lastX = x;
    }
    const top = Math.floor(y0 - s * amp - 6);
    const next = geo[i + 1];
    const bottom = next ? Math.ceil(next.y0 + next.s * next.amp + 6) : 720;
    const local = ((bottom - y0) / s + 10).toFixed(0);
    return {
      d: `M${pts.join(" L")} L${lastX.toFixed(1)} ${local} L${(-half).toFixed(1)} ${local} Z`,
      tf: `translate(640 ${(y0 - top).toFixed(1)}) scale(${s.toFixed(3)})`,
      top,
      height: bottom - top,
      width: 1280 + Math.ceil((L + 30) * s),
      // One wavelength on screen: the loop is seamless.
      shift: (L * s).toFixed(2),
      sw: 1.1 + t * 1.6,
      op: 0.35 + 0.65 * t,
      delay: i * 0.035,
    };
  });
}

export function Scene() {
  const sw = DESIGN_SWATCH.wireframe;
  const accent = sw.accent;
  const bg = sw.bg;
  const rows = useMemo(() => terrainRows(), []);
  const keyframes = useMemo(
    () => rows.map((r, i) => `@keyframes in-drift-${i}{from{transform:translateX(0)}to{transform:translateX(-${r.shift}px)}}`).join(""),
    [rows],
  );
  return (
    <>
      <style>{keyframes}</style>
      <div className="in-abs in-glow" style={{ left: 280, top: 110, width: 720, height: 380, borderRadius: "50%", background: `radial-gradient(closest-side, ${accent}, transparent)` }} />
      {rows.map((r, i) => (
        <div key={i} className="in-row" style={{ top: r.top, height: r.height, ...delay(r.delay) }}>
          <div className="in-drift" style={{ width: r.width, height: r.height, animationName: `in-drift-${i}` }}>
            <svg viewBox={`0 0 ${r.width} ${r.height}`} width={r.width} height={r.height} aria-hidden="true">
              <g transform={r.tf}>
                <path d={r.d} fill={bg} stroke={accent} strokeWidth={r.sw} strokeOpacity={r.op} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
              </g>
            </svg>
          </div>
        </div>
      ))}
      <div className="in-center" style={{ top: 178, gap: 22, color: sw.text, fontFamily: "Unbounded, Onest, sans-serif" }}>
        <div style={{ width: 150, height: 170, overflow: "hidden", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
          <div className="in-pop" style={delay(0.5)}>
            <Mascot color={accent} ink="#140a26" />
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, paddingBottom: 10 }}>
          <div style={{ display: "flex", fontSize: 118, fontWeight: 800, lineHeight: 1, letterSpacing: -4 }}>
            {"cineko".split("").map((c, i) => (
              <span key={i} className="in-drop" style={delay(0.85 + i * 0.07)}>
                <span className="in-bob" style={delay(i * 0.15)}>{c}</span>
              </span>
            ))}
          </div>
          <div style={{ position: "relative" }}>
            <div className="in-pill" style={{ background: accent, color: "#140a26", fontSize: 88, fontWeight: 800, lineHeight: 1, padding: "6px 22px 14px", borderRadius: 30, letterSpacing: -2 }}>tv</div>
            <Star size={30} color={sw.text} style={{ right: -26, top: -22 }} at={1.65} />
            <Star size={18} color={accent} style={{ right: -40, top: 30 }} at={1.9} />
            <Star size={22} color={sw.text} style={{ left: -14, top: -30 }} at={2.15} />
          </div>
        </div>
      </div>
    </>
  );
}

function Star({ size, color, style, at }: { size: number; color: string; style: CSSProperties; at: number }) {
  return (
    <svg className="in-star" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" style={{ position: "absolute", ...style, ...delay(at) }}>
      <path d={STAR} fill={color} />
    </svg>
  );
}
