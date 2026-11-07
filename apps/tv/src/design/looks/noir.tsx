// «Нуар»: a dark office at night — light through window blinds, rain on the glass.
import "./noir.css";
import type { Look } from "./types";
import { layer, rand } from "./common";

/** Rain streaks on the glass, fixed once (deterministic): x, y, length, opacity; every 6th slowly runs down. */
const STREAKS = (() => {
  const r = rand(1946);
  return Array.from({ length: 84 }, (_, i) => ({
    x: Math.round(i * 23 + r() * 18),
    y: Math.round(-60 + r() * 1100),
    len: Math.round(30 + r() * 110),
    o: 0.05 + r() * 0.14,
    run: i % 6 === 2,
    d: -Math.round(r() * 16),
  }));
})();

/** Light falling through blinds: parallel diagonal bands, brightest near the window (top right), fading out. */
function Blinds({ dim }: { dim: boolean }) {
  return (
    <svg className="absolute left-0 top-0" width="1920" height="1080" viewBox="0 0 1920 1080" aria-hidden>
      <defs>
        <linearGradient id="nr-slat" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#f2efe6" stopOpacity="0" />
          <stop offset=".18" stopColor="#f2efe6" stopOpacity=".13" />
          <stop offset=".55" stopColor="#f2efe6" stopOpacity=".055" />
          <stop offset="1" stopColor="#f2efe6" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="nr-glow" cx="1500" cy="260" r="900" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f2efe6" stopOpacity=".07" />
          <stop offset="1" stopColor="#f2efe6" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="nr-vignette" cx="960" cy="540" r="1150" gradientUnits="userSpaceOnUse">
          <stop offset=".55" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity=".75" />
        </radialGradient>
      </defs>
      <rect width="1920" height="1080" fill="url(#nr-glow)" />
      {/* The slats: thick bands of light with thin shadows between, on a diagonal from the window. */}
      <g transform="translate(1180 -330) rotate(148)" opacity={dim ? 0.45 : 1}>
        {Array.from({ length: 11 }, (_, i) => (
          <rect key={i} x="0" y={-i * 76 - 46} width="2100" height="46" fill="url(#nr-slat)" />
        ))}
      </g>
      {/* The window frame's shadow: one darker cross bar through the bands. */}
      <g transform="translate(1180 -330) rotate(148)" opacity={dim ? 0.3 : 0.6}>
        <rect x="520" y="-860" width="26" height="900" fill="#0c0c0d" />
      </g>
      <rect width="1920" height="1080" fill="url(#nr-vignette)" />
    </svg>
  );
}

function Room({ calm, dim }: { calm: boolean; dim: boolean }) {
  return (
    <div data-skin-bg="blinds" data-motion={calm ? "calm" : "on"} className={`nr-room ${layer}`}>
      <Blinds dim={dim} />
      {/* Rain on the glass: thin streaks; a few run down slowly (transform only), all still when calm. */}
      <div className="nr-rain absolute left-0 top-0 h-full w-full" style={{ opacity: dim ? 0.5 : 1 }}>
        {STREAKS.map((s) => (
          <span
            key={s.x}
            className={`nr-streak ${!calm && s.run ? "nr-run" : ""}`}
            style={{ left: s.x, top: s.y, height: s.len, opacity: s.o, animationDelay: !calm && s.run ? `${s.d}s` : undefined }}
          />
        ))}
      </div>
    </div>
  );
}

export const look: Look = { Background: ({ calm, dim }) => <Room calm={calm} dim={dim} /> };
