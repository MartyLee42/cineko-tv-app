// «Ар-деко»: black lacquer with gold sunburst fans; curtains over Home's hero; the marquee title plate.
import "./deco.css";
import type { ReactNode } from "react";
import { useI18n } from "@martytv/ui";
import type { Look } from "./types";
import { layer } from "./common";

/** A quarter sunburst fan anchored at its corner (rays + stepped arcs). */
function DecoFan({ size, className = "", style }: { size: number; className?: string; style?: React.CSSProperties }) {
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

/** Black lacquer: a warm glow, faint pinstripes and gold fans in the corners. */
function LacquerBackground() {
  return (
    <div data-skin-bg="lacquer" className={`dc-lacquer ${layer}`}>
      <DecoFan size={300} className="absolute right-0 top-0 opacity-[.28]" style={{ transform: "scaleX(-1)" }} />
      <DecoFan size={240} className="absolute bottom-0 right-0 opacity-[.2]" style={{ transform: "scale(-1,-1)" }} />
    </div>
  );
}

/** Over Home's hero artwork: a red curtain at the right and a valance on top. */
function DecoHeroEdges({ height }: { height: number }) {
  return (
    <>
      <div className="dc-curtain-r pointer-events-none absolute right-0 top-0" style={{ width: 170, height }} />
      <div className="dc-valance pointer-events-none absolute left-0 top-0 w-full" style={{ height: 46 }} />
    </>
  );
}

/** Details title in a marquee plate, labelled with the kind. */
function DecoTitlePlate({ children, kind }: { children: ReactNode; kind: string }) {
  const { t } = useI18n();
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

export const look: Look = { Background: () => <LacquerBackground />, HeroEdges: DecoHeroEdges, TitlePlate: DecoTitlePlate };
