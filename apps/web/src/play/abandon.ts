// Leaving a title while it still loads must abandon the load: nothing may
// navigate to the player or start playing afterwards, and the server stops
// preparing (DELETE /playback/sources/{id}, which also removes a torrent it
// added just for this and nothing else uses).

/** One preparation run: `live()` turns false once it was superseded or cancelled. */
export interface Run {
  signal: AbortSignal;
  live: () => boolean;
}

/**
 * "Latest request wins": `begin()` aborts the previous run, `cancel()` the
 * current one. Every step after an await checks `run.live()` before acting.
 */
export function createLatest() {
  let ctl: AbortController | null = null;
  return {
    begin(): Run {
      ctl?.abort();
      const c = new AbortController();
      ctl = c;
      return { signal: c.signal, live: () => ctl === c && !c.signal.aborted };
    },
    cancel() {
      ctl?.abort();
      ctl = null;
    },
  };
}

/**
 * Cancels a loading source on the server when its page goes away. The
 * cancel waits a tick and is dropped when the page comes back meanwhile
 * (React StrictMode unmounts and remounts every component once in dev).
 */
export function createLeaveGuard(cancel: (id: string) => void, defer: (f: () => void) => void = (f) => void setTimeout(f, 0)) {
  let gen = 0;
  return {
    /** The page is (again) on screen: pending cancels are dropped. */
    enter() {
      gen++;
    },
    /** The page went away; `id`: the source still loading there (null: nothing to cancel). */
    leave(id: string | null) {
      const g = ++gen;
      if (id) defer(() => g === gen && cancel(id));
    },
  };
}

/**
 * The source to cancel when the watch page goes away: one still loading
 * (preparing, or ready with no first frame yet), not one on the fallback
 * screen — that may be handed to a TV («Смотреть на ТВ»), which reuses it.
 */
export function loadingSourceId(s: { id: string; status: string; kind?: string | null } | null, covered: boolean, fallback: boolean): string | null {
  if (!s || !covered || fallback) return null;
  if ((s.kind ?? "torrent") !== "torrent") return null;
  return s.status === "preparing" || s.status === "ready" ? s.id : null;
}
