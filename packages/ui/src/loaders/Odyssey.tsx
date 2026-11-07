// «Космическая одиссея»: over a planet's rim a dark monolith rises while a
// moon and a sun drift into line above it. At 100 % the sun flares and a
// single quiet note plays — only with «Звуки интерфейса» on (silent
// otherwise). Original drawing: a black slab and three discs.
import { useEffect, useRef } from "react";
import { playLoaderSound } from "../uiSoundsAudio";
import { ArtBox, At, type ArtProps } from "./parts";
import { alignment, monolithRise, ODYSSEY_NOTE } from "./logic";

const CSS = `
.ld-flare { animation: ld-flare 1.6s ease-out both; }
@keyframes ld-flare { from { opacity: 0; transform: scale(.3); } 35% { opacity: 1; } to { opacity: .85; transform: scale(1); } }
.ld-twinkle { animation: ld-twinkle 3s ease-in-out infinite alternate; }
@keyframes ld-twinkle { from { opacity: .35; } to { opacity: 1; } }
`;

// Deterministic star field.
const STARS = Array.from({ length: 70 }, (_, i) => {
  const a = Math.sin(i * 12.9898) * 43758.5453;
  const b = Math.sin(i * 78.233) * 12345.6789;
  return { x: (a - Math.floor(a)) * 1200, y: (b - Math.floor(b)) * 380, r: i % 7 === 0 ? 2.6 : 1.4 };
});

const SLAB_W = 72;
const SLAB_H = 290;
const HORIZON = 440;

export function OdysseyArt({ p, width, calm, done, quiet, label }: ArtProps & { label?: string }) {
  const rise = done ? 1 : monolithRise(p);
  const a = done ? 1 : alignment(p);
  const played = useRef(false);
  useEffect(() => {
    if (done && !quiet && !played.current) {
      played.current = true;
      playLoaderSound(ODYSSEY_NOTE);
    }
  }, [done, quiet]);
  // Moon and sun slide in from the sides to line up over the slab.
  const moonX = 600 + (1 - a) * -330;
  const sunX = 600 + (1 - a) * 380;
  const sunY = 120 + (1 - a) * 70;
  return (
    <ArtBox width={width} calm={calm} css={CSS} label={label}>
      <At x={0} y={0} w={1200} h={560} style={{ background: "radial-gradient(ellipse at 50% 30%, #101522 0%, #05060a 70%)", borderRadius: 24, overflow: "hidden" }}>
        <svg width="1200" height="560" viewBox="0 0 1200 560" aria-hidden className={calm ? undefined : "ld-twinkle"}>
          {STARS.map((s, i) => (
            <circle key={i} cx={s.x} cy={s.y} r={s.r} fill="#dfe6ff" opacity={i % 3 ? 0.55 : 0.9} />
          ))}
        </svg>
        {/* sun (behind), flaring when done */}
        <At x={0} y={0} w={180} h={180} className="ld-ease" style={{ transform: `translate3d(${sunX - 90}px,${sunY - 90}px,0)` }}>
          <div style={{ width: 180, height: 180, borderRadius: 90, background: "radial-gradient(circle, #fffbe6 0%, #ffd77a 35%, rgba(255,190,90,.25) 60%, rgba(255,190,90,0) 72%)" }} />
        </At>
        {done && (
          <At x={600 - 400} y={120 - 400} w={800} h={800} className="ld-flare">
            <div style={{ width: 800, height: 800, borderRadius: 400, background: "radial-gradient(circle, rgba(255,250,225,.95) 0%, rgba(255,220,140,.35) 18%, rgba(255,220,140,0) 45%)" }} />
          </At>
        )}
        {/* moon in front of the sun */}
        <At x={0} y={0} w={130} h={130} className="ld-ease" style={{ transform: `translate3d(${moonX - 65}px,${190 - 65}px,0)` }}>
          <div style={{ width: 130, height: 130, borderRadius: 65, background: "radial-gradient(circle at 65% 35%, #6d7385, #2a2e3a 60%, #14161d)" }} />
        </At>
        {/* the slab rises from behind the rim */}
        <div style={{ position: "absolute", left: 600 - SLAB_W / 2, top: HORIZON - SLAB_H - 10, width: SLAB_W, height: SLAB_H + 10, overflow: "hidden" }}>
          <div className="ld-ease" style={{ width: SLAB_W, height: SLAB_H, transform: `translate3d(0,${(1 - rise) * (SLAB_H + 10)}px,0)`, background: "linear-gradient(90deg, #020203 0%, #0b0b10 60%, #26262e 100%)", boxShadow: "inset -2px 0 0 rgba(255,255,255,.18), 0 0 30px rgba(0,0,0,.6)" }} />
        </div>
        {/* the planet's rim */}
        <At x={-200} y={HORIZON} w={1600} h={900} style={{ borderRadius: "50% 50% 0 0 / 120px 120px 0 0", background: "linear-gradient(180deg, #1e2a44 0%, #0b0f18 25%, #05060a 60%)", boxShadow: "0 -4px 24px rgba(120,160,255,.35)" }} />
      </At>
    </ArtBox>
  );
}
