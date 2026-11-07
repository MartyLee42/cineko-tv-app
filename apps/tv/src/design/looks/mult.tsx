// «Мультфильм» (in the spirit of classic Soviet studio animation): a LIGHT design. A gouache sky,
// cut-out paper hills and trees, one slow fog layer (stopped in calm motion); paper clouds over
// Home's hero; the Details title on an ornate title card; every row and grid ends with a small
// «Конец фильма» card (mult.css). Original shapes only, no characters.
import "./mult.css";
import type { ReactNode } from "react";
import { useI18n } from "@martytv/ui";
import type { Look } from "./types";
import { layer } from "./common";

// Gouache paper colours (mult.css uses the same ones).
const HILL_FAR = "#d5dccd";
const HILL_MID = "#c3cea5";
const HILL_NEAR = "#afbd8b";
const FIR = "#8ea582";
const FIR_DARK = "#7a926f";
const CROWN = "#d4a861";
const TRUNK = "#8c6b4f";
const PAPER = "#fffaf0";
const SHADE = "rgba(96,64,40,.12)";

/** A wavy hill silhouette from x=0 to 1920 over `base` (amplitudes and phases hand-tuned), closed at the bottom. */
function hill(base: number, waves: [number, number, number][]): string {
  let d = `M0 1080 L0 ${base}`;
  for (let x = 0; x <= 1920; x += 40) {
    let y = base;
    for (const [amp, len, ph] of waves) y += amp * Math.sin((x / len) * Math.PI * 2 + ph);
    d += ` L${x} ${y.toFixed(1)}`;
  }
  return `${d} L1920 1080 Z`;
}

const HILLS: [string, string][] = [
  [hill(938, [[18, 900, 0.4], [9, 380, 1.7]]), HILL_FAR],
  [hill(985, [[22, 1150, 2.1], [8, 300, 0.2]]), HILL_MID],
  [hill(1035, [[14, 760, 4.0], [6, 260, 1.1]]), HILL_NEAR],
];

/** A cut-out fir: three stacked paper triangles on a short trunk. */
function Fir({ x, y, s, dark }: { x: number; y: number; s: number; dark?: boolean }) {
  const c = dark ? FIR_DARK : FIR;
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <rect x={-5} y={-8} width={10} height={20} fill={TRUNK} />
      {[0, 1, 2].map((i) => (
        <path key={i} d={`M0 ${-118 + i * 34} L${34 + i * 9} ${-50 + i * 30} L${-34 - i * 9} ${-50 + i * 30} Z`} fill={c} />
      ))}
    </g>
  );
}

/** A round cut-out tree (an ochre crown on a stick). */
function Round({ x, y, s }: { x: number; y: number; s: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <rect x={-4} y={-50} width={8} height={56} fill={TRUNK} />
      <ellipse cx={3} cy={-82} rx={40} ry={44} fill={SHADE} />
      <ellipse cx={0} cy={-86} rx={40} ry={44} fill={CROWN} />
    </g>
  );
}

/** A paper cloud: overlapping circles, a soft shade under it. */
function Cloud({ x, y, s }: { x: number; y: number; s: number }) {
  const puffs: [number, number, number][] = [[-52, 6, 30], [-18, -10, 40], [24, -4, 34], [58, 8, 26]];
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      {puffs.map(([cx, cy, r], i) => (
        <circle key={`s${i}`} cx={cx + 3} cy={cy + 6} r={r} fill={SHADE} />
      ))}
      <rect x={-80} y={4} width={164} height={30} rx={15} fill={SHADE} transform="translate(3 6)" />
      {puffs.map(([cx, cy, r], i) => (
        <circle key={i} cx={cx} cy={cy} r={r} fill={PAPER} />
      ))}
      <rect x={-80} y={4} width={164} height={30} rx={15} fill={PAPER} />
    </g>
  );
}

/** The scenery: sky and paper grain (CSS), sun, clouds, three hill layers with trees, one slow fog band. */
function Gouache({ calm, dim }: { calm: boolean; dim: boolean }) {
  return (
    <div data-skin-bg="gouache" data-motion={calm ? "calm" : "on"} className={`mu-sky ${layer}`}>
      <svg className="absolute left-0 top-0" width="1920" height="1080" viewBox="0 0 1920 1080" aria-hidden>
        {!dim && (
          <g>
            <circle cx={1700} cy={170} r={118} fill="#f8e2b8" opacity=".7" />
            <circle cx={1700} cy={170} r={78} fill="#f4c586" />
            <Cloud x={1450} y={300} s={1.1} />
            <Cloud x={1180} y={130} s={0.8} />
          </g>
        )}
        {HILLS.map(([d, fill], i) => (
          <g key={i}>
            <path d={d} fill={SHADE} transform="translate(0 -5)" />
            <path d={d} fill={fill} />
            {i === 0 && !dim && (
              <>
                <Fir x={1560} y={948} s={0.4} />
                <Fir x={1600} y={946} s={0.3} dark />
                <Round x={760} y={950} s={0.38} />
              </>
            )}
            {i === 1 && !dim && (
              <>
                <Fir x={150} y={1000} s={1.1} dark />
                <Fir x={250} y={1004} s={0.8} />
                <Round x={1290} y={995} s={0.6} />
                <Fir x={1820} y={990} s={0.7} />
              </>
            )}
          </g>
        ))}
      </svg>
      {/* The fog: a doubled band of soft ellipses, slid one width to the left over two minutes (transform only). */}
      <div className={`mu-fog ${calm ? "" : "mu-fog-on"}`} />
    </div>
  );
}

/** Over Home's hero artwork: paper clouds hanging over its top edge. */
function MultHeroEdges() {
  return (
    <svg className="pointer-events-none absolute left-0 top-0" width="1320" height="150" viewBox="0 0 1320 150" aria-hidden>
      <Cloud x={330} y={62} s={0.9} />
      <Cloud x={1210} y={196} s={0.7} />
    </svg>
  );
}

/** A curl for the title card's corners (drawn for the top-left; the others are mirrored in CSS). */
function Curl({ pos }: { pos: "tl" | "tr" | "bl" | "br" }) {
  return (
    <svg className={`mu-curl mu-curl-${pos}`} width="54" height="54" viewBox="0 0 54 54" aria-hidden>
      <path d="M6 48 C 6 20 20 6 48 6 M14 48 C 14 26 26 14 48 14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <circle cx="22" cy="22" r="4.5" fill="currentColor" />
    </svg>
  );
}

/** Details: the title on an old-fashioned title card (double frame, corner curls, the kind above). */
function MultTitlePlate({ children, kind }: { children: ReactNode; kind: string }) {
  return (
    <div data-testid="mult-title-card" className="mu-card relative mt-2 px-[76px] pb-[34px] pt-[30px]">
      <Curl pos="tl" />
      <Curl pos="tr" />
      <Curl pos="bl" />
      <Curl pos="br" />
      <p className="mu-card-kind">{kind}</p>
      {children}
    </div>
  );
}

/** A little flourish either side of the end card's text. */
function Flourish({ flip }: { flip?: boolean }) {
  return (
    <svg className="mu-flourish" width="120" height="16" viewBox="0 0 120 16" aria-hidden style={flip ? { transform: "scaleY(-1)" } : undefined}>
      <path d="M4 8 C 24 -2 36 18 56 8 M64 8 C 84 -2 96 18 116 8" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M60 2 L64 8 L60 14 L56 8 Z" fill="currentColor" />
    </svg>
  );
}

/** «Конец фильма»: a small oval end card after a row's last item and under grids. Static. */
function EndCard({ kind, width, height }: { kind: "row" | "screen"; width: number; height: number }) {
  const { t } = useI18n();
  const w = kind === "row" ? Math.min(width, 300) : 380;
  // Two lines («Конец» / «фильма»): fits a poster's width at a size that reads from the sofa.
  const text = t("mult.end");
  const cut = text.indexOf(" ");
  return (
    <div data-testid="mult-end" className="mu-end-wrap" style={{ width, height: kind === "row" ? height : 200 }}>
      <div className="mu-end" style={{ width: w }}>
        <Flourish />
        <p className="mu-end-text">
          {cut > 0 ? text.slice(0, cut) : text}
          {cut > 0 && <br />}
          {cut > 0 && text.slice(cut + 1)}
        </p>
        <Flourish flip />
      </div>
    </div>
  );
}

export const look: Look = { Background: Gouache, HeroEdges: MultHeroEdges, TitlePlate: MultTitlePlate, End: EndCard };
