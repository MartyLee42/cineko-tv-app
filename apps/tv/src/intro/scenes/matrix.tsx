// The startup intro in «matrix» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import { DESIGN_SWATCH } from "@martytv/ui";
import { delay } from "../parts";
import "./matrix.css";

/** «Матрица»: columns of green code drop in, a prompt types the connection, the name glows. */
const MX_GLYPHS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉ0123456789";
const MX_COLS = Array.from({ length: 26 }, (_, i) => {
  let s = "";
  for (let k = 0; k < 14; k++) s += MX_GLYPHS[(i * 7 + k * 13) % MX_GLYPHS.length];
  return { x: 20 + i * 48, s, d: ((i * 37) % 11) / 10, o: 0.25 + ((i * 53) % 7) / 10 };
});

export function Scene() {
  const sw = DESIGN_SWATCH.matrix;
  const mono = "'JetBrains Mono', ui-monospace, monospace";
  return (
    <>
      {MX_COLS.map((c) => (
        <div key={c.x} className="in-abs in-mx-col" style={{ left: c.x, top: -40, width: 30, fontFamily: mono, fontSize: 26, lineHeight: "30px", wordBreak: "break-all", textAlign: "center", color: sw.accent, opacity: c.o, ...delay(c.d) }}>
          {c.s}
        </div>
      ))}
      <div className="in-abs" style={{ left: 0, top: 0, width: 1280, height: 720, background: "linear-gradient(180deg, rgba(0,6,2,.2), rgba(0,6,2,.85) 55%, rgba(0,6,2,.95))" }} />
      <div className="in-abs in-line" style={{ left: 120, top: 250, fontFamily: mono, fontSize: 26, color: sw.text, ...delay(0.9) }}>
        {"> connecting to the cinema…"}
      </div>
      <div className="in-abs" style={{ left: 120, top: 320, fontFamily: mono, fontWeight: 700, fontSize: 132, lineHeight: 1, color: sw.accent2, display: "flex", alignItems: "center" }}>
        <span className="in-type" style={{ textShadow: `0 0 18px ${sw.accent}, 0 0 40px rgba(0,255,65,.5)` }}>CINEKO</span>
        <span className="in-cursor" style={{ display: "inline-block", width: 56, height: 118, background: sw.accent, marginLeft: 18 }} />
      </div>
    </>
  );
}
