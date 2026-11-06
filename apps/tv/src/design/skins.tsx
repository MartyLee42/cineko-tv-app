// Skin elements of the later designs, drawn on a shared skeleton: the
// full-screen background layer, Home hero edges, the Details title plate
// (Ар-деко's marquee) and the design preview tiles. Everything else a skin
// changes is CSS under html.design-<id> (index.css). Backgrounds are static
// SVG/gradients; Каркас adds one transform-only animated layer (the floor),
// stopped in the calm mode.
import { useSyncExternalStore, type ReactNode } from "react";
import { DESIGN_SWATCH, DESIGNS, useI18n, type DesignSetting } from "@martytv/ui";
import { storage } from "../platform";
import { useSkin } from "./context";
import { FLOOR_R, skinOf } from "./registry";

// ================================================================ calm mode

const CALM_KEY = "martytv.calm_motion";
const calmListeners = new Set<() => void>();

function reducedMotion(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** This TV's background-motion choice (device-local; default moving unless the OS asks for less motion). */
export const calmMotion = {
  get(): boolean {
    const v = storage.get(CALM_KEY);
    return v === "1" ? true : v === "0" ? false : reducedMotion();
  },
  set(v: boolean) {
    storage.set(CALM_KEY, v ? "1" : "0");
    calmListeners.forEach((l) => l());
  },
};

export function useCalmMotion(): boolean {
  return useSyncExternalStore(
    (l) => {
      calmListeners.add(l);
      return () => void calmListeners.delete(l);
    },
    () => calmMotion.get(),
  );
}

// ================================================================ background

/**
 * The applied skin's background (null for the original three). Put it first
 * in a full-screen container. `dim` (Settings, guide): no sun, a darker veil
 * for long text.
 */
export function SkinBackground({ dim = false }: { dim?: boolean }) {
  const skin = skinOf(useSkin());
  const calm = useCalmMotion();
  let bg: ReactNode = null;
  if (skin.background === "synthwave") bg = <SynthwaveBackground calm={calm} sun={!dim} />;
  else if (skin.background === "city") bg = <CityBackground />;
  else if (skin.background === "lacquer") bg = <LacquerBackground />;
  else if (skin.background === "vhs") bg = <VhsBackground sun={!dim} />;
  else if (skin.background === "desktop") bg = <DesktopBackground />;
  else if (skin.background === "comic") bg = <ComicBackground />;
  else if (skin.background === "poster") bg = <PosterBackground />;
  else if (skin.background === "rain") bg = <RainBackground />;
  if (!bg) return null;
  return (
    <>
      {bg}
      {dim && <div className="skin-veil pointer-events-none absolute left-0 top-0 h-[1080px] w-[1920px]" />}
    </>
  );
}

const layer = "pointer-events-none absolute left-0 top-0 h-[1080px] w-[1920px]";
export const HORIZON = 600;

/** Deterministic pseudo-random numbers (stable SVG between renders). */
function rand(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const STARS = (() => {
  const r = rand(7);
  return Array.from({ length: 46 }, () => ({ x: Math.round(r() * 1920), y: Math.round(r() * (HORIZON - 120)), s: r() < 0.2 ? 2.2 : 1.3, o: 0.35 + r() * 0.5 }));
})();

/** A ridge of wireframe mountains between x0 and x1 (peaks up to `peak` px above the horizon). */
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
  // Wire mesh: each peak to the horizon midpoints around it.
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
/** Sun stripes: gaps growing towards the horizon. */
const SUN_GAPS = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ y: 470 + i * 21 + i * i * 1.5, h: 3 + i * 2.2 }));

/** Static sky, striped sun and wireframe mountains (one SVG, painted once). */
export function SynthwaveSky({ sun = true }: { sun?: boolean }) {
  return (
    <svg className={layer} viewBox="0 0 1920 1080" preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id="sw-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0d0420" />
          <stop offset=".62" stopColor="#24073f" />
          <stop offset="1" stopColor="#4c0f63" />
        </linearGradient>
        <linearGradient id="sw-sun" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe66b" />
          <stop offset=".45" stopColor="#ff9a3d" />
          <stop offset="1" stopColor="#ff2fa8" />
        </linearGradient>
        <radialGradient id="sw-glow" cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#ff4fd8" stopOpacity=".45" />
          <stop offset="1" stopColor="#ff4fd8" stopOpacity="0" />
        </radialGradient>
        <mask id="sw-sun-mask">
          <rect x="0" y="0" width="1920" height="1080" fill="#fff" />
          {SUN_GAPS.map((g) => (
            <rect key={g.y} x="0" y={g.y} width="1920" height={g.h} fill="#000" />
          ))}
        </mask>
      </defs>
      <rect x="0" y="0" width="1920" height={HORIZON} fill="url(#sw-sky)" />
      {STARS.map((s, i) => (
        <circle key={i} cx={s.x} cy={s.y} r={s.s} fill="#fff" opacity={s.o} />
      ))}
      {sun && (
        <>
          <circle cx="1380" cy="440" r="330" fill="url(#sw-glow)" />
          <circle cx="1380" cy="440" r="210" fill="url(#sw-sun)" mask="url(#sw-sun-mask)" />
        </>
      )}
      {RIDGES.map((r, i) => (
        <g key={i} opacity={i === 2 ? 0.75 : 1}>
          <polygon points={r.poly} fill="#14062c" stroke="#3ce8ff" strokeWidth="2" strokeLinejoin="round" />
          {r.wires.map(([x1, y1, x2, y2], j) => (
            <line key={j} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#3ce8ff" strokeOpacity=".38" strokeWidth="1.2" />
          ))}
        </g>
      ))}
      <rect x="0" y={HORIZON - 3} width="1920" height="6" fill="#ff4fd8" />
      <rect x="0" y={HORIZON} width="1920" height={1080 - HORIZON} fill="#0d0420" />
    </svg>
  );
}

/** Floor lines: geometric spacing (FLOOR_R) below the horizon, so scaling the layer by 1/R about the horizon maps each line onto the next one. */
const FLOOR_H = 1080 - HORIZON;
const FLOOR_LINES = Array.from({ length: 22 }, (_, i) => 760 * Math.pow(FLOOR_R, i - 1)).filter((y) => y > 3);

/**
 * The neon floor. Converging lines are static; the cross lines are one
 * layer whose only animation is a scaleY about the horizon (transform-only,
 * seamless: 1 → 1/R moves every line onto its neighbour). `calm` stops it.
 */
export function SynthwaveFloor({ calm }: { calm: boolean }) {
  const xs = Array.from({ length: 31 }, (_, i) => -3840 + i * 320);
  return (
    <div className="sw-floor pointer-events-none absolute left-0 w-[1920px] overflow-hidden" style={{ top: HORIZON, height: FLOOR_H }}>
      <svg className="absolute left-0 top-0" width="1920" height={FLOOR_H} viewBox={`0 0 1920 ${FLOOR_H}`} aria-hidden>
        {xs.map((x) => (
          <line key={x} x1="960" y1="0" x2={x} y2={FLOOR_H} stroke="#ff4fd8" strokeOpacity=".7" strokeWidth="2" />
        ))}
      </svg>
      <div className={`sw-lines absolute left-0 top-0 w-[1920px] ${calm ? "" : "sw-lines-run"}`} style={{ height: 800 }}>
        <svg width="1920" height="800" viewBox="0 0 1920 800" preserveAspectRatio="none" aria-hidden>
          {FLOOR_LINES.map((y) => (
            <rect key={y} x="0" y={y} width="1920" height={1.4 + y * 0.006} fill="#ff4fd8" opacity=".8" />
          ))}
        </svg>
      </div>
      <div className="sw-floor-fade absolute left-0 top-0 h-full w-full" />
    </div>
  );
}

function SynthwaveBackground({ calm, sun }: { calm: boolean; sun: boolean }) {
  return (
    <div data-skin-bg="synthwave" data-calm={calm ? "1" : undefined} className={layer}>
      <SynthwaveSky sun={sun} />
      <SynthwaveFloor calm={calm} />
      {/* Calms the left text column (titles, hints, empty states) over the mountains; the right stays vivid. */}
      <div className="sw-veil absolute left-0 top-0 h-full w-full" />
    </div>
  );
}

/** A static perspective grid (SVG lines) for overlays over artwork (Home hero). */
export function WireGrid({ top, height, opacity = 1 }: { top: number; height: number; opacity?: number }) {
  const vx = 960;
  const xs = Array.from({ length: 25 }, (_, i) => -2400 + i * 300);
  const ys = [0.02, 0.06, 0.12, 0.2, 0.31, 0.45, 0.63, 0.85];
  return (
    <svg className="pointer-events-none absolute left-0 w-[1920px]" style={{ top, height, opacity }} viewBox={`0 0 1920 ${height}`} preserveAspectRatio="none" aria-hidden>
      {xs.map((x) => (
        <line key={x} x1={vx + (x - vx) * 0.04} y1="0" x2={x} y2={height} stroke="#ff4fd8" strokeOpacity=".55" strokeWidth="1.6" />
      ))}
      {ys.map((f) => (
        <line key={f} x1="0" y1={f * height} x2="1920" y2={f * height} stroke="#ff4fd8" strokeOpacity={0.25 + f * 0.5} strokeWidth={1 + f * 1.6} />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------- Киберпанк

const SKYLINE = (() => {
  const r = rand(23);
  const blds: { x: number; w: number; h: number; win: { x: number; y: number; c: string }[] }[] = [];
  let x = 0;
  while (x < 1920) {
    const w = 50 + Math.round(r() * 90);
    const h = 90 + Math.round(r() * 260);
    const win: { x: number; y: number; c: string }[] = [];
    for (let k = 0; k < 6; k++) if (r() < 0.8) win.push({ x: x + 8 + Math.round(r() * (w - 20)), y: 1080 - h + 14 + Math.round(r() * (h - 30)), c: r() < 0.5 ? "#00f0ff" : r() < 0.6 ? "#ff2e88" : "#f5f03c" });
    blds.push({ x, w, h, win });
    x += w + 4 + Math.round(r() * 10);
  }
  return blds;
})();

/** Static: neon haze, a faint street grid, a skyline with lit windows and scanlines. */
function CityBackground() {
  return (
    <div data-skin-bg="city" className={`cp-city ${layer}`}>
      <svg className="absolute left-0 top-0 h-full w-full" viewBox="0 0 1920 1080" preserveAspectRatio="none" aria-hidden>
        {SKYLINE.map((b) => (
          <g key={b.x}>
            <rect x={b.x} y={1080 - b.h} width={b.w} height={b.h} fill="#0c0c16" stroke="#2a2a44" strokeWidth="1" />
            {b.win.map((w, i) => (
              <rect key={i} x={w.x} y={w.y} width="6" height="3" fill={w.c} opacity=".55" />
            ))}
          </g>
        ))}
      </svg>
      <div className="cp-scan absolute left-0 top-0 h-full w-full" />
    </div>
  );
}

// ---------------------------------------------------------------- Ар-деко

/** A quarter sunburst fan anchored at its corner (rays + stepped arcs). */
export function DecoFan({ size, className = "", style }: { size: number; className?: string; style?: React.CSSProperties }) {
  const rays = Array.from({ length: 13 }, (_, i) => (i * Math.PI) / 2 / 12);
  return (
    <svg className={`pointer-events-none ${className}`} style={style} width={size} height={size} viewBox="0 0 200 200" aria-hidden>
      <g fill="none" stroke="#c9a54c" strokeWidth="1.4">
        {[60, 110, 150, 186].map((r) => (
          <path key={r} d={`M ${r} 0 A ${r} ${r} 0 0 1 0 ${r}`} />
        ))}
        {rays.map((a, i) => (
          <line key={i} x1={Math.cos(a) * 60} y1={Math.sin(a) * 60} x2={Math.cos(a) * (i % 2 ? 150 : 186)} y2={Math.sin(a) * (i % 2 ? 150 : 186)} />
        ))}
        <path d="M 0 30 L 30 30 L 30 0" />
        <path d="M 0 42 L 42 42 L 42 0" />
      </g>
      <path d="M 0 0 L 22 0 A 22 22 0 0 1 0 22 Z" fill="#c9a54c" />
    </svg>
  );
}

/** Horizontal divider: lines, stepped chevrons and a diamond. */
export function DecoDivider({ width = 520, className = "" }: { width?: number; className?: string }) {
  const c = width / 2;
  return (
    <svg className={`pointer-events-none ${className}`} width={width} height="22" viewBox={`0 0 ${width} 22`} aria-hidden>
      <g stroke="#c9a54c" strokeWidth="1.5" fill="none">
        <line x1="0" y1="11" x2={c - 46} y2="11" />
        <line x1={c + 46} y1="11" x2={width} y2="11" />
        <path d={`M ${c - 40} 11 l 8 -6 l 8 6 l 8 -6`} />
        <path d={`M ${c + 40} 11 l -8 -6 l -8 6 l -8 -6`} />
      </g>
      <path d={`M ${c} 2 L ${c + 9} 11 L ${c} 20 L ${c - 9} 11 Z`} fill="#c9a54c" />
    </svg>
  );
}

/** Black lacquer: a warm glow, faint pinstripes and gold fans in the corners. */
function LacquerBackground() {
  return (
    <div data-skin-bg="lacquer" className={`dc-lacquer ${layer}`}>
      <DecoFan size={300} className="absolute right-0 top-0 opacity-[.28]" style={{ transform: "scaleX(-1)" }} />
      <DecoFan size={240} className="absolute bottom-0 right-0 opacity-[.2]" style={{ transform: "scale(-1,-1)" }} />
    </div>
  );
}

// ---------------------------------------------------------------- Ретро 80-е

/** The four tape-label stripes of an 80s cassette / VHS sleeve. */
export const RETRO_STRIPES = ["#ff3b5c", "#ff7a1a", "#ffd23a", "#16e0d0"];

/** Rainbow tape stripes rising to the right (a static SVG band, bottom-anchored). */
export function TapeStripes({ width, height, className = "", style }: { width: number; height: number; className?: string; style?: React.CSSProperties }) {
  const band = height / 6;
  return (
    <svg className={`pointer-events-none ${className}`} style={style} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      {RETRO_STRIPES.map((c, i) => {
        const y0 = height - band * (i + 1) * 1.05;
        return <polygon key={c} points={`0,${y0 + band} 0,${y0} ${width},${y0 - height * 0.35} ${width},${y0 - height * 0.35 + band}`} fill={c} />;
      })}
    </svg>
  );
}

/** Navy VHS night: a striped sunset low on the right, tape stripes and faint tracking lines (static). */
function VhsBackground({ sun }: { sun: boolean }) {
  return (
    <div data-skin-bg="vhs" className={`r8-vhs ${layer}`}>
      {sun && (
        <svg className="absolute left-0 top-0" width="1920" height="1080" viewBox="0 0 1920 1080" aria-hidden>
          <defs>
            <linearGradient id="r8-sun" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#ffd23a" />
              <stop offset=".5" stopColor="#ff7a1a" />
              <stop offset="1" stopColor="#ff3b8c" />
            </linearGradient>
          </defs>
          <g opacity=".34">
            <circle cx="1560" cy="1010" r="300" fill="url(#r8-sun)" />
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <rect key={i} x="1200" y={830 + i * 34 + i * i * 2} width="720" height={4 + i * 3} fill="rgb(11,14,42)" />
            ))}
          </g>
        </svg>
      )}
      <TapeStripes width={1920} height={150} className="absolute bottom-0 left-0 opacity-[.16]" />
      <div className="r8-tracking absolute left-0 top-0 h-full w-full" />
    </div>
  );
}

// ---------------------------------------------------------------- Ретро 90-е

/** The Windows 95 desktop: flat teal with a faint dither. */
function DesktopBackground() {
  return <div data-skin-bg="desktop" className={`r9-desktop ${layer}`} />;
}

// ---------------------------------------------------------------- Поп-арт

/** A comic starburst outline: `n` spikes alternating between radii r1 (inner) and r2 (outer), slightly irregular. */
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

const BURST_PTS = burstPoints(150, 108, 66, 98, 13, 9);

/** «БАМ!»: a yellow starburst in black ink with a hard red shadow and comic lettering. */
export function ComicBurst({ text, width, className = "", style }: { text: string; width: number; className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={`pointer-events-none ${className}`} style={style} width={width} height={Math.round(width * 0.72)} viewBox="0 0 300 216" aria-hidden>
      <polygon points={BURST_PTS} fill="#ff2d3c" stroke="#000" strokeWidth="5" strokeLinejoin="round" transform="translate(9 9)" />
      <polygon points={BURST_PTS} fill="#ffd600" stroke="#000" strokeWidth="5" strokeLinejoin="round" />
      <text x="150" y="124" textAnchor="middle" fontFamily="'Rubik Mono One', Unbounded, sans-serif" fontSize="40" fill="#ff2d3c" stroke="#000" strokeWidth="3" paintOrder="stroke">
        {text}
      </text>
    </svg>
  );
}

const COMIC_BURST = burstPoints(1760, 150, 230, 330, 15, 3);

/** Process blue with Ben-Day dots; a pale starburst behind the top-right corner and a red wedge (static). */
function ComicBackground() {
  return (
    <div data-skin-bg="comic" className={`pa-comic ${layer}`}>
      <svg className="absolute left-0 top-0" width="1920" height="1080" viewBox="0 0 1920 1080" aria-hidden>
        <polygon points={COMIC_BURST} fill="#ffd600" opacity=".12" />
        <polygon points="0,1080 0,930 520,1080" fill="#ff2d3c" opacity=".2" />
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------- Конструктивизм

/** An avant-garde poster ground: a red circle at the right, crossing diagonals and wedges (static SVG). */
function PosterBackground() {
  return (
    <div data-skin-bg="poster" className={`cv-poster ${layer}`}>
      <svg className="absolute left-0 top-0" width="1920" height="1080" viewBox="0 0 1920 1080" aria-hidden>
        <circle cx="1720" cy="330" r="300" fill="#d7261e" opacity=".55" />
        <circle cx="1720" cy="330" r="372" fill="none" stroke="#efe4cc" strokeWidth="3" opacity=".14" />
        <polygon points="0,1080 0,860 1180,1080" fill="#d7261e" opacity=".22" />
        <polygon points="1920,1080 1920,780 1460,1080" fill="#efe4cc" opacity=".07" />
        <line x1="-40" y1="980" x2="1960" y2="140" stroke="#efe4cc" strokeWidth="3" opacity=".1" />
        <line x1="-40" y1="1010" x2="1960" y2="170" stroke="#d7261e" strokeWidth="14" opacity=".18" />
      </svg>
    </div>
  );
}

// ================================================================ ornaments

/** Headline size factor of the applied skin (1 on the original designs). */
export function useTitleScale(): number {
  return skinOf(useSkin()).titleScale;
}

/** Extra layers over Home's hero artwork: Ар-деко's curtains, Каркас's grid horizon. */
export function HeroEdges({ height }: { height: number }) {
  const id = useSkin();
  if (!skinOf(id).ornaments.heroEdges) return null;
  if (id === "popart") return <PopHeroEdges height={height} />;
  if (id === "retro80") {
    return (
      <>
        <TapeStripes width={520} height={120} className="absolute bottom-0 right-0 opacity-[.85]" />
        <div className="r8-tracking-band pointer-events-none absolute left-0 w-full" style={{ top: Math.round(height * 0.72), height: 10 }} />
      </>
    );
  }
  if (id === "deco") {
    return (
      <>
        <div className="dc-curtain-r pointer-events-none absolute right-0 top-0" style={{ width: 170, height }} />
        <div className="dc-valance pointer-events-none absolute left-0 top-0 w-full" style={{ height: 46 }} />
      </>
    );
  }
  return <WireGrid top={Math.round(height * 0.6)} height={Math.round(height * 0.4)} opacity={0.55} />;
}

/** Поп-арт over Home's hero artwork: Ben-Day dots in two corners and one «БАМ!» burst. */
function PopHeroEdges({ height }: { height: number }) {
  const { t } = useI18n();
  return (
    <>
      <div className="pa-dots pointer-events-none absolute left-0 top-0 w-full" style={{ height }} />
      <div className="pa-dots-red pointer-events-none absolute left-0 top-0 w-full" style={{ height }} />
      <ComicBurst text={t("designs.popart.bam")} width={300} className="pa-burst absolute" style={{ right: 120, top: Math.round(height * 0.16) }} />
    </>
  );
}

/** Title size in the marquee plate (smaller than the bare title: the plate adds height above the fixed header). */
export function plateTitleSize(title: string): number {
  return title.length > 28 ? 52 : title.length > 16 ? 62 : 76;
}

/** The skin frames Details' title in a plate (Ар-деко). */
export function useTitlePlate(): boolean {
  return skinOf(useSkin()).ornaments.titlePlate;
}

/** Details title: Ар-деко frames it in a marquee plate (labelled with the kind); other skins show `eyebrow` + title. */
export function TitlePlate({ children, kind, eyebrow }: { children: ReactNode; kind: string; eyebrow: ReactNode }) {
  const { t } = useI18n();
  const id = useSkin();
  if (!skinOf(id).ornaments.titlePlate)
    return (
      <>
        {eyebrow}
        {children}
      </>
    );
  return (
    <div data-testid="marquee" className="dc-plate relative mt-3 px-[34px] pb-[22px] pt-[30px]">
      <span className="dc-bulbs absolute left-[24px] right-[24px] top-[9px] h-[8px]" />
      <span className="dc-bulbs absolute bottom-[9px] left-[24px] right-[24px] h-[8px]" />
      <p className="dc-plate-label text-[19px] font-bold uppercase tracking-[.32em] text-accent">
        {kind} · {t("designs.deco.now_showing")}
      </p>
      {children}
    </div>
  );
}

// ================================================================ previews

/** A small tile drawn in a design's own colours (Settings / first-run guide). */
export function DesignTile({ id, active, width = 196 }: { id: DesignSetting; active: boolean; width?: number }) {
  const { t } = useI18n();
  const sw = DESIGN_SWATCH[id];
  const h = Math.round(width * 0.5625);
  return (
    <div data-design-tile={id} data-active={active ? "1" : undefined} className="mb-[14px] mr-[14px] inline-block align-top" style={{ width }}>
      <div className={`dt-tile dt-${id} relative overflow-hidden ${active ? "dt-on" : ""}`} style={{ width, height: h, background: sw.bg }}>
        {/* Mini layout: nav strip per skeleton, a hero bar and three posters. */}
        <span className={`dt-nav dt-nav-${skinOf(id).skeleton}`} style={{ background: sw.surface }} />
        <span className="dt-title" style={{ background: sw.text }} />
        <span className="dt-accent" style={{ background: sw.accent }} />
        {[0, 1, 2].map((i) => (
          <span key={i} className="dt-poster" style={{ left: `${30 + i * 20}%`, borderColor: i === 0 ? sw.accent2 : sw.surface, background: sw.surface }} />
        ))}
      </div>
      <p className={`mt-2 truncate text-[20px] ${active ? "font-bold text-text" : "text-muted"}`}>{t(`settings.design.${id}`)}</p>
    </div>
  );
}

/** Every design's tile, the current one highlighted. */
export function DesignPreviews({ current, width = 196 }: { current: DesignSetting; width?: number }) {
  return (
    <div data-testid="design-previews" style={{ width: (width + 14) * 3 }}>
      {DESIGNS.map((d) => (
        <DesignTile key={d} id={d} active={d === current} width={width} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Матрица

const RAIN_GLYPHS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ0123456789Z:.=*+<>";
export const RAIN_COLUMNS = 64;

/** Columns of falling code, fixed once (deterministic): x, start row, tail glyphs, head glyph, brightness. */
const RAIN = (() => {
  const r = rand(1999);
  const cols: { x: number; top: number; tail: string; head: string; o: number }[] = [];
  for (let i = 0; i < RAIN_COLUMNS; i++) {
    const len = 6 + Math.floor(r() * 18);
    let tail = "";
    for (let k = 0; k < len; k++) tail += RAIN_GLYPHS[Math.floor(r() * RAIN_GLYPHS.length)];
    cols.push({
      x: Math.round(i * 30 + r() * 10),
      top: Math.round(-200 + r() * 900),
      tail,
      head: RAIN_GLYPHS[Math.floor(r() * RAIN_GLYPHS.length)]!,
      o: 0.18 + r() * 0.5,
    });
  }
  return cols;
})();

/**
 * Static digital rain: green glyph columns with a bright head, a dark veil
 * over the lower half and scanlines. Plain text in a few dozen divs — cheap
 * on old TV engines (nothing animates).
 */
function RainBackground() {
  return (
    <div data-skin-bg="rain" className={`mx-rain ${layer}`}>
      {RAIN.map((c) => (
        <div key={c.x} className="mx-col" style={{ left: c.x, top: c.top, opacity: c.o }}>
          {c.tail}
          <span className="mx-head">{c.head}</span>
        </div>
      ))}
      <div className="mx-veil absolute left-0 top-0 h-full w-full" />
      <div className="cp-scan absolute left-0 top-0 h-full w-full" />
    </div>
  );
}
