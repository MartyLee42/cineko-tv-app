// The release sheet's «Rank for: TV | This browser» switch: what a click on a
// row does (watch here or send to a TV) when the user hasn't chosen.
export type ReleaseMode = "tv" | "here";

/**
 * The user's own choice of the switch wins. Else a computer that can play
 * video follows where they watched last (title page «здесь / на ТВ»), and
 * watches here by default (a click on a row used to send it to a TV). Phones
 * keep the TV: they're the remote most of the time (both buttons are on
 * every row anyway).
 */
export function initialReleaseMode(o: { stored: ReleaseMode | null; lastWhere: ReleaseMode | null; desktop: boolean; canPlayHere: boolean }): ReleaseMode {
  if (o.stored) return o.stored;
  if (!o.desktop || !o.canPlayHere) return "tv";
  return o.lastWhere ?? "here";
}

/** A computer: a wide screen with a mouse (not a phone or tablet). */
export function isDesktop(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(min-width: 1024px) and (hover: hover) and (pointer: fine)").matches;
  } catch {
    return false;
  }
}

/** This browser plays ordinary video (H.264 / AAC MP4): «Смотреть здесь» makes sense. */
export function canPlayVideoHere(probe: { canPlayType(type: string): string } | null): boolean {
  if (!probe) return false;
  try {
    return probe.canPlayType('video/mp4; codecs="avc1.640028, mp4a.40.2"') !== "";
  } catch {
    return false;
  }
}
