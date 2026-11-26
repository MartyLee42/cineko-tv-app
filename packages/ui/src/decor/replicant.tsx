// «Репликант»: a neo-noir homage (original drawings only) — the background of the TV app, the PWA and
// the TV intro. A megacity drowned in violet fog: brutalist towers with a few lit windows, a giant
// translucent hologram of Cineko over the walkway (decor/replicant-holo.webp, baked from the idle
// sticker by scripts/decor/replicant-holo.py: pink-violet, scanlines, glitched rows), a lone figure
// in a long coat looking up at it from behind a railing, dust in the haze and rain. Plus the two
// signature pieces of the design: the amber spectral readout (SpectralBand) and the oscilloscope
// trace that swells into a pink-and-cyan bloom (Oscilloscope).
//
// Old TV GPUs: no blur filters — the fog and the blooms are soft gradients; the only motion is the
// rain (one transform) and the hologram's flicker (opacity), both off when `calm`. The CSS classes
// (rp-rain, rp-flicker) live in each app's stylesheet. 1920 × 1080 user units.
import holo from "./replicant-holo.webp";
import { rainStreaks, spectralBarPath, spectralBars, oscilloscope, starField, towers } from "./geometry";

export const REPLICANT_HOLO = holo;

/** The hologram's natural size (the baked image). */
const HOLO_W = 767;
const HOLO_H = 832;

const FAR = towers(31, -40, 1960, 760, 260, 640, 5);
const NEAR = towers(47, -30, 1100, 960, 120, 420, 6);
const WINDOW = ["#ffb24a", "#ff5fc4", "#8fd8ff"];
const RAIN = rainStreaks(170, 2049, 1920, 1080);
const DUST = starField(70, 19, 1920, 900);
/** The walkway's railing in perspective: the deck edge and the top rail, from (1000, far) to the right edge (near). */
const deckY = (x: number) => 960 + (x - 1000) * 0.06;
const railY = (x: number) => 960 - 52 - (x - 1000) * 0.13;
/** Posts along it, closer → further apart. */
const POSTS = Array.from({ length: 15 }, (_, i) => {
  const t = i / 14;
  return Math.round(1000 + t * t * 920);
});

/** The lone figure in a long coat with the collar up, its back to us, hands in pockets (feet at 0,0; ~190 tall). */
const FIGURE_COAT = "M-10 -163 C-17 -161 -23 -156 -24 -147 L-27 -108 L-31 -38 L-21 -35 L-13 -40 L-12 -2 L-4 -2 L-3 -38 L3 -38 L4 -2 L12 -2 L13 -40 L21 -35 L31 -38 L27 -108 L24 -147 C23 -156 17 -161 10 -163 L8 -172 L-8 -172 Z";

/** Faint vertical neon signs on the far towers: x, top, height, colour. */
const SIGNS: [number, number, number, string][] = [
  [212, 330, 150, "#ff3eb4"],
  [618, 260, 120, "#5adcff"],
  [905, 380, 96, "#ffb24a"],
];

export interface HoloCityProps {
  calm?: boolean;
  /** Settings / the guide: the hologram faint, no rain. */
  dim?: boolean;
  className?: string;
  width?: number | string;
  height?: number | string;
  preserveAspectRatio?: string;
}

/** The city in the fog with the giant hologram on the right (mirrored to face the figure on the walkway). */
export function HoloCity({ calm = false, dim = false, className, width = 1920, height = 1080, preserveAspectRatio }: HoloCityProps) {
  const hw = 780;
  const hh = Math.round((hw * HOLO_H) / HOLO_W);
  return (
    <svg className={className} width={width} height={height} viewBox="0 0 1920 1080" preserveAspectRatio={preserveAspectRatio} aria-hidden="true">
      <defs>
        <linearGradient id="rp-sky" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#0a0616" />
          <stop offset=".55" stopColor="#1c0b30" />
          <stop offset="1" stopColor="#2b0d3a" />
        </linearGradient>
        <radialGradient id="rp-halo" cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#ff3eb4" stopOpacity=".42" />
          <stop offset=".45" stopColor="#b43cff" stopOpacity=".16" />
          <stop offset="1" stopColor="#b43cff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="rp-amber" cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#ff9a3c" stopOpacity=".3" />
          <stop offset="1" stopColor="#ff9a3c" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="rp-fog" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#d79cff" stopOpacity="0" />
          <stop offset=".5" stopColor="#e7a6ff" stopOpacity=".16" />
          <stop offset="1" stopColor="#e7a6ff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="rp-deck" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#1a0a26" />
          <stop offset="1" stopColor="#07040c" />
        </linearGradient>
        <linearGradient id="rp-wet" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#ff3eb4" stopOpacity="0" />
          <stop offset=".5" stopColor="#ff3eb4" stopOpacity=".28" />
          <stop offset="1" stopColor="#ff3eb4" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="1920" height="1080" fill="url(#rp-sky)" />
      {/* Far city: tall slabs dissolving in the haze, a few windows, aircraft lights on the tallest. */}
      <g opacity={dim ? 0.35 : 0.7}>
        {FAR.map((b) => (
          <g key={b.x}>
            <rect x={b.x} y={760 - b.h} width={b.w} height={b.h} fill="#241338" />
            {b.antenna && <circle cx={b.x + b.w / 2} cy={760 - b.h - 6} r="3.5" fill="#ff4a5a" />}
            {b.win.map((w, i) => (
              <rect key={i} x={w.x} y={w.y} width="5" height="3" fill={WINDOW[w.c]} opacity=".55" />
            ))}
          </g>
        ))}
      </g>
      {/* Vertical neon signs glowing through the haze. */}
      {!dim &&
        SIGNS.map(([x, y, h, c]) => (
          <g key={x}>
            <rect x={x - 10} y={y - 10} width="34" height={h + 20} rx="6" fill={c} opacity=".12" />
            <rect x={x} y={y} width="14" height={h} rx="2" fill={c} opacity=".5" />
            {Array.from({ length: Math.floor(h / 24) }, (_, i) => (
              <rect key={i} x={x + 3} y={y + 8 + i * 24} width="8" height="12" fill="#0a0616" opacity=".55" />
            ))}
          </g>
        ))}
      <ellipse cx="380" cy="760" rx="620" ry="260" fill="url(#rp-amber)" />
      <rect x="0" y="560" width="1920" height="280" fill="url(#rp-fog)" />
      {/* Near blocks on the left: stepped tops (setbacks), horizontal light slits, fog pooling at their feet. */}
      <g opacity={dim ? 0.6 : 1}>
        {NEAR.map((b, k) => {
          const step = k % 3 === 1 ? Math.round(b.w * 0.22) : 0;
          return (
            <g key={b.x}>
              <rect x={b.x} y={960 - b.h + (step ? 60 : 0)} width={b.w} height={b.h - (step ? 60 : 0)} fill="#120a1e" />
              {step > 0 && <rect x={b.x + step} y={960 - b.h} width={b.w - step * 2} height="62" fill="#120a1e" />}
              {k % 4 === 2 && <rect x={b.x + b.w / 2 - 1} y={960 - b.h - 34} width="2" height="34" fill="#120a1e" />}
              {b.win.map((w, i) => (
                <rect key={i} x={w.x} y={w.y + (step ? 60 : 0)} width="9" height="2" fill={WINDOW[w.c]} opacity=".7" />
              ))}
            </g>
          );
        })}
      </g>
      <rect x="0" y="820" width="1920" height="150" fill="url(#rp-fog)" opacity=".8" />
      {/* The hologram's glow in the fog, then the hologram itself (mirrored, flickering). */}
      <ellipse cx="1500" cy="560" rx="560" ry="480" fill="url(#rp-halo)" opacity={dim ? 0.4 : 1} />
      <g opacity={dim ? 0.22 : 0.92}>
        <image className={calm || dim ? undefined : "rp-flicker"} href={holo} x={-1920 + 40} y={1000 - hh} width={hw} height={hh} transform="scale(-1 1)" preserveAspectRatio="none" />
      </g>
      {/* Dust floating in the haze. */}
      <g fill="#ffd6f4">
        {DUST.map((s, i) => (
          <circle key={i} cx={s.x} cy={s.y} r={s.r * 0.7} opacity={dim ? 0.12 : s.o * 0.4} />
        ))}
      </g>
      {/* The walkway: a wet deck with the hologram's pink in it, the railing running off to the right. */}
      <rect x="0" y="960" width="1920" height="120" fill="url(#rp-deck)" />
      <rect x="1050" y="968" width="820" height="10" fill="url(#rp-wet)" opacity={dim ? 0.4 : 1} />
      <g stroke="#06030b" strokeLinecap="round" fill="none">
        <path d={`M1000 ${railY(1000)} L1920 ${railY(1920)}`} strokeWidth="7" />
        <path d={`M1000 ${(railY(1000) + deckY(1000)) / 2} L1920 ${(railY(1920) + deckY(1920)) / 2}`} strokeWidth="4" />
        {POSTS.map((x) => (
          <line key={x} x1={x} y1={deckY(x)} x2={x} y2={railY(x)} strokeWidth={3 + (x - 1000) / 260} />
        ))}
      </g>
      <path d={`M1000 ${railY(1000) - 1} L1920 ${railY(1920) - 1}`} stroke="#ff7ad0" strokeWidth="1.5" opacity=".45" fill="none" />
      {/* The figure: a black silhouette with a pink rim light from the hologram, a faint reflection on the wet deck. */}
      <g transform="translate(840 964)" opacity={dim ? 0.5 : 1}>
        <ellipse cx="0" cy="-180" rx="9" ry="11" fill="#05030a" stroke="#ff6cc8" strokeWidth="1.4" strokeOpacity=".55" />
        <path d={FIGURE_COAT} fill="#05030a" stroke="#ff6cc8" strokeWidth="1.4" strokeOpacity=".55" />
        <path d={FIGURE_COAT} fill="#ff3eb4" opacity=".08" transform="scale(1 -.35)" />
      </g>
      {/* Rain: the strip drawn twice, 1080 apart, falling one height per cycle (transform only). */}
      {!dim && (
        <g className={calm ? undefined : "rp-rain"} stroke="#cdb6ff" strokeWidth="1.3" strokeLinecap="round">
          {[0, -1080].map((off) => (
            <g key={off} transform={`translate(0 ${off})`}>
              {RAIN.map(([x, y, l, o], i) => (
                <line key={i} x1={x} y1={y} x2={x - l * 0.08} y2={y + l} opacity={o * 1.8} />
              ))}
            </g>
          ))}
        </g>
      )}
    </svg>
  );
}

const BARS = spectralBars(2049, 1920);
/** Faint cyan readout digits under the bars: [x, text]. */
const DIGITS: [number, string][] = [
  [240, "·17"],
  [520, "8"],
  [690, "·125"],
  [930, "0"],
  [1010, "04·7"],
  [1240, "2"],
  [1400, "6"],
  [1690, "9"],
];

/**
 * The amber spectral readout: a band of glowing bars with horizontal striations, some pinched like
 * hourglasses, a few white-hot; cyan digits along the bottom. `reveal` (0…1) lights the bars from the
 * left (the loader); the rest stay dark.
 */
export function SpectralBand({ width = 1920, height = 420, reveal = 1, digits = true, className }: { width?: number | string; height?: number | string; reveal?: number; digits?: boolean; className?: string }) {
  const edge = 1920 * reveal;
  return (
    <svg className={className} width={width} height={height} viewBox="0 0 1920 420" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="rp-bar" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#ff8a1e" />
          <stop offset=".12" stopColor="#ffc46a" />
          <stop offset=".5" stopColor="#ffe2a8" />
          <stop offset=".88" stopColor="#ffc46a" />
          <stop offset="1" stopColor="#ff8a1e" />
        </linearGradient>
        <pattern id="rp-striae" width="8" height="9" patternUnits="userSpaceOnUse">
          <rect width="8" height="3" fill="#2a1200" opacity=".55" />
        </pattern>
      </defs>
      {BARS.map((b) => {
        const on = b.x + b.w <= edge;
        const d = spectralBarPath(b, 30, 330);
        return (
          <g key={b.x} opacity={on ? b.o : 0.07}>
            <path d={d} fill={b.hot ? "#fff3d6" : "url(#rp-bar)"} />
            <path d={d} fill="url(#rp-striae)" />
          </g>
        );
      })}
      {digits && (
        <g fill="#7fd0ff" fontFamily="'IBM Plex Mono', monospace" fontSize="24" opacity=".75">
          {DIGITS.map(([x, s]) => (x < edge ? <text key={x} x={x} y="398">{s}</text> : null))}
        </g>
      )}
    </svg>
  );
}

/** Where the trace swells (fraction of the width), and how many periods it makes there. */
const SWELL_FROM = 0.42;
const CYCLES = 9;

/**
 * The bloom's lobes (kept inside the 540-high frame: a clipped lobe shows a hard edge): one soft bulb on every crest of the swelling wave — warm (orange → pink) above
 * the trace, cold (pink → cyan) below — growing towards the right, like a light painting.
 */
function lobes(bloom: number): { x: number; up: boolean; rx: number; ry: number }[] {
  const start = 1920 * SWELL_FROM;
  const span = 1920 - start;
  const out: { x: number; up: boolean; rx: number; ry: number }[] = [];
  for (let k = 0; k < CYCLES; k++) {
    for (const [off, up] of [
      [0.25, true],
      [0.75, false],
    ] as const) {
      const t = (k + off) / CYCLES;
      const g = t * t;
      out.push({ x: Math.round(start + span * t), up, rx: Math.round((span / CYCLES) * (0.4 + 0.55 * g)), ry: Math.round((36 + 132 * g) * (0.35 + 0.65 * bloom)) });
    }
  }
  return out;
}

/**
 * The oscilloscope: an orange trace with blue sync spikes on the left that swells into a wave and
 * blooms — warm lobes above, cold below — towards the right. `bloom` (0…1) is how far it has opened.
 */
export function Oscilloscope({ width = 1920, height = 540, bloom = 1, className }: { width?: number | string; height?: number | string; bloom?: number; className?: string }) {
  const trace = oscilloscope(0, 1920, 270, 70, CYCLES, SWELL_FROM);
  return (
    <svg className={className} width={width} height={height} viewBox="0 0 1920 540" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <radialGradient id="rp-lobe-up" cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#ffe0cc" stopOpacity=".95" />
          <stop offset=".35" stopColor="#ff8a4a" stopOpacity=".75" />
          <stop offset=".7" stopColor="#e8335a" stopOpacity=".32" />
          <stop offset="1" stopColor="#e8335a" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="rp-lobe-down" cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#ffb0e0" stopOpacity=".8" />
          <stop offset=".35" stopColor="#4fd8e8" stopOpacity=".62" />
          <stop offset=".7" stopColor="#2a8fd0" stopOpacity=".25" />
          <stop offset="1" stopColor="#2a8fd0" stopOpacity="0" />
        </radialGradient>
        {/* The haze behind the lobes: elliptical, fading to nothing well inside the frame. */}
        <radialGradient id="rp-haze-up" gradientUnits="userSpaceOnUse" cx="1700" cy="270" r="900" gradientTransform="translate(1700 270) scale(1 .26) translate(-1700 -270)">
          <stop offset="0" stopColor="#ff7a4a" stopOpacity=".55" />
          <stop offset=".5" stopColor="#c02a5a" stopOpacity=".18" />
          <stop offset="1" stopColor="#c02a5a" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="rp-haze-down" gradientUnits="userSpaceOnUse" cx="1700" cy="270" r="900" gradientTransform="translate(1700 270) scale(1 .28) translate(-1700 -270)">
          <stop offset="0" stopColor="#4fd8e8" stopOpacity=".5" />
          <stop offset=".5" stopColor="#2a6fd0" stopOpacity=".16" />
          <stop offset="1" stopColor="#2a6fd0" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="rp-spike" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#2f7dff" stopOpacity="0" />
          <stop offset=".5" stopColor="#5aa8ff" />
          <stop offset="1" stopColor="#2f7dff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g opacity={0.25 + 0.75 * bloom}>
        <rect x="0" y="0" width="1920" height="270" fill="url(#rp-haze-up)" />
        <rect x="0" y="270" width="1920" height="270" fill="url(#rp-haze-down)" />
        {lobes(bloom).map((l) => (
          <ellipse key={`${l.x}${l.up}`} cx={l.x} cy={l.up ? 270 - l.ry * 0.55 : 270 + l.ry * 0.55} rx={l.rx} ry={l.ry} fill={l.up ? "url(#rp-lobe-up)" : "url(#rp-lobe-down)"} />
        ))}
      </g>
      {/* Blue sync spikes on the left. */}
      {[60, 180, 300, 420].map((x, i) => (
        <rect key={x} x={x - 6 + i} y="90" width={14 - i * 3} height="360" rx="7" fill="url(#rp-spike)" opacity={1 - i * 0.22} />
      ))}
      <path d={trace} fill="none" stroke="#ff7a2a" strokeWidth="9" strokeLinejoin="round" opacity=".55" />
      <path d={trace} fill="none" stroke="#ffd9a8" strokeWidth="3" strokeLinejoin="round" />
    </svg>
  );
}
