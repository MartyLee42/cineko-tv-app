// «Снегопад»: snow falls over a quiet winter night (three layers of flakes
// at different sizes and speeds, each a tall tile sliding down forever);
// drifts slowly grow at the bottom; now and then Cineko walks in, stops to
// catch a flake and walks on. Transform / opacity only.
import { Mascot } from "@martytv/ui";

/** Flake layers: tile size, flake radius, fall time (s), sway time (s), opacity. */
const LAYERS = [
  { tile: 220, r: 2.2, fall: 26, sway: 9, o: 0.55 },
  { tile: 300, r: 3.4, fall: 17, sway: 7, o: 0.75 },
  { tile: 420, r: 5, fall: 11, sway: 5, o: 0.9 },
] as const;

/** A tile of scattered flakes (the same pattern repeats; the layers' sizes differ, so it never lines up). */
function flakes(tile: number, r: number): string {
  const pts = [
    [0.12, 0.08], [0.47, 0.2], [0.83, 0.12], [0.28, 0.41], [0.66, 0.36], [0.92, 0.55],
    [0.06, 0.66], [0.4, 0.72], [0.74, 0.8], [0.55, 0.93], [0.2, 0.9],
  ];
  return pts.map(([x, y]) => `radial-gradient(circle at ${Math.round(x! * tile)}px ${Math.round(y! * tile)}px, rgba(255,255,255,.95) 0, rgba(255,255,255,.95) ${r}px, rgba(255,255,255,0) ${r + 1}px)`).join(",");
}

/** Pines along the drifts (static). */
const PINES = [140, 330, 1460, 1610, 1790];

export function Snow() {
  return (
    <div data-testid="saver-snow" className="sn-sky absolute left-0 top-0 overflow-hidden" style={{ width: 1920, height: 1080 }}>
      <span className="sn-moon absolute" style={{ left: 1500, top: 120 }} />
      <svg className="absolute bottom-0 left-0" width="1920" height="420" viewBox="0 0 1920 420" aria-hidden>
        <path d="M0 250 Q 300 170 640 230 T 1300 210 T 1920 230 L1920 420 L0 420 Z" fill="#1b2a44" />
        {PINES.map((x, i) => (
          <path key={x} d={`M${x} ${150 - (i % 2) * 40} L${x + 58} 290 L${x - 58} 290 Z`} fill="#0f1a2c" />
        ))}
      </svg>
      {LAYERS.map((l, i) => (
        <div key={i} className="sn-sway absolute left-0 top-0" style={{ animationDuration: `${l.sway}s`, opacity: l.o }}>
          <div
            className="sn-fall"
            style={{
              width: 1920 + l.tile,
              height: 1080 + l.tile * 3,
              backgroundImage: flakes(l.tile, l.r),
              backgroundSize: `${l.tile}px ${l.tile}px`,
              animationDuration: `${l.fall}s`,
              ["--sn-tile" as string]: `${l.tile * 3}px`,
            }}
          />
        </div>
      ))}
      {/* The drift, growing over the first ten minutes. */}
      <svg className="sn-drift absolute bottom-0 left-0" width="1920" height="220" viewBox="0 0 1920 220" aria-hidden>
        <path d="M0 120 Q 240 60 520 110 T 1080 100 T 1560 90 T 1920 110 L1920 220 L0 220 Z" fill="#e9f0fb" />
        <path d="M0 150 Q 300 110 700 140 T 1400 135 T 1920 150 L1920 220 L0 220 Z" fill="#cfdcef" />
      </svg>
      {/* Cineko's walk: in, a stop with a hop (a flake), out; then a long pause. */}
      <div className="sn-walk absolute" style={{ left: 0, top: 820 }}>
        <div className="sn-hop">
          <Mascot mood="excited" size={150} animated={false} />
        </div>
      </div>
    </div>
  );
}
