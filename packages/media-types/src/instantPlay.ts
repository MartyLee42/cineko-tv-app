// Instant play («Мгновенный старт»): a title page that stays on one target
// (title / episode / release Play would start) for WARM_DELAY_MS asks the
// server to warm it (POST /playback/warm); a new target or leaving the page
// cancels the warm (DELETE /playback/warm). The server keeps the prepared
// source for Play, so pressing Play starts in about a second.

/** What Play would start: the body of POST /playback/warm. */
export interface WarmTarget {
  media_id: string;
  profile_id: string;
  /** The release Play would pick (the client's own ranking), or… */
  release_id?: string;
  /** …the source «Продолжить» plays (the one it was last watched with). */
  source_id?: string;
  episode_id?: string;
  /** The resume position Play starts at (0 / omitted = the start). */
  start_seconds?: number;
}

/** How long a page must stay on one target before it is warmed. */
export const WARM_DELAY_MS = 2000;

/** Equal keys = the same warm (positions within a minute count as the same). */
export function warmKey(t: WarmTarget): string {
  return [t.profile_id, t.media_id, t.episode_id ?? "", t.release_id ?? "", t.source_id ?? "", Math.floor((t.start_seconds ?? 0) / 60)].join("|");
}

export interface WarmerDeps {
  warm(t: WarmTarget): Promise<unknown>;
  cancel(profileId: string): void;
  /** Checked when the delay is over: false = don't warm now (playing, data saver…). */
  allowed?(): boolean;
  delayMs?: number;
  setTimer?(cb: () => void, ms: number): unknown;
  clearTimer?(id: unknown): void;
}

export interface Warmer {
  /** The page's current target; null = nothing to warm (left, loading, no release). */
  set(t: WarmTarget | null): void;
  /** The page is gone: cancel what was warmed. */
  dispose(): void;
}

/** Debounces warms per target and cancels the sent one when the target changes or the page goes. */
export function createWarmer(deps: WarmerDeps): Warmer {
  const setTimer = deps.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const delay = deps.delayMs ?? WARM_DELAY_MS;
  let key: string | null = null;
  let timer: unknown = null;
  let sent: WarmTarget | null = null;

  const stopTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const cancelSent = () => {
    if (!sent) return;
    const profile = sent.profile_id;
    sent = null;
    try {
      deps.cancel(profile);
    } catch {
      // Best effort.
    }
  };

  return {
    set(t) {
      const k = t ? warmKey(t) : null;
      if (k === key) return;
      key = k;
      stopTimer();
      cancelSent();
      if (!t) return;
      timer = setTimer(() => {
        timer = null;
        if (deps.allowed && !deps.allowed()) {
          key = null; // try again on the next change
          return;
        }
        sent = t;
        void deps.warm(t).catch(() => undefined);
      }, delay);
    },
    dispose() {
      this.set(null);
    },
  };
}

/** The browser / TV asks to save data (Network Information API). */
export function saveDataOn(nav: unknown = typeof navigator !== "undefined" ? navigator : undefined): boolean {
  const c = (nav as { connection?: { saveData?: boolean } } | undefined)?.connection;
  return !!c?.saveData;
}
