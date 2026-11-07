// The startup intro in «noir» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import { DESIGN_SWATCH } from "@martytv/ui";
import { delay, Mascot } from "../parts";
import "./noir.css";

const NAME = "CINEKO";
const RAIN = Array.from({ length: 34 }, (_, i) => ({ x: (i * 157) % 1280, y: (i * 89) % 520, h: 40 + ((i * 37) % 70), d: ((i * 29) % 10) / 10 }));

/**
 * «Нуар»: a dark office. Light through the blinds slides across the wall (a
 * car passing in the rain), drops run down the glass, the name is typed out a
 * key at a time, and Cineko steps into the light in black and white.
 */
export function Scene() {
  const sw = DESIGN_SWATCH.noir;
  const mono = "'IBM Plex Mono', 'Courier New', monospace";
  return (
    <>
      {/* The blinds' light: diagonal bands sweeping in. */}
      <div className="in-abs nri-light" style={{ left: 240, top: -260, width: 1400, height: 1100 }}>
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i} className="in-abs" style={{ left: 0, top: i * 92, width: 1400, height: 52, background: "linear-gradient(90deg, rgba(242,239,230,0), rgba(242,239,230,.2) 30%, rgba(242,239,230,.06) 75%, rgba(242,239,230,0))" }} />
        ))}
      </div>
      {RAIN.map((r, i) => (
        <div key={i} className="in-abs nri-drop" style={{ left: r.x, top: r.y, width: 2, height: r.h, ...delay(r.d) }} />
      ))}
      <div className="in-abs" style={{ width: 1280, height: 720, background: "radial-gradient(ellipse at 50% 45%, rgba(0,0,0,0) 45%, rgba(0,0,0,.8) 100%)" }} />
      {/* Cineko in the light, black and white. */}
      <div className="in-abs in-fade nri-bw" style={{ left: 960, top: 300, ...delay(1.5) }}>
        <Mascot color={sw.text} ink={sw.bg} size={190} />
      </div>
      {/* The name, typed: one key per 0.13 s; the cursor blinks once it is done. */}
      <div className="in-abs" style={{ left: 110, top: 268, fontFamily: mono, fontWeight: 600, fontSize: 128, lineHeight: 1, color: sw.accent, display: "flex", alignItems: "center", whiteSpace: "nowrap" }}>
        {NAME.split("").map((c, i) => (
          <span key={i} className="nri-key" style={delay(0.55 + i * 0.13)}>
            {c}
          </span>
        ))}
        <span className="nri-cursor" style={{ display: "inline-block", width: 14, height: 112, background: sw.accent, marginLeft: 12 }} />
      </div>
      <div className="in-abs nri-key" style={{ left: 114, top: 420, fontFamily: mono, fontSize: 30, letterSpacing: ".04em", color: sw.text, opacity: 0.8, ...delay(1.55) }}>
        Ночь. Дождь. Кино.
      </div>
      <div className="in-abs in-fade" style={{ left: 114, top: 478, width: 520, height: 2, background: sw.accent2, ...delay(1.9) }} />
    </>
  );
}
