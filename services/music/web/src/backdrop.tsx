// «Каркас» backdrop: night sky, a striped synthwave sun and either the wave
// terrain of the Cineko startup intro («Волны») or the TV's wireframe
// mountains over a running neon floor («Сетка»), behind the translucent panels. Shown only in
// that design (designs.css; display: none elsewhere, so no cost). Each terrain
// row is drawn once and slides as its own compositor layer: no repaint per
// frame. The 1280×720 stage is scaled to cover the window.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

const W = 1280;
const H = 720;
const ACCENT = "#ff4fd8";
const BG = "#0d0420";

function terrainRows() {
  const N = 16, L = 200, k = (2 * Math.PI) / L;
  const geo = Array.from({ length: N }, (_, i) => {
    const t = i / (N - 1);
    return { t, y0: 430 + Math.pow(t, 1.8) * 300, s: 0.45 + t * 1.75, amp: 14 + 10 * Math.pow(Math.sin(i * 0.9), 2) };
  });
  return geo.map(({ t, y0, s, amp }, i) => {
    const half = W / 2 / s + L + 24;
    const p1 = i * 1.37, p2 = i * 0.61, p3 = i * 2.11;
    const pts: string[] = [];
    let lastX = -half;
    for (let x = -half; x <= half; x += 8) {
      const y = -amp * (0.55 * Math.sin(k * x + p1) + 0.3 * Math.sin(2 * k * x + p2) + 0.15 * Math.sin(3 * k * x + p3));
      pts.push(`${x.toFixed(1)} ${y.toFixed(1)}`);
      lastX = x;
    }
    const top = Math.floor(y0 - s * amp - 6);
    const next = geo[i + 1];
    const bottom = next ? Math.ceil(next.y0 + next.s * next.amp + 6) : H;
    const local = ((bottom - y0) / s + 10).toFixed(0);
    return {
      d: `M${pts.join(" L")} L${lastX.toFixed(1)} ${local} L${(-half).toFixed(1)} ${local} Z`,
      tf: `translate(${W / 2} ${(y0 - top).toFixed(1)}) scale(${s.toFixed(3)})`,
      top,
      height: bottom - top,
      width: W + Math.ceil((L + 30) * s),
      shift: (L * s).toFixed(2),
      sw: 1.1 + t * 1.6,
      op: 0.3 + 0.7 * t,
    };
  });
}

/** Deterministic stars. */
const STARS = (() => {
  let s = 11;
  const r = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  return Array.from({ length: 40 }, () => ({ x: Math.round(r() * W), y: Math.round(r() * 380), rad: r() < 0.2 ? 1.6 : 0.9, o: 0.3 + r() * 0.5 }));
})();

/** Sun stripes: gaps growing towards the horizon. */
const SUN = { cx: 900, cy: 330, r: 150 };
const SUN_GAPS = [0, 1, 2, 3, 4, 5].map((i) => ({ y: SUN.cy + 10 + i * 17 + i * i * 1.2, h: 2.5 + i * 1.8 }));

function useCover(w = W, h = H) {
  const get = () => Math.max(window.innerWidth / w, window.innerHeight / h);
  const [k, setK] = useState(get);
  useEffect(() => {
    const on = () => setK(get());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return k;
}

function WavesBackdrop() {
  const rows = useMemo(() => terrainRows(), []);
  const keyframes = useMemo(
    () => rows.map((r, i) => `@keyframes wb-drift-${i}{from{transform:translateX(0)}to{transform:translateX(-${r.shift}px)}}`).join(""),
    [rows],
  );
  const k = useCover();
  return (
    <>
      <style>{keyframes}</style>
      <div className="wb-stage" style={{ transform: `translateX(-50%) scale(${k})` }}>
        <svg className="wb-abs" viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
          <defs>
            <linearGradient id="wb-sky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={BG} />
              <stop offset=".6" stopColor="#24073f" />
              <stop offset="1" stopColor="#4c0f63" />
            </linearGradient>
            <linearGradient id="wb-sun" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#ffe66b" />
              <stop offset=".45" stopColor="#ff9a3d" />
              <stop offset="1" stopColor="#ff2fa8" />
            </linearGradient>
            <radialGradient id="wb-glow" cx=".5" cy=".5" r=".5">
              <stop offset="0" stopColor={ACCENT} stopOpacity=".45" />
              <stop offset="1" stopColor={ACCENT} stopOpacity="0" />
            </radialGradient>
            <mask id="wb-sun-mask">
              <rect x="0" y="0" width={W} height={H} fill="#fff" />
              {SUN_GAPS.map((g) => (
                <rect key={g.y} x="0" y={g.y} width={W} height={g.h} fill="#000" />
              ))}
            </mask>
          </defs>
          <rect x="0" y="0" width={W} height="470" fill="url(#wb-sky)" />
          {STARS.map((s, i) => (
            <circle key={i} cx={s.x} cy={s.y} r={s.rad} fill="#fff" opacity={s.o} />
          ))}
          <circle cx={SUN.cx} cy={SUN.cy} r={SUN.r * 1.6} fill="url(#wb-glow)" />
          <circle cx={SUN.cx} cy={SUN.cy} r={SUN.r} fill="url(#wb-sun)" mask="url(#wb-sun-mask)" />
        </svg>
        {rows.map((r, i) => (
          <div key={i} className="wb-row" style={{ top: r.top, height: r.height }}>
            <div className="wb-drift" style={{ width: r.width, height: r.height, animationName: `wb-drift-${i}` }}>
              <svg viewBox={`0 0 ${r.width} ${r.height}`} width={r.width} height={r.height}>
                <g transform={r.tf}>
                  <path d={r.d} fill={BG} stroke={ACCENT} strokeWidth={r.sw} strokeOpacity={r.op} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                </g>
              </svg>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- «Сетка» (the TV's Каркас background)

const GW = 1920;
const GH = 1080;
const HORIZON = 600;
/** Floor cross lines spaced by this ratio: scaling the layer by 1/R moves each line onto the next (seamless). */
const FLOOR_R = 0.78;
const FLOOR_H = GH - HORIZON;
const FLOOR_LINES = Array.from({ length: 22 }, (_, i) => 760 * Math.pow(FLOOR_R, i - 1)).filter((y) => y > 3);
const FLOOR_XS = Array.from({ length: 31 }, (_, i) => -3840 + i * 320);

function rand(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

function ridge(x0: number, x1: number, peak: number, seed: number) {
  const r = rand(seed);
  const pts: [number, number][] = [[x0, HORIZON]];
  const n = 7;
  for (let i = 1; i < n; i++) {
    const x = x0 + ((x1 - x0) * i) / n + (r() - 0.5) * 40;
    const up = i % 2 === 1 ? peak * (0.55 + r() * 0.45) : peak * (0.15 + r() * 0.3);
    pts.push([Math.round(x), Math.round(HORIZON - up)]);
  }
  pts.push([x1, HORIZON]);
  const wires: [number, number, number, number][] = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i]!;
    const mid = (pts[i - 1]![0] + x) / 2;
    const mid2 = (x + pts[i + 1]![0]) / 2;
    wires.push([x, y, mid, HORIZON], [x, y, mid2, HORIZON], [x, y, x, HORIZON]);
  }
  return { poly: pts.map((p) => p.join(",")).join(" "), wires };
}

const RIDGES = [ridge(-40, 760, 230, 3), ridge(1460, 1960, 190, 11), ridge(620, 1180, 110, 5)];
const G_STARS = (() => {
  const r = rand(7);
  return Array.from({ length: 46 }, () => ({ x: Math.round(r() * GW), y: Math.round(r() * (HORIZON - 120)), s: r() < 0.2 ? 2.2 : 1.3, o: 0.35 + r() * 0.5 }));
})();
const G_SUN_GAPS = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ y: 470 + i * 21 + i * i * 1.5, h: 3 + i * 2.2 }));

function GridBackdrop() {
  const k = useCover(GW, GH);
  return (
    <div className="wb-stage wb-grid" style={{ transform: `translateX(-50%) scale(${k})` }}>
      <svg className="wb-abs" viewBox={`0 0 ${GW} ${GH}`} width={GW} height={GH}>
        <defs>
          <linearGradient id="wg-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={BG} />
            <stop offset=".62" stopColor="#24073f" />
            <stop offset="1" stopColor="#4c0f63" />
          </linearGradient>
          <linearGradient id="wg-sun" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffe66b" />
            <stop offset=".45" stopColor="#ff9a3d" />
            <stop offset="1" stopColor="#ff2fa8" />
          </linearGradient>
          <radialGradient id="wg-glow" cx=".5" cy=".5" r=".5">
            <stop offset="0" stopColor={ACCENT} stopOpacity=".45" />
            <stop offset="1" stopColor={ACCENT} stopOpacity="0" />
          </radialGradient>
          <mask id="wg-sun-mask">
            <rect x="0" y="0" width={GW} height={GH} fill="#fff" />
            {G_SUN_GAPS.map((g) => (
              <rect key={g.y} x="0" y={g.y} width={GW} height={g.h} fill="#000" />
            ))}
          </mask>
        </defs>
        <rect x="0" y="0" width={GW} height={HORIZON} fill="url(#wg-sky)" />
        {G_STARS.map((s, i) => (
          <circle key={i} cx={s.x} cy={s.y} r={s.s} fill="#fff" opacity={s.o} />
        ))}
        <circle cx="1380" cy="440" r="330" fill="url(#wg-glow)" />
        <circle cx="1380" cy="440" r="210" fill="url(#wg-sun)" mask="url(#wg-sun-mask)" />
        {RIDGES.map((r, i) => (
          <g key={i} opacity={i === 2 ? 0.75 : 1}>
            <polygon points={r.poly} fill="#14062c" stroke="#3ce8ff" strokeWidth="2" strokeLinejoin="round" />
            {r.wires.map(([x1, y1, x2, y2], j) => (
              <line key={j} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#3ce8ff" strokeOpacity=".38" strokeWidth="1.2" />
            ))}
          </g>
        ))}
        <rect x="0" y={HORIZON - 3} width={GW} height="6" fill={ACCENT} />
        <rect x="0" y={HORIZON} width={GW} height={FLOOR_H} fill={BG} />
      </svg>
      <div className="wg-floor" style={{ top: HORIZON, height: FLOOR_H }}>
        <svg className="wb-abs" width={GW} height={FLOOR_H} viewBox={`0 0 ${GW} ${FLOOR_H}`}>
          {FLOOR_XS.map((x) => (
            <line key={x} x1={GW / 2} y1="0" x2={x} y2={FLOOR_H} stroke={ACCENT} strokeOpacity=".7" strokeWidth="2" />
          ))}
        </svg>
        <div className="wg-lines">
          <svg width={GW} height="800" viewBox={`0 0 ${GW} 800`} preserveAspectRatio="none">
            {FLOOR_LINES.map((y) => (
              <rect key={y} x="0" y={y} width={GW} height={1.4 + y * 0.006} fill={ACCENT} opacity=".8" />
            ))}
          </svg>
        </div>
        <div className="wg-fade" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- choice

export type WireBg = "waves" | "grid";
const BG_KEY = "mm.wire_bg";
const bgListeners = new Set<() => void>();

export function wireBg(): WireBg {
  try {
    return localStorage.getItem(BG_KEY) === "grid" ? "grid" : "waves";
  } catch {
    return "waves";
  }
}

export function setWireBg(v: WireBg) {
  try {
    localStorage.setItem(BG_KEY, v);
  } catch {
    /* private mode */
  }
  bgListeners.forEach((l) => l());
}

export function useWireBg(): WireBg {
  return useSyncExternalStore(
    (l) => {
      bgListeners.add(l);
      return () => void bgListeners.delete(l);
    },
    wireBg,
  );
}

export function WireBackdrop() {
  const bg = useWireBg();
  return (
    <div className="wire-bg" data-bg={bg} aria-hidden="true">
      {bg === "grid" ? <GridBackdrop /> : <WavesBackdrop />}
    </div>
  );
}

// ---------------------------------------------------------------- «Пульсар» (Joy Division mood)

/**
 * A stacked ridge plot drawn from our own pseudo-random "signal": a quiet
 * baseline with a burst of peaks in the middle, each line filled black so it
 * hides the ones behind it. Static (painted once).
 */
function pulsarLines(n: number, w: number, gap: number, seed: number) {
  const r = rand(seed);
  const lines: string[] = [];
  const steps = 90;
  for (let i = 0; i < n; i++) {
    const peaks = Array.from({ length: 3 + Math.floor(r() * 4) }, () => ({ c: 0.38 + r() * 0.24, s: 0.012 + r() * 0.03, h: 8 + r() * 46 }));
    const base = (i + 1) * gap;
    const pts: string[] = [];
    for (let j = 0; j <= steps; j++) {
      const t = j / steps;
      // Fades out towards the sides; small noise everywhere.
      const env = Math.exp(-Math.pow((t - 0.5) / 0.16, 2));
      let y = (r() - 0.5) * 2.2;
      for (const p of peaks) y += p.h * Math.exp(-Math.pow((t - p.c) / p.s, 2)) * env;
      y += env * r() * 6;
      pts.push(`${(t * w).toFixed(1)} ${(base - y).toFixed(1)}`);
    }
    lines.push(`M${pts.join(" L")} L${w} ${base + gap * 3} L0 ${base + gap * 3} Z`);
  }
  return lines;
}

function PulsarPlot({ n, w, gap, seed, stroke, className }: { n: number; w: number; gap: number; seed: number; stroke: number; className?: string }) {
  const lines = useMemo(() => pulsarLines(n, w, gap, seed), [n, w, gap, seed]);
  const h = (n + 2) * gap;
  return (
    <svg className={className} viewBox={`0 -${gap * 2} ${w} ${h + gap * 2}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {lines.map((d, i) => (
        <path key={i} d={d} fill="#000" stroke="#f2efe6" strokeWidth={stroke} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

/** Behind the panels: the full-window plot is a static file (public/pulsar.svg, CSS background). */
export function PulsarBackdrop() {
  return <div className="pulsar-bg" aria-hidden="true" />;
}

/** Small artwork for cards (Моя волна). */
export function PulsarArt() {
  return <PulsarPlot n={22} w={160} gap={7} seed={42} stroke={1.1} className="pulsar-art" />;
}
