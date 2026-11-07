// Where the TV was when a chunk reload (chunkReload.ts) cut in: the title being
// started or played (as a media.play the app runs again after boot, at the
// same spot and source), else the Details on top. sessionStorage, read once,
// and only fresh: a later manual restart never jumps into a film.
import type { Flow } from "./player/session";
import type { OpenRequest, PlayRequest } from "./remote/commands";

export const RESUME_KEY = "martytv.resume_after_reload";
/** A resume older than this (the reload never came back quickly) is dropped. */
export const RESUME_TTL_MS = 2 * 60_000;

export type Resume = { play: PlayRequest } | { open: OpenRequest };

/**
 * The play request that restarts `flow` where it is (`position`: the player's
 * position while playing). Null when nothing is being started or played.
 */
export function playToResume(flow: Flow, position: number): PlayRequest | null {
  if (flow.phase !== "preparing" && flow.phase !== "playing" && flow.phase !== "choose") return null;
  const ctx = flow.ctx;
  const req: PlayRequest = { media_id: ctx.media_id };
  if (ctx.episode_id) req.episode_id = ctx.episode_id;
  const source = flow.phase === "choose" ? null : flow.source;
  if (source) req.source_id = source.id;
  else if (flow.release) req.release_id = flow.release.id;
  const at = flow.phase === "playing" && position > 0 ? position : flow.phase === "choose" ? (ctx.start_at ?? 0) : flow.startAt;
  if (at > 0) req.position_seconds = Math.floor(at);
  if (ctx.player) req.player = ctx.player;
  return req;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function store(): Store | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function saveResume(r: Resume | null, now = Date.now(), s: Store | null = store()): void {
  try {
    if (r) s?.setItem(RESUME_KEY, JSON.stringify({ ...r, at: now }));
    else s?.removeItem(RESUME_KEY);
  } catch {
    // private mode / full: start fresh after the reload
  }
}

/** The saved resume (removed as it's read), or null when none / stale / malformed. */
export function takeResume(now = Date.now(), s: Store | null = store()): Resume | null {
  let raw: string | null;
  try {
    raw = s?.getItem(RESUME_KEY) ?? null;
    if (raw !== null) s?.removeItem(RESUME_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { at?: unknown; play?: Partial<PlayRequest>; open?: Partial<OpenRequest> };
    const at = Number(v.at);
    if (!Number.isFinite(at) || now - at > RESUME_TTL_MS || now < at) return null;
    if (v.play && typeof v.play.media_id === "string" && v.play.media_id) return { play: v.play as PlayRequest };
    if (v.open && typeof v.open.media_id === "string" && v.open.media_id) return { open: v.open as OpenRequest };
  } catch {
    // malformed
  }
  return null;
}
