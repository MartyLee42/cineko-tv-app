// Poster grids (Browse, Search, Моё) per design.
import type { CatalogConfig, MediaSummary } from "@martytv/contracts";
import type { Design } from "./context";
import { PosterCard, WideCard } from "./cards";

export interface GridGeo {
  cols: number;
  w: number;
  h: number;
  pitchX: number;
  pitchY: number;
  wide: boolean;
}

/** Grid geometry for a band `width` px wide. */
export function gridGeo(design: Design, width: number): GridGeo {
  if (design === "projector") {
    const cols = Math.max(2, Math.floor((width + 30) / 430));
    return { cols, w: 400, h: 225, pitchX: 430, pitchY: 225 + 46, wide: true };
  }
  if (design === "terminal") {
    const cols = Math.max(2, Math.floor((width + 20) / 176));
    return { cols, w: 156, h: 234, pitchX: 176, pitchY: 234 + 58, wide: false };
  }
  const cols = Math.max(2, Math.floor((width + 28) / 232));
  return { cols, w: 204, h: 306, pitchX: 232, pitchY: 306 + 92, wide: false };
}

export function GridCard({ item, cfg, g, focused, index }: { item: MediaSummary; cfg: CatalogConfig | undefined; g: GridGeo; focused: boolean; index: number }) {
  return g.wide ? (
    <WideCard media={item} title={item.title} cfg={cfg} width={g.w} height={g.h} focused={focused} />
  ) : (
    <PosterCard item={item} cfg={cfg} width={g.w} height={g.h} focused={focused} index={index + 1} showTitle />
  );
}

/** Screen title per design ("02 / ФИЛЬМЫ" in Терминал). */
export function ScreenTitle({ design, index, children }: { design: Design; index?: number; children: React.ReactNode }) {
  if (design === "terminal") {
    return (
      <h1 className="t-label text-[34px] text-text">
        {index !== undefined && <span className="text-accent">{String(index).padStart(2, "0")} / </span>}
        {children}
      </h1>
    );
  }
  if (design === "projector") return <h1 className="p-wide text-[52px] font-bold uppercase">{children}</h1>;
  return <h1 className="text-[56px] font-bold tracking-[-.01em]">{children}</h1>;
}
