// Menu items per design (pure: shared by the shells and their tests).
export type MenuId =
  | "search"
  | "home"
  | "tv"
  /** «Видео»: YouTube through the self-hosted Invidious. */
  | "video"
  | "explore"
  | "movies"
  | "series"
  | "surprise"
  | "ask"
  | "history"
  /** «Новые серии» (nightly new-episodes check). */
  | "new"
  | "mine"
  | "messages"
  | "settings"
  | "profile";

/** Кинозал's rail (top group; settings + profile sit at the bottom). */
export const KINOZAL_MENU: MenuId[] = ["search", "home", "tv", "video", "explore", "movies", "series", "new", "surprise", "ask", "history", "mine", "messages"];
/** Терминал's numbered tabs (settings + profile on the right). */
export const TERMINAL_MENU: MenuId[] = ["home", "tv", "video", "explore", "movies", "series", "new", "search", "surprise", "ask", "history", "mine", "messages"];
/** Проектор's pill: text tabs, then icon tabs. */
export const PROJECTOR_TEXT: MenuId[] = ["home", "tv", "video", "explore", "movies", "series", "history", "mine"];
/** «Новые серии» is an icon here (with its count): another text tab would run into the clock. */
export const PROJECTOR_ICONS: MenuId[] = ["new", "ask", "surprise", "search", "messages", "settings"];

/** Кинозал rail geometry: first item's top and the item pitch (px). */
export const RAIL_FIRST = 134;
/** 54 px items + 4 px (13 items still fit above settings). */
export const RAIL_PITCH = 58;

/** Top of the active-item indicator in Кинозал's rail (null when not in the top group). */
export function railIndicatorTop(active: MenuId | null): number | null {
  const i = active ? KINOZAL_MENU.indexOf(active) : -1;
  return i < 0 ? null : RAIL_FIRST + i * RAIL_PITCH + 11;
}
