// Costume artwork drawn over Cineko's sticker (SVG, 0..120 box, static).
// Placement comes from costumePlan (mascotCostume.ts).
import type { CostumePlan, Pt } from "./mascotCostume";

const deg = (a: Pt, b: Pt) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

/** «Матрица»: small black oval lenses with a green glint. */
function Sunglasses({ eyes: [l, r] }: { eyes: [Pt, Pt] }) {
  const d = dist(l, r);
  const c = mid(l, r);
  const rx = d * 0.4;
  const ry = d * 0.27;
  return (
    <g transform={`translate(${c.x} ${c.y}) rotate(${deg(l, r)})`} data-costume="sunglasses">
      <path d={`M ${-d / 2 + rx * 0.9} ${-ry * 0.35} Q 0 ${-ry * 0.9} ${d / 2 - rx * 0.9} ${-ry * 0.35}`} fill="none" stroke="#0a0f0a" strokeWidth={d * 0.07} />
      <line x1={-d / 2 - rx} y1={-ry * 0.2} x2={-d / 2 - rx - d * 0.25} y2={-ry * 0.5} stroke="#0a0f0a" strokeWidth={d * 0.06} />
      <line x1={d / 2 + rx} y1={-ry * 0.2} x2={d / 2 + rx + d * 0.25} y2={-ry * 0.5} stroke="#0a0f0a" strokeWidth={d * 0.06} />
      {[-d / 2, d / 2].map((x) => (
        <g key={x}>
          <ellipse cx={x} cy={0} rx={rx} ry={ry} fill="#030603" stroke="#00ff41" strokeOpacity=".55" strokeWidth={d * 0.025} />
          <path d={`M ${x - rx * 0.55} ${-ry * 0.35} L ${x - rx * 0.1} ${-ry * 0.62}`} stroke="#00ff41" strokeWidth={d * 0.05} strokeLinecap="round" opacity=".9" />
        </g>
      ))}
    </g>
  );
}

/** «Пять звёзд»: gold-framed teardrop aviators, the lenses reflecting a sunset (pink → orange), a double bridge. */
function Aviators({ eyes: [l, r] }: { eyes: [Pt, Pt] }) {
  const d = dist(l, r);
  const c = mid(l, r);
  const w = d * 0.46;
  const h = d * 0.42;
  // One teardrop lens centred on (x, 0): flat-ish top, deep rounded bottom drooping to the outside.
  const lens = (x: number, out: number) =>
    `M ${x - w} ${-h * 0.45} Q ${x} ${-h * 0.62} ${x + w} ${-h * 0.45} Q ${x + w * (1 + 0.15 * out)} ${h * 0.55} ${x + w * 0.25 * out} ${h * 0.75} Q ${x - w * 0.9} ${h * 0.7} ${x - w} ${-h * 0.45} Z`;
  return (
    <g transform={`translate(${c.x} ${c.y}) rotate(${deg(l, r)})`} data-costume="aviators">
      <defs>
        <linearGradient id="mt-aviator" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#3a1250" />
          <stop offset=".45" stopColor="#ff3d8b" />
          <stop offset="1" stopColor="#ffb840" />
        </linearGradient>
      </defs>
      <path d={`M ${-d / 2 + w * 0.9} ${-h * 0.5} Q 0 ${-h * 0.75} ${d / 2 - w * 0.9} ${-h * 0.5}`} fill="none" stroke="#e8b84a" strokeWidth={d * 0.05} />
      <path d={`M ${-d / 2 + w * 0.95} ${-h * 0.22} Q 0 ${-h * 0.36} ${d / 2 - w * 0.95} ${-h * 0.22}`} fill="none" stroke="#e8b84a" strokeWidth={d * 0.035} />
      <line x1={-d / 2 - w} y1={-h * 0.42} x2={-d / 2 - w - d * 0.28} y2={-h * 0.62} stroke="#e8b84a" strokeWidth={d * 0.045} strokeLinecap="round" />
      <line x1={d / 2 + w} y1={-h * 0.42} x2={d / 2 + w + d * 0.28} y2={-h * 0.62} stroke="#e8b84a" strokeWidth={d * 0.045} strokeLinecap="round" />
      {[-1, 1].map((side) => {
        const x = (side * d) / 2;
        return (
          <g key={side}>
            <path d={lens(x, side)} fill="url(#mt-aviator)" stroke="#e8b84a" strokeWidth={d * 0.04} strokeLinejoin="round" />
            <path d={`M ${x - w * 0.6} ${-h * 0.18} L ${x - w * 0.1} ${-h * 0.36}`} stroke="#fff5ec" strokeWidth={d * 0.045} strokeLinecap="round" opacity=".85" />
          </g>
        );
      })}
    </g>
  );
}

/** «Киберпанк»: a translucent cyan→magenta visor across the eyes. */
function Visor({ eyes: [l, r] }: { eyes: [Pt, Pt] }) {
  const d = dist(l, r);
  const c = mid(l, r);
  const w = d * 2.1;
  const h = d * 0.56;
  return (
    <g transform={`translate(${c.x} ${c.y}) rotate(${deg(l, r)})`} data-costume="visor">
      <defs>
        <linearGradient id="mt-visor" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#00f0ff" />
          <stop offset="1" stopColor="#ff2e88" />
        </linearGradient>
      </defs>
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={h * 0.45} fill="url(#mt-visor)" opacity=".72" stroke="#00f0ff" strokeWidth={d * 0.04} />
      <line x1={-w / 2 + h * 0.5} y1={-h * 0.22} x2={w / 2 - h * 0.9} y2={-h * 0.22} stroke="#ffffff" strokeOpacity=".7" strokeWidth={d * 0.04} strokeLinecap="round" />
    </g>
  );
}

/** «Ар-деко»: a black top hat with a gold band, a little tilted. */
function TopHat({ head }: { head: Pt }) {
  return (
    <g transform={`translate(${head.x} ${head.y + 4}) rotate(-8)`} data-costume="tophat">
      <ellipse cx="0" cy="0" rx="23" ry="5" fill="#0b0a08" stroke="#c9a54c" strokeWidth="1.2" />
      <path d="M -14 0 L -12 -28 Q 0 -32 12 -28 L 14 0 Z" fill="#0b0a08" stroke="#2a2418" strokeWidth="1" />
      <path d="M -13.6 -5 L 13.6 -5 L 13.2 -10 L -13.2 -10 Z" fill="#c9a54c" />
      <path d="M -9 -26 Q -2 -29 4 -27" fill="none" stroke="#e8cf8a" strokeOpacity=".5" strokeWidth="1" />
    </g>
  );
}

// «Ретро 90-е»: an 8×8 pixel cat (navy, yellow eyes) on a bevelled grey badge.
const PIXEL_CAT = [".X....X.", ".XX..XX.", ".XXXXXX.", ".XoXXoX.", ".XXXXXX.", "..XXXX..", ".XXXXXX.", "XXXXXXXX"];

function PixelCat() {
  const px = 3;
  const x0 = 91;
  const y0 = 89;
  const cells: { x: number; y: number; c: string }[] = [];
  PIXEL_CAT.forEach((row, j) =>
    [...row].forEach((ch, i) => {
      if (ch !== ".") cells.push({ x: x0 + 3 + i * px, y: y0 + 3 + j * px, c: ch === "o" ? "#ffff00" : "#000080" });
    }),
  );
  return (
    <g data-costume="pixelcat" shapeRendering="crispEdges">
      <rect x={x0} y={y0} width="30" height="30" fill="#c0c0c0" />
      <path d={`M ${x0} ${y0 + 30} V ${y0} H ${x0 + 30}`} fill="none" stroke="#ffffff" strokeWidth="2" />
      <path d={`M ${x0} ${y0 + 30} H ${x0 + 30} V ${y0}`} fill="none" stroke="#404040" strokeWidth="2" />
      {cells.map((p) => (
        <rect key={`${p.x}-${p.y}`} x={p.x} y={p.y} width={px} height={px} fill={p.c} />
      ))}
    </g>
  );
}

/** «Поп-арт»: a white speech bubble with a black ink outline. */
function Bubble({ text }: { text: string }) {
  return (
    <g data-costume="bubble">
      <path d="M 80 30 L 76 40 L 89 31 Z" fill="#ffffff" stroke="#000" strokeWidth="2.5" strokeLinejoin="round" />
      <ellipse cx="98" cy="18" rx="22" ry="14" fill="#ffffff" stroke="#000" strokeWidth="2.5" />
      <path d="M 82 30 L 79 36 L 88 30 Z" fill="#ffffff" />
      <text x="98" y="22.5" textAnchor="middle" fontSize="12" fontWeight="900" fill="#ff2d3c" stroke="#000" strokeWidth=".6" style={{ fontFamily: "var(--mt-font-display)" }}>
        {text}
      </text>
    </g>
  );
}

export function CostumeArt({ plan, bubble }: { plan: CostumePlan; bubble: string }) {
  let art = null;
  if (plan.costume === "sunglasses" && plan.eyes) art = <Sunglasses eyes={plan.eyes} />;
  else if (plan.costume === "visor" && plan.eyes) art = <Visor eyes={plan.eyes} />;
  else if (plan.costume === "aviators" && plan.eyes) art = <Aviators eyes={plan.eyes} />;
  else if (plan.costume === "tophat" && plan.head) art = <TopHat head={plan.head} />;
  else if (plan.costume === "pixelcat") art = <PixelCat />;
  else if (plan.costume === "bubble") art = <Bubble text={bubble} />;
  if (!art) return null;
  return (
    <svg viewBox="0 0 120 120" className="pointer-events-none absolute left-0 top-0 h-full w-full overflow-visible" aria-hidden>
      {art}
    </svg>
  );
}
