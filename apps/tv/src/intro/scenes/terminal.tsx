// The startup intro in «terminal» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import { type CSSProperties } from "react";
import { DESIGN_SWATCH } from "@martytv/ui";
import { delay } from "../parts";
import "./terminal.css";

const BOOT = [
  "[ OK ] mount /catalog ........ tmdb",
  "[ OK ] link prowlarr ......... ready",
  "[ OK ] link torrserver ....... ready",
  "[ OK ] load profiles ......... done",
  "[ OK ] tune remote ........... ok",
  "> martytv --start",
];

export function Scene() {
  const sw = DESIGN_SWATCH.terminal;
  const mono = "'JetBrains Mono', ui-monospace, monospace";
  const corner = (s: CSSProperties) => <div className="in-abs" style={{ width: 40, height: 40, borderColor: sw.accent, borderStyle: "solid", borderWidth: 0, ...s }} />;
  return (
    <>
      <div className="in-abs in-scan" style={{ width: 1280, height: 720 }} />
      {corner({ left: 40, top: 36, borderLeftWidth: 4, borderTopWidth: 4 })}
      {corner({ left: 1200, top: 36, borderRightWidth: 4, borderTopWidth: 4 })}
      {corner({ left: 40, top: 644, borderLeftWidth: 4, borderBottomWidth: 4 })}
      {corner({ left: 1200, top: 644, borderRightWidth: 4, borderBottomWidth: 4 })}
      <div className="in-abs" style={{ left: 96, top: 90, fontFamily: mono, fontSize: 21, lineHeight: 1.75, color: "rgba(236,236,232,.72)" }}>
        {BOOT.map((l, i) => (
          <div key={i} className="in-line" style={{ ...delay(0.1 + i * 0.14), color: l.startsWith(">") ? sw.text : undefined }}>
            {l.startsWith("[ OK ]") ? (
              <>
                <span style={{ color: sw.accent }}>[ OK ]</span>
                {l.slice(6)}
              </>
            ) : (
              l
            )}
          </div>
        ))}
      </div>
      <div className="in-abs" style={{ left: 96, top: 380, fontFamily: mono, fontWeight: 500, fontSize: 132, lineHeight: 1, color: sw.text, letterSpacing: -2, display: "flex", alignItems: "center" }}>
        <span className="in-type">
          CINEKO<span style={{ color: sw.accent }}>.</span>
        </span>
        <span className="in-line" style={{ ...delay(1.95), background: sw.accent, color: sw.bg, padding: "0 18px", marginLeft: 8 }}>TV</span>
        <span className="in-cursor" style={{ display: "inline-block", width: 56, height: 118, background: sw.text, marginLeft: 18 }} />
      </div>
      <div className="in-abs in-line" style={{ left: 100, top: 560, fontFamily: mono, fontSize: 20, letterSpacing: ".2em", color: "rgba(236,236,232,.5)", ...delay(2.15) }}>
        SYSTEM READY · ВСЁ ГОТОВО К ПРОСМОТРУ
      </div>
    </>
  );
}
