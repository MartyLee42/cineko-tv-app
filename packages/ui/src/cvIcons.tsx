import { useEffect, useSyncExternalStore, type ReactNode, type SVGProps } from "react";
import { reportChunkFailure } from "./chunkReload";
// «Конструктивизм» pictograms: the alternative icon set both apps draw when
// this design is on. 24×24, solid fills, no rounded corners — bold geometric
// shapes (circles, wedges, thick bars, 45° diagonals). The main shape is
// currentColor (black / cream), the second one red (`.cv-ic-a`; a red slab
// button turns it black through --cv-ic-a, theme.css).

export type CvGlyph =
  | "home" | "grid" | "search" | "tv" | "user" | "shield" | "chevronLeft" | "chevronRight" | "play" | "star" | "filter" | "close"
  | "cast" | "remote" | "check" | "alert" | "pause" | "rewind" | "forward" | "next" | "volume" | "mute" | "list" | "refresh"
  | "restart" | "history" | "clock" | "arrowUp" | "arrowDown" | "device" | "copy" | "download" | "heart" | "heartOutline"
  | "bookmark" | "bookmarkOutline" | "bell" | "gear" | "eye" | "eyeOff" | "fullscreen" | "exitFullscreen" | "pip" | "subtitles"
  | "audio" | "speed" | "compass" | "spark" | "dice" | "film" | "newEpisodes" | "message" | "sliders" | "more" | "plus"
  | "trailer" | "liveTv" | "playTile" | "back" | "reco";

let glyphs: Record<CvGlyph, ReactNode> | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Fetches the shapes (once; applyDesign starts it when the design turns on). */
export function loadCvGlyphs(): Promise<void> {
  return (loading ??= import("./cvGlyphs").then(
    (m) => {
      glyphs = m.CV_GLYPHS;
      for (const l of listeners) l();
    },
    (e: unknown) => {
      loading = null;
      reportChunkFailure(e);
      throw e;
    },
  ));
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The shapes, or null until they arrive (the icon re-renders then). */
function useCvGlyphs(): Record<CvGlyph, ReactNode> | null {
  const g = useSyncExternalStore(subscribe, () => glyphs, () => glyphs);
  useEffect(() => {
    if (!g) loadCvGlyphs().catch(() => undefined);
  }, [g]);
  return g;
}

/**
 * A pictogram of this set as an <svg> (props like width/height/className/
 * aria-* pass through; stroke props are dropped — the set is filled).
 * `mirror` flips the glyph left↔right (children stay as they are).
 */
export function CvIcon({ glyph, mirror, children, ...rest }: { glyph: CvGlyph; mirror?: boolean } & SVGProps<SVGSVGElement>) {
  const svg: SVGProps<SVGSVGElement> = { ...rest };
  delete svg.stroke;
  delete svg.strokeWidth;
  delete svg.strokeLinecap;
  delete svg.strokeLinejoin;
  delete svg.fill;
  const shape = useCvGlyphs()?.[glyph] ?? null;
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden {...svg} fill="currentColor" stroke="none" data-cv-icon={glyph}>
      {mirror ? <g transform="matrix(-1 0 0 1 24 0)">{shape}</g> : shape}
      {children}
    </svg>
  );
}
