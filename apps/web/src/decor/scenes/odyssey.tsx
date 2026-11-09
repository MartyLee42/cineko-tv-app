// «Одиссея»: the TV's white spaceship corridor in one-point perspective — ribs, lit ceiling
// panels, a grey floor with a centre line, a black door at the far end. Static; centred, so it
// crops well on any window. A station-white veil keeps the page's ink readable over it.
import { corridorFrames, type Frame } from "@martytv/ui/decor";
import type { WebLook } from "../look";
import "./odyssey.css";

const VP = { x: 960, y: 500 };
const DEPTHS = [1, 0.74, 0.55, 0.41, 0.305, 0.228, 0.17, 0.127];
const FRAMES = corridorFrames(VP, { w: 1300, h: 760 }, DEPTHS);
const FAR = FRAMES[FRAMES.length - 1]!;

const pts = (p: [number, number][]) => p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
const lerp = (p: number, q: number, k: number) => p + (q - p) * k;

function Segment({ a, b, i }: { a: Frame; b: Frame; i: number }) {
  const wall = i % 2 ? "#dfe4e9" : "#e8ecf0";
  const light: [number, number][] = [
    [lerp(a.l, a.r, 0.36), a.t],
    [lerp(a.l, a.r, 0.64), a.t],
    [lerp(b.l, b.r, 0.64), b.t],
    [lerp(b.l, b.r, 0.36), b.t],
  ];
  return (
    <g>
      <polygon points={pts([[a.l, a.t], [a.r, a.t], [b.r, b.t], [b.l, b.t]])} fill="#f3f5f7" />
      <polygon points={pts([[a.l, a.b], [a.r, a.b], [b.r, b.b], [b.l, b.b]])} fill={i % 2 ? "#c9d0d8" : "#d2d8df"} />
      <polygon points={pts([[a.l, a.t], [b.l, b.t], [b.l, b.b], [a.l, a.b]])} fill={wall} />
      <polygon points={pts([[a.r, a.t], [b.r, b.t], [b.r, b.b], [a.r, a.b]])} fill={wall} />
      <polygon points={pts(light)} fill="#ffffff" />
    </g>
  );
}

function Scene() {
  return (
    <div className="od-scene wd-fill">
      <svg className="wd-fill" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice">
        {FRAMES.slice(0, -1).map((a, i) => (
          <Segment key={i} a={a} b={FRAMES[i + 1]!} i={i} />
        ))}
        <rect x={FAR.l} y={FAR.t} width={FAR.r - FAR.l} height={FAR.b - FAR.t} fill="#eef1f4" />
        <rect x={VP.x - 34} y={FAR.t + 14} width="68" height={FAR.b - FAR.t - 14} fill="#101318" />
        {FRAMES.map((f, i) => (
          <rect key={i} x={f.l} y={f.t} width={f.r - f.l} height={f.b - f.t} fill="none" stroke="#b4bcc6" strokeWidth={Math.max(1, 5 * DEPTHS[i]!)} />
        ))}
        <polygon points={pts([[VP.x - 5, 1080], [VP.x + 5, 1080], [VP.x + 0.6, FAR.b], [VP.x - 0.6, FAR.b]])} fill="#aab3be" />
      </svg>
      <div className="od-veil wd-fill" />
    </div>
  );
}

export const look: WebLook = { Scene };
