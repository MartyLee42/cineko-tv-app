// «Одиссея»: a white spaceship corridor in one-point perspective (an original drawing, mood only):
// symmetric wall panels and ribs, lit ceiling panels, a grey floor with a centre line, a black
// door at the far end. Static (one SVG, painted once).
import "./odyssey.css";
import { corridorFrames, type Frame } from "@martytv/ui/decor";
import type { Look } from "./types";
import { layer } from "./common";

/** The vanishing point and the corridor's outermost frame (half-sizes, larger than the screen). */
const VP = { x: 960, y: 500 };
const HALF = { w: 1300, h: 760 };
/** Depths of the ribs (scale of each frame), near → far. */
const DEPTHS = [1, 0.74, 0.55, 0.41, 0.305, 0.228, 0.17, 0.127];

const FRAMES = corridorFrames(VP, HALF, DEPTHS);
const FAR = FRAMES[FRAMES.length - 1]!;

const pts = (p: [number, number][]) => p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

/** One corridor segment between two ribs: ceiling, floor, two walls, a ceiling light, wall panels. */
function Segment({ a, b, i }: { a: Frame; b: Frame; i: number }) {
  const wall = i % 2 ? "#dfe4e9" : "#e8ecf0";
  // Inset of the light / panels inside the segment (fractions along each edge).
  const lerp = (p: number, q: number, k: number) => p + (q - p) * k;
  const light: [number, number][] = [
    [lerp(a.l, a.r, 0.36), a.t],
    [lerp(a.l, a.r, 0.64), a.t],
    [lerp(b.l, b.r, 0.64), b.t],
    [lerp(b.l, b.r, 0.36), b.t],
  ];
  // A recessed wall panel on each side (inset 18% along depth, 22% top/bottom).
  const panel = (x1: number, x2: number, y1t: number, y1b: number, y2t: number, y2b: number): [number, number][] => {
    const xa = lerp(x1, x2, 0.16), xb = lerp(x1, x2, 0.84);
    const ta = lerp(y1t, y2t, 0.16), tb = lerp(y1t, y2t, 0.84), ba = lerp(y1b, y2b, 0.16), bb = lerp(y1b, y2b, 0.84);
    return [
      [xa, lerp(ta, ba, 0.2)],
      [xb, lerp(tb, bb, 0.2)],
      [xb, lerp(tb, bb, 0.8)],
      [xa, lerp(ta, ba, 0.8)],
    ];
  };
  return (
    <g>
      <polygon points={pts([[a.l, a.t], [a.r, a.t], [b.r, b.t], [b.l, b.t]])} fill="#f3f5f7" />
      <polygon points={pts([[a.l, a.b], [a.r, a.b], [b.r, b.b], [b.l, b.b]])} fill={i % 2 ? "#c9d0d8" : "#d2d8df"} />
      <polygon points={pts([[a.l, a.t], [b.l, b.t], [b.l, b.b], [a.l, a.b]])} fill={wall} />
      <polygon points={pts([[a.r, a.t], [b.r, b.t], [b.r, b.b], [a.r, a.b]])} fill={wall} />
      <polygon points={pts(panel(a.l, b.l, a.t, a.b, b.t, b.b))} fill="none" stroke="#c3cad3" strokeWidth={Math.max(1, 2.4 * (a.r - a.l) / (2 * HALF.w))} />
      <polygon points={pts(panel(a.r, b.r, a.t, a.b, b.t, b.b))} fill="none" stroke="#c3cad3" strokeWidth={Math.max(1, 2.4 * (a.r - a.l) / (2 * HALF.w))} />
      <polygon points={pts(light)} fill="#ffffff" />
    </g>
  );
}

function Corridor({ dim }: { dim: boolean }) {
  return (
    <svg className="absolute left-0 top-0" width="1920" height="1080" viewBox="0 0 1920 1080" aria-hidden>
      <defs>
        <radialGradient id="od-glow" cx={VP.x} cy={VP.y - 120} r="900" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity=".55" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>
      {FRAMES.slice(0, -1).map((a, i) => (
        <Segment key={i} a={a} b={FRAMES[i + 1]!} i={i} />
      ))}
      <rect width="1920" height="1080" fill="url(#od-glow)" />
      {/* The far end: a black door (the slab's echo) in a white surround. */}
      <rect x={FAR.l} y={FAR.t} width={FAR.r - FAR.l} height={FAR.b - FAR.t} fill="#eef1f4" />
      <rect x={VP.x - 34} y={FAR.t + 14} width="68" height={FAR.b - FAR.t - 14} fill="#101318" />
      {/* Ribs: the frame edges, thicker near. */}
      {FRAMES.map((f, i) => (
        <rect key={i} x={f.l} y={f.t} width={f.r - f.l} height={f.b - f.t} fill="none" stroke="#b4bcc6" strokeWidth={Math.max(1, 5 * DEPTHS[i]!)} />
      ))}
      {/* The floor's centre line. */}
      <polygon points={pts([[VP.x - 5, 1080], [VP.x + 5, 1080], [VP.x + 0.6, FAR.b], [VP.x - 0.6, FAR.b]])} fill="#aab3be" />
      {dim && <rect width="1920" height="1080" fill="#eef1f4" opacity=".35" />}
    </svg>
  );
}

function CorridorBackground({ dim }: { dim: boolean }) {
  return (
    <div data-skin-bg="corridor" className={`od-corridor ${layer}`}>
      <Corridor dim={dim} />
      {/* Calms the left text column (titles, empty and error states) over the corridor's centre. */}
      <div className="od-veil absolute left-0 top-0 h-full w-full" />
    </div>
  );
}

export const look: Look = { Background: ({ dim }) => <CorridorBackground dim={dim} /> };
