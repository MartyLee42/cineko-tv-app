import type { ComponentType, ReactNode } from "react";

/** What a design draws beyond CSS (each optional; the original three draw nothing extra). */
export interface Look {
  /** Full-screen background layer. `dim` (Settings, guide): calmer, no sun. */
  Background?: ComponentType<{ calm: boolean; dim: boolean }>;
  /** Extra layers over Home's hero artwork. */
  HeroEdges?: ComponentType<{ height: number }>;
  /** Details title framed in a plate (labelled with the kind). */
  TitlePlate?: ComponentType<{ kind: string; children: ReactNode }>;
  /** OK on a card → Details: start a short «pick» animation on the card's wrapper; Details opens after `ms` (≤ 300). */
  pick?: { ms: number; start: (card: HTMLElement) => void };
  /** Drawn over the catalog (under the menu and overlays), e.g. Тамагочи's pixel pet. `onHome`: Home with nothing over it. */
  Companion?: ComponentType<{ onHome: boolean }>;
  /** A static, unfocusable card after a row's last item (`row`, the item's size) and under a grid (`screen`), e.g. «Мультфильм»'s «Конец фильма». */
  End?: ComponentType<{ kind: "row" | "screen"; width: number; height: number }>;
}
