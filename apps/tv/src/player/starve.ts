// The stall watchdog (pure). TV engines can hang on a dead connection to
// TorrServer: the element says "playing" (or our own «Буферизация» holds
// it), the picture doesn't move and no new data arrives — no event says so,
// and only Stop + Play (a new request) used to help. The controller ticks
// this every 500 ms while the film should play and reopens the stream at
// the spot when nothing moved for too long; a play key on such a stuck
// picture reopens it at once.

/** Nothing moved (picture or data) this long while it should play: reopen the stream. */
export const STARVED_MS = 12_000;
/** …this soon after the viewer resumed a pause (a long pause often leaves a dead connection). */
export const STARVED_AFTER_RESUME_MS = 5_000;
/** How long after a resume the shorter limit applies. */
export const RESUME_WINDOW_MS = 20_000;
/** A «Буферизация» growing so slowly that it is still on after this long: reopen too. */
export const REBUFFER_GIVE_UP_MS = 45_000;
/** OK / ▶ on a picture stuck this long reopens the stream instead of waiting (or pausing). */
export const STUCK_KEY_MS = 2_500;
/** A frozen picture with a "ready" element (stale readyState): the spinner after this long. */
export const FROZEN_SPINNER_MS = 1_500;
/** After a played-out «Буферизация» a native stall stays quiet (no spinner) only this long. */
export const QUIET_SPINNER_MS = 3_000;

export interface StallWatch {
  /** The buffered end around the playhead at the last progress (s). */
  end: number;
  /** Last time the picture moved, new data arrived, or it wasn't meant to play (ms). */
  progressAt: number;
  /** Last time the picture moved or it wasn't meant to play (ms). */
  movedAt: number;
}

export function stallWatch0(now: number): StallWatch {
  return { end: -1, progressAt: now, movedAt: now };
}

/**
 * One tick. `wants`: the film should play now (not the viewer's pause, not
 * ended, not loading); `advancing`: its time moved since the last tick;
 * `end`: the buffered end around the playhead.
 */
export function watchStep(w: StallWatch, o: { wants: boolean; advancing: boolean; end: number; now: number }): StallWatch {
  if (!o.wants || o.advancing) return { end: o.end, progressAt: o.now, movedAt: o.now };
  if (o.end > w.end + 0.1) return { end: o.end, progressAt: o.now, movedAt: w.movedAt };
  return w;
}

/** Reopens in a row without the picture moving wait longer each time (a torrent still finding the piece), up to this. */
export const STARVED_MAX_MS = 60_000;

/**
 * Time to reopen the stream at the spot? `resumedAgoMs`: since the viewer
 * last resumed; `rebufferMs`: our «Буферизация» on that long (else null);
 * `tries`: reopens since the picture last moved (each waits one step
 * longer; the watchdog never fails a playback, it keeps trying).
 */
export function shouldReopen(w: StallWatch, o: { now: number; resumedAgoMs: number; rebufferMs: number | null; tries?: number }): boolean {
  const tries = o.tries ?? 0;
  const base = tries === 0 && o.resumedAgoMs < RESUME_WINDOW_MS ? STARVED_AFTER_RESUME_MS : STARVED_MS;
  const limit = Math.min(STARVED_MAX_MS, base * (1 + tries));
  return o.now - w.progressAt >= limit || (tries === 0 && o.rebufferMs !== null && o.rebufferMs >= REBUFFER_GIVE_UP_MS);
}

/**
 * OK / ▶ while the film should play but is stuck: reopen the stream now?
 * Yes when the picture hasn't moved for STUCK_KEY_MS and either the engine
 * isn't ready (readyState < 3) with no new data for as long, or it claims
 * to be ready but doesn't move (wedged).
 */
export function keyReopens(w: StallWatch, o: { now: number; readyState: number }): boolean {
  if (o.now - w.movedAt < STUCK_KEY_MS) return false;
  return o.readyState >= 3 || o.now - w.progressAt >= STUCK_KEY_MS;
}

/**
 * The spinner over the picture: the film should play (not the viewer's
 * pause) and doesn't move. Seeking / not ready: at once (a short native
 * stall after a played-out «Буферизация» stays quiet for QUIET_SPINNER_MS);
 * "ready" but frozen: after FROZEN_SPINNER_MS.
 */
export function spinnerWanted(o: { userPaused: boolean; advancing: boolean; seeking: boolean; readyState: number; quiet: boolean; stuckMs: number }): boolean {
  if (o.userPaused || o.advancing) return false;
  if (o.seeking || o.readyState < 3) return !(o.quiet && !o.seeking && o.stuckMs < QUIET_SPINNER_MS);
  return o.stuckMs >= FROZEN_SPINNER_MS;
}
