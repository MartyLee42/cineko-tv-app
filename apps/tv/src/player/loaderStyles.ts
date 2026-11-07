// The loading styles as lazy components and their end flourishes (the player's
// chunk only; the chunks themselves: loaderChunks.ts, which the startup code imports).
import { lazy, type ComponentType } from "react";
import { preloadLoader, type LoaderKind, type StyleModule, type StyleProps } from "./loaderChunks";

/** Styles with an end flourish: kept up this long over the starting film (fading out), see PlayerLayer. */
export const FINALE_MS = 1500;
const FINALE: readonly LoaderKind[] = ["paws", "aquarium", "speed88", "odyssey", "balloons", "catch"];

export function hasFinale(kind: LoaderKind): boolean {
  return FINALE.includes(kind);
}

/** Each style as a lazy component (created once here; nothing is fetched until one renders). */
export const LOADERS = {
  popcorn: lazy(() => preloadLoader("popcorn") as Promise<StyleModule>),
  fill_title: lazy(() => preloadLoader("fill_title") as Promise<StyleModule>),
  poster_reveal: lazy(() => preloadLoader("poster_reveal") as Promise<StyleModule>),
  film_reel: lazy(() => preloadLoader("film_reel") as Promise<StyleModule>),
  marty: lazy(() => preloadLoader("marty") as Promise<StyleModule>),
  matrix: lazy(() => preloadLoader("matrix") as Promise<StyleModule>),
  poster: lazy(() => preloadLoader("poster") as Promise<StyleModule>),
  paws: lazy(() => preloadLoader("paws") as Promise<StyleModule>),
  aquarium: lazy(() => preloadLoader("aquarium") as Promise<StyleModule>),
  speed88: lazy(() => preloadLoader("speed88") as Promise<StyleModule>),
  odyssey: lazy(() => preloadLoader("odyssey") as Promise<StyleModule>),
  balloons: lazy(() => preloadLoader("balloons") as Promise<StyleModule>),
  catch: lazy(() => preloadLoader("catch") as Promise<StyleModule>),
  water_glass: lazy(() => preloadLoader("water_glass") as Promise<StyleModule>),
  poster_dig: lazy(() => preloadLoader("poster_dig") as Promise<StyleModule>),
  chocolate_box: lazy(() => preloadLoader("chocolate_box") as Promise<StyleModule>),
  coffee_cup: lazy(() => preloadLoader("coffee_cup") as Promise<StyleModule>),
  honey_pot: lazy(() => preloadLoader("honey_pot") as Promise<StyleModule>),
  hyperjump: lazy(() => preloadLoader("hyperjump") as Promise<StyleModule>),
  ghost_meter: lazy(() => preloadLoader("ghost_meter") as Promise<StyleModule>),
  target_scan: lazy(() => preloadLoader("target_scan") as Promise<StyleModule>),
  docking: lazy(() => preloadLoader("docking") as Promise<StyleModule>),
  claw_machine: lazy(() => preloadLoader("claw_machine") as Promise<StyleModule>),
} satisfies Record<Exclude<LoaderKind, "minimal">, ComponentType<StyleProps>>;
