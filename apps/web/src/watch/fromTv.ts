// The TV app sends iPads here with ?via=tv (apps/tv/src/tablet.ts). We keep
// the history position so «Вернуться в MSX» can step back out of the app.

const KEY = "martytv.via_tv";

/** Call once at boot: remembers the hand-off and drops the query param. */
export function captureFromTv(): void {
  const url = new URL(location.href);
  if (url.searchParams.get("via") !== "tv") return;
  try {
    sessionStorage.setItem(KEY, String(history.length));
  } catch {
    // no session storage: the menu items just stay hidden
  }
  url.searchParams.delete("via");
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
}

/** Opened from the TV app (MSX on an iPad) in this session? */
export function cameFromTv(): boolean {
  try {
    return sessionStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

/** Back to whatever opened the TV app (MSX). */
export function leaveToTvHost(): void {
  const entry = Number(sessionStorage.getItem(KEY) ?? history.length);
  history.go(-Math.max(1, history.length - entry + 1));
}

/** The TV interface, for this session. */
export function openTvVersion(): void {
  location.href = "/tv/?ui=tv";
}
