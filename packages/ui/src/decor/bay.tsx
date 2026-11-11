// «Пять звёзд»: the bay (original drawing), one panel of the sticker collage (collage.tsx) on the
// TV, in the PWA and in the TV intro. A cel-shaded comic city in blue duotone, like the painted box
// art of 80s crime-game covers: an azure sky with flat cartoon clouds and a helicopter, a pale sun
// over the sea, a row of art-deco hotels in blues with ink outlines and hot-pink neon trim (one
// with a vertical «CINEKO» sign), a beach, a promenade with a neon curb, palms in ink.
// 1920 × 1080 user units; static except the glints on the water (opacity only, off when `calm`).
import { palm, starPath } from "./geometry";

const HORIZON = 700;
const BEACH = 860;
const INK = "#061a35";
const NEON = "#ff5fae";

interface Hotel {
  x: number;
  w: number;
  h: number;
  body: string;
  shade: string;
  top: "steps" | "tower" | "flat";
  sign?: string;
}

/** The hotel row along the beach, left to right (hand-placed so it reads as a promenade). */
const HOTELS: Hotel[] = [
  { x: -10, w: 200, h: 300, body: "#2b78c4", shade: "#1d5c9e", top: "steps" },
  { x: 200, w: 220, h: 360, body: "#3c8fd6", shade: "#2669aa", top: "tower", sign: "CINEKO" },
  { x: 432, w: 180, h: 250, body: "#2268b0", shade: "#18508c", top: "flat" },
  { x: 624, w: 210, h: 310, body: "#4a9ee0", shade: "#2f78ba", top: "steps" },
  { x: 846, w: 150, h: 210, body: "#2a74ba", shade: "#1c5794", top: "flat" },
];

/** Flat cartoon clouds: [x, y, scale]. */
const CLOUDS: [number, number, number][] = [
  [180, 250, 1],
  [760, 170, 0.8],
  [1180, 420, 1.2],
  [1620, 560, 0.9],
  [520, 560, 0.7],
];
const CLOUD = "M0 40 C -6 18 18 6 34 14 C 44 -6 84 -6 94 16 C 112 4 140 16 136 40 Z";

/** Glints on the water under the sun: [half-width, y]; two sets that take turns. */
const GLINT_A: [number, number][] = [
  [130, 714],
  [100, 734],
  [120, 758],
  [70, 784],
  [90, 812],
  [50, 838],
];
const GLINT_B: [number, number][] = [
  [110, 722],
  [130, 745],
  [80, 770],
  [100, 797],
  [60, 824],
  [40, 848],
];

const PALMS = [palm(150, 1080, 640, 30), palm(560, 1080, 520, -44), palm(1010, 1080, 560, 48), palm(1660, 1080, 520, 34), palm(1800, 1080, 700, -64)];
const SUN_X = 1440;
const SPARK = starPath(10);

function HotelArt({ h }: { h: Hotel }) {
  const top = BEACH - h.h;
  const ledges: number[] = [];
  for (let y = top + 40; y < BEACH - 30; y += 44) ledges.push(y);
  const wins: { x: number; y: number; lit: boolean }[] = [];
  ledges.forEach((y, r) => {
    for (let x = h.x + 16, c = 0; x + 14 < h.x + h.w - 10; x += 26, c++) wins.push({ x, y: y + 12, lit: (r * 7 + c * 3 + h.x) % 5 < 2 });
  });
  const steps =
    h.top === "steps"
      ? [
          { x: h.x + h.w * 0.2, y: top - 28, w: h.w * 0.6, hh: 28 },
          { x: h.x + h.w * 0.35, y: top - 52, w: h.w * 0.3, hh: 24 },
        ]
      : h.top === "tower"
        ? [{ x: h.x + h.w / 2 - 22, y: top - 120, w: 44, hh: 120 }]
        : [];
  return (
    <g>
      {steps.map((s, i) => (
        <rect key={i} x={s.x} y={s.y} width={s.w} height={s.hh} fill={h.body} stroke={INK} strokeWidth="4" />
      ))}
      <rect x={h.x} y={top} width={h.w} height={h.h} fill={h.body} stroke={INK} strokeWidth="4" />
      {/* Cel shading: the right third in shadow, the ledges catching light. */}
      <rect x={h.x + h.w * 0.66} y={top + 2} width={h.w * 0.34 - 2} height={h.h - 2} fill={h.shade} />
      {ledges.map((y) => (
        <rect key={y} x={h.x - 6} y={y} width={h.w + 12} height="6" fill="#bfe6ff" stroke={INK} strokeWidth="2" />
      ))}
      {wins.map((w, i) => (
        <rect key={i} x={w.x} y={w.y} width="14" height="18" fill={w.lit ? "#ffe9a8" : "#0d3a6e"} stroke={INK} strokeWidth="1.5" />
      ))}
      {/* Hot-pink neon along the roofline: a wide faint glow under a thin bright tube. */}
      {[10, 3].map((sw) => (
        <g key={sw} fill="none" stroke={NEON} strokeWidth={sw} opacity={sw > 3 ? 0.3 : 1} strokeLinejoin="round">
          <path d={`M${h.x + 4} ${top + 8} L${h.x + h.w - 4} ${top + 8}`} />
          {steps.map((s, i) => (
            <path key={i} d={`M${s.x + 4} ${s.y + 8} L${s.x + s.w - 4} ${s.y + 8}`} />
          ))}
        </g>
      ))}
      {h.sign && (
        <g>
          {[...h.sign].map((ch, i) => (
            <text key={i} x={h.x + h.w / 2} y={top - 88 + i * 32} textAnchor="middle" fontSize="28" fontWeight="700" fill="#ffffff" stroke={NEON} strokeWidth="5" paintOrder="stroke">
              {ch}
            </text>
          ))}
        </g>
      )}
    </g>
  );
}

/** A police helicopter in profile, nose to the left (drawn round (0, 0), about 220 wide). */
function Helicopter() {
  return (
    <g stroke={INK} strokeWidth="4" strokeLinejoin="round" strokeLinecap="round">
      <path d="M-110 -52 L110 -52" fill="none" />
      <path d="M0 -52 L0 -34" fill="none" />
      <path d="M-70 -34 C -96 -34 -104 6 -80 14 L20 14 C 40 14 46 -6 40 -20 C 34 -32 20 -34 0 -34 Z" fill="#8fd3ff" />
      <path d="M-74 -26 C -90 -24 -92 0 -78 4 L-50 4 L-46 -26 Z" fill="#d6f1ff" />
      <path d="M40 -14 L130 -24 L132 -14 L44 2 Z" fill="#5fb6ec" />
      <path d="M118 -38 L136 -38 L132 -10 L122 -10 Z" fill="#5fb6ec" />
      <path d="M-70 26 L30 26 M-50 14 L-56 26 M10 14 L16 26" fill="none" />
    </g>
  );
}

export function ComicBay({
  calm = false,
  dim = false,
  className,
  width = 1920,
  height = 1080,
  preserveAspectRatio,
}: {
  calm?: boolean;
  dim?: boolean;
  className?: string;
  width?: number | string;
  height?: number | string;
  preserveAspectRatio?: string;
}) {
  const glint = (set: [number, number][], cls: string) => (
    <g className={calm || dim ? undefined : cls}>
      {set.map(([hw, y], i) => (
        <rect key={y} x={SUN_X - hw} y={y} width={hw * 2} height={i < 2 ? 5 : 4} rx="2" fill="#e6f7ff" opacity={0.9 - i * 0.1} />
      ))}
    </g>
  );
  return (
    <svg className={className} width={width} height={height} viewBox="0 0 1920 1080" preserveAspectRatio={preserveAspectRatio} aria-hidden="true">
      <defs>
        <linearGradient id="fsb-sky" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#0a3a78" />
          <stop offset=".5" stopColor="#1468b8" />
          <stop offset="1" stopColor="#2f93dc" />
        </linearGradient>
        <linearGradient id="fsb-sea" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#1c78c4" />
          <stop offset="1" stopColor="#0b3f7e" />
        </linearGradient>
        <clipPath id="fsb-above">
          <rect x="0" y="0" width="1920" height={HORIZON} />
        </clipPath>
      </defs>
      <rect x="0" y="0" width="1920" height={HORIZON + 2} fill="url(#fsb-sky)" />
      {!dim && (
        <g transform="translate(1560 220) rotate(-8)">
          <Helicopter />
        </g>
      )}
      {CLOUDS.map(([x, y, s]) => (
        <path key={x} d={CLOUD} transform={`translate(${x} ${y}) scale(${s * 1.6})`} fill="#d6f1ff" stroke={INK} strokeWidth={4 / (s * 1.6)} opacity={dim ? 0.4 : 0.9} />
      ))}
      <circle cx={SUN_X} cy={HORIZON} r="170" fill="#e6f7ff" stroke={INK} strokeWidth="5" clipPath="url(#fsb-above)" />
      <circle cx={SUN_X} cy={HORIZON} r="120" fill="#ffffff" clipPath="url(#fsb-above)" opacity=".7" />
      <rect x="0" y={HORIZON} width="1920" height={BEACH - HORIZON} fill="url(#fsb-sea)" />
      <rect x="0" y={HORIZON - 2} width="1920" height="4" fill={INK} />
      {!dim && glint(GLINT_A, "fsb-shimmer-a")}
      {!dim && glint(GLINT_B, "fsb-shimmer-b")}
      {!dim && (
        <g fill="#ffffff">
          <path d={SPARK} transform="translate(1290 742)" />
          <path d={SPARK} transform="translate(1600 790) scale(.8)" />
        </g>
      )}
      {/* A speedboat cutting across the bay, its wake in white. */}
      {!dim && (
        <g transform="translate(1110 800)" stroke={INK} strokeWidth="4" strokeLinejoin="round">
          <path d="M-160 14 C -110 6 -60 4 -20 10" fill="none" stroke="#e6f7ff" strokeWidth="5" />
          <path d="M-20 0 L90 0 L70 18 L-10 18 Z" fill={NEON} />
          <path d="M10 0 L30 -16 L60 -16 L56 0 Z" fill="#d6f1ff" />
        </g>
      )}
      {HOTELS.map((h) => (
        <HotelArt key={h.x} h={h} />
      ))}
      <rect x="0" y={BEACH} width="1920" height="40" fill="#7cc4f0" stroke={INK} strokeWidth="4" />
      <rect x="0" y={BEACH + 40} width="1920" height={1080 - BEACH - 40} fill="#082650" />
      <rect x="0" y={BEACH + 40} width="1920" height="4" fill={NEON} />
      <rect x="0" y={BEACH + 36} width="1920" height="12" fill={NEON} opacity=".25" />
      <g fill={INK}>
        {PALMS.map((p, i) => (
          <g key={i}>
            <path d={p.trunk} />
            {p.fronds.map((f, j) => (
              <path key={j} d={f} />
            ))}
          </g>
        ))}
      </g>
      {dim && <rect x="0" y="0" width="1920" height="1080" fill="#092248" opacity=".5" />}
    </svg>
  );
}
