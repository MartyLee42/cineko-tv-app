// «Где смотреть»: what the title page's play button offers when it is
// pressed — this device or one of the TVs. Pure helpers for PlayChooser.
import type { DeviceLite } from "../remote/logic";
import type { WatchWhere } from "../player/session";

export interface ChooserTv extends DeviceLite {
  /** The TV shows this title right now. */
  playing: boolean;
}

/** Key of a chooser target: "here" or "tv:<device id>". */
export type ChooserKey = "here" | `tv:${string}`;

/**
 * TV order in the chooser: the one showing this title first, then online TVs
 * (the last used one first), then offline ones; by name within a group.
 */
export function orderChooserTvs<T extends ChooserTv>(tvs: T[], lastUsed: string | null): T[] {
  const rank = (d: T) => (d.playing && d.online ? 0 : d.online ? (d.id === lastUsed ? 1 : 2) : 3);
  return [...tvs].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/**
 * The target focused when the chooser opens, so Enter repeats the last
 * choice: «here» when that was it (or no TV is online); else the last used
 * TV if online, else the TV showing this title, else the first online one.
 */
export function preselectTarget(tvs: ChooserTv[], lastUsed: string | null, where: WatchWhere | null): ChooserKey {
  const online = tvs.filter((d) => d.online);
  if (where === "here" || !online.length) return "here";
  const tv = online.find((d) => d.id === lastUsed) ?? online.find((d) => d.playing) ?? online[0]!;
  return `tv:${tv.id}`;
}

/**
 * Pressing play: with no TV at all (and no way to reach one) there is
 * nothing to choose — play here straight away. While the device list is
 * still loading the chooser opens (it fills in).
 */
export function skipChooser(tvs: DeviceLite[] | undefined, canReachOthers: boolean): boolean {
  return !!tvs && tvs.length === 0 && !canReachOthers;
}
