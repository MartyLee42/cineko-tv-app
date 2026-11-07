// The loading styles' chunks. Tiny on purpose (only dynamic imports): the
// app's core imports it to fetch the profile's style together with the
// player's code, so the loader is ready the moment playback starts.
import { lazy, type ComponentType } from "react";
import { upcomingSurprise, type DesignSetting, type LoaderAnimation } from "@martytv/ui";
import type { LoadingStyle } from "../profile/settings";
import type { LoaderModel } from "./loaderParts";

export type LoaderKind =
  | "minimal"
  | "popcorn"
  | "fill_title"
  | "poster_reveal"
  | "film_reel"
  | "marty"
  | "matrix"
  | "poster"
  | "paws"
  | "aquarium"
  | "speed88"
  | "odyssey"
  | "balloons"
  | "catch"
  | "water_glass"
  | "poster_dig"
  | "chocolate_box"
  | "coffee_cup"
  | "honey_pot"
  | "hyperjump"
  | "ghost_meter"
  | "target_scan"
  | "docking"
  | "claw_machine";

type StyleProps = { m: LoaderModel; mood?: "loading" | "popcorn"; preview?: boolean };
type StyleModule = { default: ComponentType<StyleProps> };

const imports: Record<Exclude<LoaderKind, "minimal">, () => Promise<StyleModule>> = {
  popcorn: () => import("./loaders/Popcorn") as Promise<StyleModule>,
  fill_title: () => import("./loaders/FillTitle") as Promise<StyleModule>,
  poster_reveal: () => import("./loaders/PosterReveal") as Promise<StyleModule>,
  film_reel: () => import("./loaders/FilmReel") as Promise<StyleModule>,
  marty: () => import("./loaders/Marty") as Promise<StyleModule>,
  matrix: () => import("./loaders/Matrix") as Promise<StyleModule>,
  poster: () => import("./loaders/Poster") as Promise<StyleModule>,
  paws: () => import("./loaders/Paws") as Promise<StyleModule>,
  aquarium: () => import("./loaders/Aquarium") as Promise<StyleModule>,
  speed88: () => import("./loaders/Speed88") as Promise<StyleModule>,
  odyssey: () => import("./loaders/Odyssey") as Promise<StyleModule>,
  balloons: () => import("./loaders/Balloons") as Promise<StyleModule>,
  catch: () => import("./loaders/Catch") as Promise<StyleModule>,
  water_glass: () => import("./loaders/Glass") as Promise<StyleModule>,
  poster_dig: () => import("./loaders/Dig") as Promise<StyleModule>,
  chocolate_box: () => import("./loaders/Chocolates") as Promise<StyleModule>,
  coffee_cup: () => import("./loaders/Coffee") as Promise<StyleModule>,
  honey_pot: () => import("./loaders/Honey") as Promise<StyleModule>,
  hyperjump: () => import("./loaders/Hyperjump") as Promise<StyleModule>,
  ghost_meter: () => import("./loaders/GhostMeter") as Promise<StyleModule>,
  target_scan: () => import("./loaders/Scanner") as Promise<StyleModule>,
  docking: () => import("./loaders/Docking") as Promise<StyleModule>,
  claw_machine: () => import("./loaders/Claw") as Promise<StyleModule>,
};

/** Which loader draws: «Конструктивизм» / «Матрица» have their own whatever the style (not in Settings' previews). */
export function loaderKind(style: LoaderAnimation, design: DesignSetting, preview = false): LoaderKind {
  if (!preview && design === "constructivism") return "poster";
  if (!preview && design === "matrix") return "matrix";
  if (style === "marty_popcorn") return "marty";
  return style;
}

/** The animation the next load will show for a setting (for fetching its chunk ahead): «Сюрприз» has one waiting. */
export function upcomingAnimation(setting: LoadingStyle): LoaderAnimation | null {
  // «Под фильм» depends on the title: fetched when the load starts.
  if (setting === "match") return null;
  return setting === "surprise" ? upcomingSurprise() : setting;
}

/** Styles with an end flourish: kept up this long over the starting film (fading out), see PlayerLayer. */
export const FINALE_MS = 1500;
const FINALE: readonly LoaderKind[] = ["paws", "aquarium", "speed88", "odyssey", "balloons", "catch"];

export function hasFinale(kind: LoaderKind): boolean {
  return FINALE.includes(kind);
}

const loads: Partial<Record<LoaderKind, Promise<StyleModule>>> = {};

/** Fetches a style's chunk (once; a failure is retried next time). */
export function preloadLoader(kind: LoaderKind): Promise<unknown> {
  if (kind === "minimal") return Promise.resolve();
  return (loads[kind] ??= imports[kind]().catch((e: unknown) => {
    delete loads[kind];
    throw e;
  }));
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
