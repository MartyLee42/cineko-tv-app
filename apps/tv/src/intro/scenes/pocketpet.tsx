// The startup intro in «pocketpet» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import type { ReactNode } from "react";
import { delay } from "../parts";
import { BODY, CHEST, dots, EGG_BOTTOM, EGG_TOP, EGG_WHOLE, FACE, HEART, INK, LCD, pixels, SPARKLE } from "../../design/looks/pocketpetSprites";
import "./pocketpet.css";

// ================================================================ Тамагочи

/** A pixel sprite (crisp squares) in an absolutely placed box, so the box can move (HTML transforms: old engines). */
function Px({ x, y, w, h, px, className = "", at, children }: { x: number; y: number; w: number; h: number; px: number; className?: string; at?: number; children: ReactNode }) {
  return (
    <div className={`in-abs ${className}`} style={{ left: x, top: y, width: w * px, height: h * px, ...(at !== undefined ? delay(at) : {}) }}>
      <svg width={w * px} height={h * px} viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges" className="block">
        {children}
      </svg>
    </div>
  );
}

/** The cells between a row's outer pixels ("o"): the shell's inside, painted over what sits behind it. */
const inside = (rows: readonly string[]) =>
  rows.map((r) => {
    const a = r.indexOf("#");
    const b = r.lastIndexOf("#");
    return a < 0 ? r : r.slice(0, a) + r.slice(a, b + 1).replace(/\./g, "o") + r.slice(b + 1);
  });

const EGG = { x: 568, y: 232, px: 12 };
const CAT = { x: 560, y: 240, px: 10 };

/** A pastel egg-shaped toy; on its LCD a pixel egg wobbles, cracks and hatches Cineko; hearts fill up; «Cineko» types in. */
export function Scene() {
  const pix = "'Press Start 2P', 'JetBrains Mono', monospace";
  return (
    <>
      <div className="in-abs" style={{ width: 1280, height: 720, background: "radial-gradient(ellipse at 50% 40%, #e9e0fb 0%, #cdeee0 70%, #bfe6d6 100%)" }} />
      {/* The toy. */}
      <div className="in-abs in-pp-toy" style={{ width: 1280, height: 720 }}>
        <svg width={1280} height={720} viewBox="0 0 1280 720" className="block">
          <defs>
            <linearGradient id="in-pp-shell" x1="0" y1="0" x2="0.3" y2="1">
              <stop offset="0" stopColor="#fbdcea" />
              <stop offset="0.6" stopColor="#f3c6dc" />
              <stop offset="1" stopColor="#e2b3d8" />
            </linearGradient>
            <pattern id="in-pp-cells" width={5} height={5} patternUnits="userSpaceOnUse">
              <path d="M0 0H5V1H1V5H0Z" fill="rgba(24,32,18,.06)" />
            </pattern>
          </defs>
          <path d="M640 26C900 26 1030 300 1030 440C1030 610 860 706 640 706C420 706 250 610 250 440C250 300 380 26 640 26Z" fill="url(#in-pp-shell)" stroke="#c7a0c4" strokeWidth={6} />
          <ellipse cx={500} cy={130} rx={120} ry={46} transform="rotate(-24 500 130)" fill="#ffffff" opacity={0.35} />
          <g fontFamily={pix} fontSize={24}>
            <text x={638} y={158} textAnchor="middle" fill="#ffffff" opacity={0.85}>Cineko</text>
            <text x={642} y={162} textAnchor="middle" fill="#c493b4">Cineko</text>
            <text x={640} y={160} textAnchor="middle" fill="#ecb8d4">Cineko</text>
          </g>
          <rect x={406} y={184} width={468} height={318} rx={30} fill="#d8c3e6" />
          <rect x={420} y={196} width={440} height={294} rx={22} fill={LCD} />
          <rect x={420} y={196} width={440} height={294} rx={22} fill="url(#in-pp-cells)" />
          <path d="M432 214Q440 204 470 204H640L560 300H432Z" fill="#ffffff" opacity={0.14} />
          {(["#a8e6c9", "#cdbdf5", "#ffe59a"] as const).map((c, i) => (
            <g key={c}>
              <circle cx={540 + i * 100} cy={584} r={30} fill="rgba(120,70,110,.25)" />
              <circle cx={540 + i * 100} cy={579} r={28} fill={c} stroke="#ffffff" strokeOpacity={0.6} strokeWidth={4} />
            </g>
          ))}
        </svg>
      </div>
      {/* The egg wobbles, cracks… */}
      <Px x={EGG.x} y={EGG.y} w={12} h={14} px={EGG.px} className="in-pp-egg">
        <path d={pixels(EGG_WHOLE)} fill={INK} />
        <path className="in-pp-crack" d={dots([[3, 7], [5, 7], [6, 7], [8, 7], [4, 8], [7, 8]])} fill={INK} style={delay(1.15)} />
      </Px>
      {/* …and hatches: Cineko pops up out of the bottom half, the top half flies off. */}
      <Px x={CAT.x} y={CAT.y} w={16} h={15} px={CAT.px} className="in-pp-cat" at={1.75}>
        <path d={pixels(BODY)} fill={INK} />
        <path d={dots(FACE.happy) + dots(CHEST)} fill={LCD} />
      </Px>
      <Px x={EGG.x} y={EGG.y + 8 * EGG.px} w={12} h={6} px={EGG.px} className="in-pp-shell-b" at={1.7}>
        <path d={pixels(EGG_BOTTOM)} fill={INK} />
        <path d={pixels(inside(EGG_BOTTOM), "o")} fill={LCD} />
      </Px>
      <Px x={EGG.x} y={EGG.y} w={12} h={8} px={EGG.px} className="in-pp-shell-t" at={1.7}>
        <path d={pixels(inside(EGG_TOP), "o")} fill={LCD} />
        <path d={pixels(EGG_TOP)} fill={INK} />
      </Px>
      {/* A burst of sparkles at the hatch. */}
      {[
        [520, 236],
        [732, 226],
        [500, 352],
        [756, 340],
      ].map(([x, y], i) => (
        <Px key={i} x={x!} y={y!} w={3} h={3} px={8} className="in-pp-spark" at={1.72 + i * 0.05}>
          <path d={pixels(SPARKLE)} fill={INK} />
        </Px>
      ))}
      {/* The happiness meter fills up. */}
      {[0, 1, 2, 3].map((i) => (
        <Px key={i} x={548 + i * 48} y={206} w={7} h={6} px={4} className="in-pp-heart" at={2.05 + i * 0.14}>
          <path d={pixels(HEART)} fill={INK} />
        </Px>
      ))}
      {/* The name, letter by letter. */}
      <div className="in-abs" style={{ left: 420, top: 424, width: 440, textAlign: "center", fontFamily: pix, fontSize: 32, lineHeight: "40px", color: INK }}>
        {"Cineko".split("").map((ch, i) => (
          <span key={i} className="in-pp-letter" style={delay(2.15 + i * 0.08)}>
            {ch}
          </span>
        ))}
      </div>
    </>
  );
}
