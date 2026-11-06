// iPad → the touch web app (tap, the normal keyboard). MSX on iPad opens
// /tv/ as a page, so the web app's sign-in works there too.
// «Версия для ТВ» in the web app comes back with ?ui=tv (this session only).

const FORCE_KEY = "martytv.ui_tv";

export function isIPad(ua: string, touchPoints: number, touchEvents = false): boolean {
  // iPadOS 13+ reports a Mac UA; a touch screen (or touch events, which Mac
  // Safari lacks) gives it away.
  return /iPad/.test(ua) || (/Macintosh/.test(ua) && (touchPoints > 0 || touchEvents));
}

/** Where to go instead of the TV app, or null to stay. */
export function tabletRedirect(loc: { search: string }, ua: string, touchPoints: number, touchEvents: boolean, session: Pick<Storage, "getItem" | "setItem">): string | null {
  const ui = new URLSearchParams(loc.search).get("ui");
  try {
    if (ui === "tv") session.setItem(FORCE_KEY, "1");
    if (ui === "tv" || session.getItem(FORCE_KEY) === "1") return null;
  } catch {
    if (ui === "tv") return null;
  }
  return isIPad(ua, touchPoints, touchEvents) ? "/?via=tv" : null;
}
