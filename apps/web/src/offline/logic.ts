// «На устройстве»: pure pieces of device downloads (tested in offline.test.ts) —
// the job state machine, what to save (original file or compat MP4), the
// space check, chunk / Range bookkeeping and error classification.
import { compatFixes, type CompatPref } from "../player/compat";

/** Videos are stored as fixed-size chunks (bounded memory, resumable). */
export const CHUNK = 8 * 1024 * 1024;

// ---------------------------------------------------------------- state machine

export type DeviceStatus = "queued" | "preparing" | "downloading" | "paused" | "failed" | "saved";

export type DeviceError =
  | "quota" // not enough space (estimate, or QuotaExceededError)
  | "storage" // the browser refused storage (private mode, blocked site data)
  | "format" // nothing this browser can play offline (and compat can't fix it)
  | "network" // the connection dropped
  | "offline" // no connection at all (resumes on "online")
  | "source" // couldn't prepare the release (code in errorCode)
  | "no_releases"
  | "expired" // the stream link expired / the server forgot the source
  | "server" // HTTP error from the server / transcoder
  | "incomplete" // the stream ended before the whole file arrived
  | "failed";

export interface JobState {
  status: DeviceStatus;
  bytes: number;
  /** Expected bytes (null: unknown — the compat stream has no length). */
  total: number | null;
  /** Complete chunks stored (original files resume after them). */
  chunks: number;
  error?: DeviceError;
  /** Extra detail: a source error code, or sizes for "quota". */
  errorCode?: string;
  errorVars?: Record<string, string | number>;
  /** Automatic resume attempts since the last progress. */
  attempts: number;
}

export type JobEvent =
  | { type: "prepare" }
  | { type: "start"; total: number | null; restart: boolean }
  | { type: "chunk"; chunks: number; bytes: number }
  | { type: "progress"; bytes: number }
  | { type: "done"; bytes: number }
  | { type: "fail"; error: DeviceError; code?: string; vars?: Record<string, string | number>; keepChunks: boolean }
  | { type: "pause"; keepChunks: boolean }
  | { type: "retry" };

export const NEW_JOB: JobState = { status: "queued", bytes: 0, total: null, chunks: 0, attempts: 0 };

/** The state without its error fields. */
const clean = (s: JobState): JobState => {
  const rest = { ...s };
  delete rest.error;
  delete rest.errorCode;
  delete rest.errorVars;
  return rest;
};

/** queued → preparing → downloading → saved; failed / paused (interrupted) → retry → queued. */
export function jobReducer(s: JobState, e: JobEvent): JobState {
  switch (e.type) {
    case "prepare":
      return s.status === "queued" ? { ...clean(s), status: "preparing" } : s;
    case "start":
      if (s.status !== "preparing") return s;
      return e.restart
        ? { ...clean(s), status: "downloading", total: e.total, chunks: 0, bytes: 0 }
        : { ...clean(s), status: "downloading", total: e.total, bytes: s.chunks * CHUNK };
    case "chunk":
      return s.status === "downloading" ? { ...s, chunks: e.chunks, bytes: e.bytes, attempts: 0 } : s;
    case "progress":
      return s.status === "downloading" ? { ...s, bytes: e.bytes } : s;
    case "done":
      return s.status === "downloading" ? { ...clean(s), status: "saved", bytes: e.bytes, total: e.bytes, attempts: 0 } : s;
    case "fail":
      if (s.status === "saved") return s;
      return {
        ...s,
        status: "failed",
        error: e.error,
        ...(e.code && { errorCode: e.code }),
        ...(e.vars && { errorVars: e.vars }),
        ...(!e.keepChunks && { chunks: 0, bytes: 0 }),
      };
    case "pause":
      if (s.status === "saved" || s.status === "failed") return s;
      return { ...clean(s), status: "paused", ...(!e.keepChunks && { chunks: 0, bytes: 0 }) };
    case "retry":
      return s.status === "failed" || s.status === "paused" ? { ...clean(s), status: "queued", attempts: 0 } : s;
  }
}

/** Busy statuses (a running or waiting job): no second start. */
export function isRunning(s: DeviceStatus): boolean {
  return s === "queued" || s === "preparing" || s === "downloading";
}

/** 0…100 for the progress bar; null when the size is unknown (compat). */
export function percentOf(s: Pick<JobState, "status" | "bytes" | "total">): number | null {
  if (s.status === "saved") return 100;
  if (!s.total || s.total <= 0) return null;
  return Math.max(0, Math.min(99, Math.floor((s.bytes / s.total) * 100)));
}

/** Network errors on resumable files are retried this many times automatically. */
export const AUTO_RETRIES = 4;

/** Wait before automatic attempt n (1-based): 3 s, 10 s, 30 s, 60 s. */
export function retryDelay(attempt: number): number {
  return [3000, 10_000, 30_000, 60_000][Math.min(Math.max(attempt, 1), 4) - 1]!;
}

/** Retry by itself? Only resumable (original) files, only network-ish errors, a few times. */
export function shouldAutoRetry(error: DeviceError, mode: SaveMode, attempts: number): boolean {
  return mode === "original" && (error === "network" || error === "incomplete" || error === "expired") && attempts < AUTO_RETRIES;
}

// ---------------------------------------------------------------- what to save

export type SaveMode = "original" | "compat";

interface SupportLike {
  verdict: "playable" | "maybe" | "unlikely";
  noAudio: boolean;
  reasons: readonly { code: string; severity: "info" | "maybe" | "unlikely" }[];
}

export type ModeChoice = { mode: "original" } | { mode: "compat"; video: boolean } | { mode: null; reason: "format" };

/**
 * What to save so that this browser plays it offline: the original file when
 * it plays as is; the compat stream (MP4, audio → AAC; old video codecs →
 * H.264 when the server can) when that fixes it; else nothing.
 * `pref` is the player's «Совместимый режим» setting (on: always compat).
 */
export function chooseMode(o: { support: SupportLike | null; compatUrl: string | null | undefined; compatVideo?: boolean; pref: CompatPref }): ModeChoice {
  const s = o.support;
  const problems = s ? s.reasons.filter((r) => r.severity !== "info") : [];
  const videoBad = problems.some((r) => r.code === "video");
  if (o.compatUrl && o.pref !== "off") {
    if (o.pref === "on") return { mode: "compat", video: videoBad && !!o.compatVideo };
    if (s && compatFixes(s)) return { mode: "compat", video: false };
    // Old video codecs (XviD, MPEG-2…): the transcoder re-encodes them.
    if (videoBad && o.compatVideo && problems.every((r) => r.code === "video" || r.code === "no_audio" || r.code === "container" || r.code === "container_maybe"))
      return { mode: "compat", video: true };
  }
  if (!s || s.verdict !== "unlikely") return { mode: "original" };
  return { mode: null, reason: "format" };
}

// ---------------------------------------------------------------- space

export type SpaceVerdict = { ok: true } | { ok: false; need: number; free: number };

/**
 * Enough room for `need` more bytes? Unknown estimates pass (the write fails
 * with QuotaExceededError later). Keeps a small margin for the rest of the app.
 */
export function checkSpace(est: { quota?: number; usage?: number } | null, need: number | null): SpaceVerdict {
  if (!est || !need || need <= 0 || !est.quota || !Number.isFinite(est.quota)) return { ok: true };
  const free = Math.max(0, est.quota - (est.usage ?? 0));
  const margin = 50 * 1024 * 1024;
  return free >= need + margin ? { ok: true } : { ok: false, need: need + margin, free };
}

// ---------------------------------------------------------------- ranges

/** "bytes 100-199/1000" → { start, end, total } (total null for "*"). */
export function parseContentRange(h: string | null | undefined): { start: number; end: number; total: number | null } | null {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec((h ?? "").trim());
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === "*" ? null : Number(m[3]) };
}

/**
 * A resumed request (Range: bytes=offset-) answered: continue, restart from
 * zero (the server ignored the Range), or fail (wrong range / size changed).
 */
export function resumeCheck(
  o: { offset: number; status: number; contentRange: string | null; contentLength: number | null; expectedTotal: number | null },
): { kind: "continue"; total: number | null } | { kind: "restart"; total: number | null } | { kind: "mismatch" } {
  if (o.offset === 0) {
    const total = o.status === 206 ? (parseContentRange(o.contentRange)?.total ?? null) : o.contentLength;
    return { kind: "restart", total };
  }
  if (o.status === 200) return { kind: "restart", total: o.contentLength };
  const cr = parseContentRange(o.contentRange);
  if (o.status !== 206 || !cr || cr.start !== o.offset) return { kind: "mismatch" };
  if (o.expectedTotal != null && cr.total != null && cr.total !== o.expectedTotal) return { kind: "mismatch" };
  return { kind: "continue", total: cr.total ?? o.expectedTotal };
}

// ---------------------------------------------------------------- errors

/** An exception from fetch / Cache Storage → a device error. */
export function classifyError(err: unknown, online = true): DeviceError {
  const name = (err as { name?: string } | null)?.name ?? "";
  const msg = String((err as { message?: string } | null)?.message ?? "");
  if (name === "QuotaExceededError" || /quota/i.test(msg)) return "quota";
  if (name === "SecurityError" || name === "NotAllowedError") return "storage";
  if (!online) return "offline";
  if (name === "TypeError" || /network|fetch|load failed/i.test(msg)) return "network";
  return "failed";
}

/** An HTTP status from the stream → a device error. */
export function httpError(status: number): DeviceError {
  if (status === 403 || status === 404 || status === 410) return "expired";
  if (status === 0) return "network";
  return "server";
}
