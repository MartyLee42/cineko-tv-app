// Pure geometry behind the designs' scenery, shared by the TV looks (apps/tv/src/design/looks)
// and the PWA's scenes (apps/web/src/decor). Deterministic: the same seed always draws the same
// picture, so nothing jumps between renders. Coordinates are SVG user units.

/** Deterministic pseudo-random numbers in (0, 1) (Park–Miller). */
export function rand(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export type Segment = [number, number, number, number];

/**
 * «Каркас»: a ridge of wireframe mountains standing on `horizon` between x0 and x1 (peaks up to
 * `peak` above it): the outline as polygon points and the wire mesh (each peak to the horizon
 * midpoints around it and straight down).
 */
export function wireRidge(x0: number, x1: number, peak: number, seed: number, horizon = 600): { poly: string; wires: Segment[] } {
  const r = rand(seed);
  const pts: [number, number][] = [[x0, horizon]];
  const n = 7;
  for (let i = 1; i < n; i++) {
    const x = x0 + ((x1 - x0) * i) / n + (r() - 0.5) * 40;
    const up = i % 2 === 1 ? peak * (0.55 + r() * 0.45) : peak * (0.15 + r() * 0.3);
    pts.push([Math.round(x), Math.round(horizon - up)]);
  }
  pts.push([x1, horizon]);
  const wires: Segment[] = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i]!;
    const mid = (pts[i - 1]![0] + x) / 2;
    const mid2 = (x + pts[i + 1]![0]) / 2;
    wires.push([x, y, mid, horizon], [x, y, mid2, horizon], [x, y, x, horizon]);
  }
  return { poly: pts.map((p) => p.join(",")).join(" "), wires };
}

export interface Star {
  x: number;
  y: number;
  r: number;
  o: number;
}

/** `n` stars in a w×h sky: about a fifth of them bigger, each with its own brightness. */
export function starField(n: number, seed: number, w: number, h: number): Star[] {
  const r = rand(seed);
  return Array.from({ length: n }, () => ({ x: Math.round(r() * w), y: Math.round(r() * h), r: r() < 0.2 ? 2.2 : 1.3, o: +(0.35 + r() * 0.5).toFixed(2) }));
}

/** The dark gaps cut through a synthwave sun's lower half: wider and further apart towards the horizon. */
export function sunGaps(count: number, top: number, step: number, grow: number, h0: number, hGrow: number): { y: number; h: number }[] {
  return Array.from({ length: count }, (_, i) => ({ y: +(top + i * step + i * i * grow).toFixed(1), h: +(h0 + i * hGrow).toFixed(1) }));
}

/** A comic starburst: `n` spikes alternating between r1 (inner) and r2 (outer), slightly irregular, a bit wider than tall. */
export function burstPoints(cx: number, cy: number, r1: number, r2: number, n = 14, seed = 5): string {
  const r = rand(seed);
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
    const rad = i % 2 ? r1 * (0.92 + r() * 0.12) : r2 * (0.86 + r() * 0.2);
    pts.push(`${(cx + Math.cos(a) * rad * 1.18).toFixed(1)},${(cy + Math.sin(a) * rad).toFixed(1)}`);
  }
  return pts.join(" ");
}

/** A five-point star path around (0, 0). */
export function starPath(r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const k = i % 2 ? r * 0.45 : r;
    pts.push(`${(Math.cos(a) * k).toFixed(1)},${(Math.sin(a) * k).toFixed(1)}`);
  }
  return `M${pts.join("L")}Z`;
}

/** A wavy hill silhouette from x=0 to `width` over `base` (sum of [amplitude, wavelength, phase] sines), closed at `bottom`. */
export function hillPath(base: number, waves: [number, number, number][], width = 1920, bottom = 1080, step = 40): string {
  let d = `M0 ${bottom} L0 ${base}`;
  for (let x = 0; x <= width; x += step) {
    let y = base;
    for (const [amp, len, ph] of waves) y += amp * Math.sin((x / len) * Math.PI * 2 + ph);
    d += ` L${x} ${y.toFixed(1)}`;
  }
  return `${d} L${width} ${bottom} Z`;
}

/** Rain streaks: [x, y, length, opacity], thin and faint. */
export function rainStreaks(n: number, seed: number, w: number, h: number): [number, number, number, number][] {
  const r = rand(seed);
  const out: [number, number, number, number][] = [];
  for (let i = 0; i < n; i++) out.push([Math.round(r() * w), Math.round(r() * h), Math.round(40 + r() * 90), +(0.05 + r() * 0.11).toFixed(3)]);
  return out;
}

export interface Building {
  x: number;
  w: number;
  h: number;
  win: { x: number; y: number; c: string }[];
}

/** «Киберпанк»: a skyline of blocks along the bottom of a width×height scene, with lit windows in three neon colours. */
export function skyline(seed: number, width = 1920, height = 1080, palette: [string, string, string] = ["#00f0ff", "#ff2e88", "#f5f03c"]): Building[] {
  const r = rand(seed);
  const out: Building[] = [];
  let x = 0;
  while (x < width) {
    const w = 50 + Math.round(r() * 90);
    const h = 90 + Math.round(r() * 260);
    const win: Building["win"] = [];
    for (let k = 0; k < 6; k++) if (r() < 0.8) win.push({ x: x + 8 + Math.round(r() * (w - 20)), y: height - h + 14 + Math.round(r() * (h - 30)), c: r() < 0.5 ? palette[0] : r() < 0.6 ? palette[1] : palette[2] });
    out.push({ x, w, h, win });
    x += w + 4 + Math.round(r() * 10);
  }
  return out;
}

/** «Каркас» floor: horizontal lines below the horizon at geometric spacing (ratio `k`), so scaling by 1/k lands each on the next. */
export function floorLines(first: number, k: number, count: number, min = 3): number[] {
  return Array.from({ length: count }, (_, i) => first * Math.pow(k, i - 1)).filter((y) => y > min);
}

export interface Frame {
  l: number;
  r: number;
  t: number;
  b: number;
}

/** «Одиссея»: the corridor's rib frames around a vanishing point, one per depth (scale of the outermost half-size), near → far. */
export function corridorFrames(vp: { x: number; y: number }, half: { w: number; h: number }, depths: number[]): Frame[] {
  return depths.map((s) => ({ l: vp.x - half.w * s, r: vp.x + half.w * s, t: vp.y - half.h * s, b: vp.y + half.h * s }));
}

/** «Пять звёзд»: a palm silhouette — a tapered, slightly bent trunk and drooping fronds (filled paths). */
export interface Palm {
  trunk: string;
  fronds: string[];
}

/** A palm rooted at (x, base), `h` tall, its crown `lean` px to the side. */
export function palm(x: number, base: number, h: number, lean: number): Palm {
  const tx = x + lean;
  const ty = base - h;
  const r = (n: number) => Math.round(n * 10) / 10;
  const trunk = `M${r(x - h * 0.026)} ${base} Q${r(x + lean * 0.3 - h * 0.022)} ${r(base - h * 0.55)} ${r(tx - h * 0.011)} ${r(ty)} L${r(tx + h * 0.011)} ${r(ty)} Q${r(x + lean * 0.3 + h * 0.022)} ${r(base - h * 0.55)} ${r(x + h * 0.026)} ${base} Z`;
  const L = h * 0.42;
  // Directions in degrees (0 = right, negative = up); each frond droops towards its tip.
  const fronds = [-168, -140, -112, -84, -58, -30, -4, 196].map((deg) => {
    const a = (deg * Math.PI) / 180;
    const len = L * (0.8 + 0.2 * Math.abs(Math.cos(a)));
    const droop = len * 0.42 * Math.abs(Math.cos(a)) + len * 0.12;
    const ex = tx + Math.cos(a) * len;
    const ey = ty + Math.sin(a) * len * 0.55 + droop;
    const mx = tx + Math.cos(a) * len * 0.55;
    const my = ty + Math.sin(a) * len * 0.5 - len * 0.12;
    const w = len * 0.1;
    return `M${r(tx)} ${r(ty)} Q${r(mx)} ${r(my - w)} ${r(ex)} ${r(ey)} Q${r(mx)} ${r(my + w)} ${r(tx)} ${r(ty)} Z`;
  });
  return { trunk, fronds };
}

/** «Пять звёзд»: a row of towers standing on `base` between x0 and x1, a few lit windows each, some with an antenna. */
export interface Tower {
  x: number;
  w: number;
  h: number;
  antenna: boolean;
  win: { x: number; y: number; c: number }[];
}

export function towers(seed: number, x0: number, x1: number, base: number, minH: number, maxH: number, lit = 7): Tower[] {
  const r = rand(seed);
  const out: Tower[] = [];
  let x = x0;
  while (x < x1) {
    const w = 44 + Math.round(r() * 86);
    const h = minH + Math.round(r() * (maxH - minH));
    const win: Tower["win"] = [];
    // Windows on a 14 × 22 grid, so lit ones line up like floors.
    const cols = Math.max(1, Math.floor((w - 12) / 14));
    const rows = Math.max(1, Math.floor((h - 24) / 22));
    for (let k = 0; k < lit; k++) if (r() < 0.85) win.push({ x: x + 8 + Math.floor(r() * cols) * 14, y: base - h + 14 + Math.floor(r() * rows) * 22, c: Math.floor(r() * 3) });
    out.push({ x, w, h, antenna: h > minH + (maxH - minH) * 0.7 && r() < 0.6, win });
    x += w + 2 + Math.round(r() * 8);
  }
  return out;
}
