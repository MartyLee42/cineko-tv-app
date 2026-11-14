/**
 * Cut-off streams make TV engines fire "ended" or skip far ahead. These pure
 * checks decide when that is a broken stream rather than the real end.
 */

/** A forward jump bigger than this without a seek means a broken stream. */
export const JUMP_LIMIT = 30;

/**
 * True when the last trusted position is close to the file's real length.
 * The server's ffprobe duration wins over the engine's, which a truncated
 * stream can shorten. Unknown length: trust the engine.
 */
export function isRealEnd(trusted: number, serverDuration: number | null | undefined, engineDuration: number | null): boolean {
  const total = serverDuration && serverDuration > 0 ? serverDuration : engineDuration;
  if (!total || total <= 0) return true;
  return trusted >= total - Math.max(90, total * 0.03);
}

/** True when the position moved far ahead although nobody seeked. */
export function isUnexplainedJump(position: number, lastGood: number, seekAllowed: boolean): boolean {
  return !seekAllowed && position > lastGood + JUMP_LIMIT;
}

/**
 * True when the position fell far back although nobody seeked: the engine
 * restarted the stream from the start after a stall (seen on TVs). Without
 * this the next progress report would save ~0 and lose the resume point.
 */
export function isUnexplainedDrop(position: number, lastGood: number, seekAllowed: boolean): boolean {
  return !seekAllowed && position < lastGood - JUMP_LIMIT;
}

/**
 * A seek made before the engine could play (the start position, a seek
 * while loading) that it silently dropped: once it plays, it is far from
 * the target (Android's native player, some TV engines, start at 0).
 */
export function seekMissed(current: number, target: number): boolean {
  if (!Number.isFinite(current)) return false;
  return current < target - 10 || current > target + 30;
}

/** True when `position` is far past where the last load / seek was meant to land. */
export function beyondTarget(position: number, target: number | null): boolean {
  return target !== null && position > target + JUMP_LIMIT;
}

/**
 * The position the player shows (and reports): the engine's time, except
 *  - within a seek's window, while the engine hasn't reached the target yet
 *    (it reads 0 before a start seek lands, or the old spot): the target;
 *  - an unexplained jump / drop (a broken stream: the engine leapt to the
 *    end or restarted at 0): the last trusted position.
 * Before, the raw time showed: the bar flicked between 0 and the resume
 * spot on start, and ran to the end of the film when the network dropped.
 */
export function shownPosition(o: { time: number; lastGood: number; target: number | null; seekWindow: boolean }): number {
  const { time, lastGood, target, seekWindow } = o;
  if (!Number.isFinite(time)) return target ?? lastGood;
  if (seekWindow) {
    if (target !== null && Math.abs(time - target) > JUMP_LIMIT) return target;
    return time;
  }
  if (isUnexplainedJump(time, lastGood, false) || isUnexplainedDrop(time, lastGood, false)) return lastGood;
  return time;
}

/**
 * The engine's length is much shorter than the server's ffprobe length: a
 * stream cut off mid-way (the network dropped) that the engine took for the
 * whole file.
 */
export function truncatedLength(engine: number, probed: number | null | undefined): boolean {
  return !!probed && probed > 0 && engine < probed * 0.9;
}

/** Seconds of good playback after which a decode error is no longer about the codec. */
export const DECODED_FINE_S = 60;

/**
 * A MEDIA_ERR_DECODE / SRC_NOT_SUPPORTED that is really a broken stream:
 * this stream already decoded fine for a while (`playedS` since its load),
 * or the device says it is offline. Tizen reports a dead link mid-film as
 * MEDIA_ERR_DECODE: it used to restart the film in compat mode (at the
 * engine's bogus position — the end of the film) or call it unplayable.
 */
export function decodeErrorIsNetwork(code: number, playedS: number, online: boolean): boolean {
  if (code !== 3 && code !== 4) return false;
  return !online || playedS >= DECODED_FINE_S;
}
