// «Симметрия»: each menu tab is a «chapter» of the app; its card reads «Часть N · <tab>».
// Pure (tested): the number is the tab's place in the Проектор pill, so it never changes.
import type { MessageKey } from "@martytv/ui";
import { PROJECTOR_ICONS, PROJECTOR_TEXT, type MenuId } from "../menuOrder";

const ORDER: MenuId[] = [...PROJECTOR_TEXT, ...PROJECTOR_ICONS];

/** The i18n key of each chapter's name (the same words as the menu). */
export const CHAPTER_NAME: Partial<Record<MenuId, MessageKey>> = {
  home: "nav.home",
  tv: "iptv.title",
  video: "video.title",
  explore: "nav.explore",
  movies: "catalog.movies",
  series: "catalog.series",
  history: "nav.history",
  mine: "tvd.nav.mine",
  new: "newep.title",
  ask: "nav.ask",
  surprise: "nav.surprise",
  search: "catalog.search",
  messages: "tvd.nav.messages",
  settings: "settings.title",
};

/** The chapter of a section (null: not a menu tab, e.g. the profile screen). */
export function chapterOf(section: MenuId | null): { n: number; nameKey: MessageKey } | null {
  if (!section) return null;
  const i = ORDER.indexOf(section);
  const nameKey = CHAPTER_NAME[section];
  return i < 0 || !nameKey ? null : { n: i + 1, nameKey };
}
