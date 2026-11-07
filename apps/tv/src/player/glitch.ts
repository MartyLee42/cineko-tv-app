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
