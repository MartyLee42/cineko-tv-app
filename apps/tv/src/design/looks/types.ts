import type { ComponentType, ReactNode } from "react";

/** What a design draws beyond CSS (each optional; the original three draw nothing extra). */
export interface Look {
  /** Full-screen background layer. `dim` (Settings, guide): calmer, no sun. */
  Background?: ComponentType<{ calm: boolean; dim: boolean }>;
  /** Extra layers over Home's hero artwork. */
  HeroEdges?: ComponentType<{ height: number }>;
  /** Details title framed in a plate (labelled with the kind). */
  TitlePlate?: ComponentType<{ kind: string; children: ReactNode }>;
  /** Drawn over the catalog (under the menu and overlays), e.g. Тамагочи's pixel pet. `onHome`: Home with nothing over it. */
  Companion?: ComponentType<{ onHome: boolean }>;
}
