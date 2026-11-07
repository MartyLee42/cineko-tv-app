// The startup intro in «cyberpunk» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import { type CSSProperties } from "react";
import { DESIGN_SWATCH } from "@martytv/ui";
import { delay } from "../parts";
import "./cyberpunk.css";

// ================================================================ Киберпанк

export function Scene() {
  const sw = DESIGN_SWATCH.cyberpunk;
  const cyan = "#00f0ff";
  const mono = "'JetBrains Mono', ui-monospace, monospace";
  const word = (color: string, extra: CSSProperties = {}, cls = "") => (
    <div className={cls} style={{ position: "absolute", left: 0, top: 0, display: "flex", alignItems: "center", gap: 18, ...extra }}>
      <span style={{ fontSize: 132, fontWeight: 800, letterSpacing: -2, lineHeight: 1, color }}>CINEKO</span>
      <span style={{ fontSize: 96, fontWeight: 800, lineHeight: 1, padding: "8px 26px 14px", background: color === sw.accent ? sw.accent2 : "transparent", color: color === sw.accent ? sw.bg : color,
        clipPath: "polygon(16px 0, 100% 0, 100% calc(100% - 16px), calc(100% - 16px) 100%, 0 100%, 0 16px)" }}>TV</span>
    </div>
  );
  const slice = (top: number, h: number, at: number) => (
    <div className="in-ghost" style={{ position: "absolute", left: 0, top: 0, width: 760, height: 160, clipPath: `inset(${top}px 0 ${160 - top - h}px 0)`, ...delay(at) }}>
      {word(sw.accent, {}, "in-slice")}
    </div>
  );
  return (
    <>
      <div className="in-abs" style={{ width: 1280, height: 720, backgroundImage: `linear-gradient(rgba(0,240,255,.07) 1px, transparent 1px), linear-gradient(90deg, rgba(0,240,255,.07) 1px, transparent 1px)`, backgroundSize: "64px 64px" }} />
      <div className="in-abs in-scanbar" style={{ width: 1280, height: 6, background: cyan, boxShadow: `0 0 18px ${cyan}`, opacity: 0.85 }} />
      <div className="in-abs" style={{ left: 260, top: 250, width: 760, height: 160, fontFamily: "Unbounded, Onest, sans-serif" }}>
        <div className="in-ghost" style={delay(0.55)}>
          {word(cyan, { transform: "translate(-6px, 3px)" }, "in-glitch")}
        </div>
        <div className="in-ghost" style={delay(0.6)}>
          {word(sw.accent2, { transform: "translate(6px, -3px)" }, "in-glitch")}
        </div>
        <div className="in-fade" style={delay(0.6)}>{word(sw.accent)}</div>
        {slice(30, 26, 0.8)}
        {slice(92, 20, 0.95)}
      </div>
      <div className="in-abs in-fade" style={{ left: 64, top: 48, fontFamily: mono, fontSize: 20, color: cyan, letterSpacing: ".15em", ...delay(0.2) }}>
        SYS://CINEKO <span className="in-hud" style={{ color: sw.accent2 }}>■</span> LINK OK
      </div>
      <div className="in-abs in-fade" style={{ left: 260, top: 440, fontFamily: mono, fontSize: 22, color: "rgba(238,246,255,.6)", letterSpacing: ".3em", ...delay(1.5) }}>
        // НЕОН. КИНО. ПРЯМО СЕЙЧАС
      </div>
      <div className="in-abs" style={{ left: 1100, top: 640, width: 120, height: 6, background: sw.accent2 }} />
      <div className="in-abs" style={{ left: 64, top: 640, width: 220, height: 6, background: sw.accent }} />
    </>
  );
}
