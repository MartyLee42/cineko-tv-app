// Play-on-TV state machine (pure; effects are injected by the controller).
//
//   request ─▶ picking ─pick─▶ [player] ─▶ sending ─▶ done
//                 (auto) ───────┘              │  busy
//                                               ▼
//                              confirm ─confirm─▶ sending (force)
// [player]: only when the TV has several players and no default (or "Play with…").
//
// The phone does no release search and creates no source: media.play goes to
// the TV at once (media id, episode, the chosen release if any, position) and
// the TV shows its loading screen right away, searching / preparing for itself.
// After "done", the toast follows the TV's device state (PlaybackState.loading).
import type { PlayerKind } from "@martytv/contracts";
import type { Choice, Outcome } from "../remote/logic";
import type { PlayerDecision } from "./players";
import type { ReleaseTarget } from "./releases";

export interface PlayRequest extends ReleaseTarget {
  /** Release.id to play; omitted → the TV picks its best release itself. */
  release_id?: string;
  /** For toasts: "Dune: Part Two", "S01E02 · Pilot". */
  label: string;
  /** TV player for media.play; omitted → the TV's default. */
  player?: PlayerKind;
  /** "Play with…": ask for the player even when the TV has a default. */
  askPlayer?: boolean;
  /** Resume position for media.play (0 = start over; omitted → the TV decides). */
  position_seconds?: number;
  /** Online variants: wanted quality (omitted → best ≤ the profile's resolution). */
  quality?: number;
}

export type PlayError = { scope: "command"; code: string };

export type PlayOutcome = { kind: "sent" } | { kind: "queued" } | ({ kind: "error" } & PlayError);

type Base = { req: PlayRequest; deviceId: string };

export type PlayFlow =
  | { step: "idle" }
  | { step: "picking"; req: PlayRequest; preferred: string | null }
  | ({ step: "player"; options: PlayerKind[]; preselected: PlayerKind } & Base)
  | ({ step: "sending"; force: boolean } & Base)
  | ({ step: "confirm" } & Base)
  | ({ step: "done"; outcome: PlayOutcome } & Base);

export type PlayAction =
  /** `player`: the decision for the auto-chosen TV (ignored when a picker opens). */
  | { type: "request"; req: PlayRequest; choice: Choice; player?: PlayerDecision }
  | { type: "pick"; deviceId: string; player?: PlayerDecision }
  | { type: "player"; player: PlayerKind }
  | { type: "outcome"; outcome: Outcome }
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "dismiss" };

export const PLAY_IDLE: PlayFlow = { step: "idle" };

/** Steps with a request in flight: new requests are ignored meanwhile (no double plays). */
export function isBusy(f: PlayFlow): boolean {
  return f.step === "sending";
}

function start(req: PlayRequest, deviceId: string, decision?: PlayerDecision): PlayFlow {
  if (decision?.kind === "ask") return { step: "player", req, deviceId, options: decision.options, preselected: decision.preselected };
  if (decision?.player) req = { ...req, player: decision.player };
  return { step: "sending", req, deviceId, force: false };
}

export function playReducer(s: PlayFlow, a: PlayAction): PlayFlow {
  switch (a.type) {
    case "request":
      if (isBusy(s)) return s;
      if (a.choice.kind === "auto") return start(a.req, a.choice.deviceId, a.player);
      return { step: "picking", req: a.req, preferred: a.choice.kind === "pick" ? a.choice.preferred : null };
    case "pick":
      return s.step === "picking" ? start(s.req, a.deviceId, a.player) : s;
    case "player":
      return s.step === "player" ? start({ ...s.req, player: a.player }, s.deviceId) : s;
    case "outcome": {
      if (s.step !== "sending") return s;
      const o = a.outcome;
      if (o.kind === "busy" && !s.force) return { step: "confirm", req: s.req, deviceId: s.deviceId };
      const outcome: PlayOutcome =
        o.kind === "busy"
          ? { kind: "error", scope: "command", code: "busy_playing" }
          : o.kind === "error"
            ? { kind: "error", scope: "command", code: o.code }
            : o;
      return { step: "done", req: s.req, deviceId: s.deviceId, outcome };
    }
    case "confirm":
      return s.step === "confirm" ? { step: "sending", req: s.req, deviceId: s.deviceId, force: true } : s;
    case "cancel":
      return s.step === "picking" || s.step === "player" || s.step === "confirm" ? PLAY_IDLE : s;
    case "dismiss":
      return s.step === "done" ? PLAY_IDLE : s;
  }
}

/** The media.play payload for a request: ids only — the TV searches / prepares itself. */
export function playPayload(req: PlayRequest, force: boolean) {
  return {
    media_id: req.media_id,
    ...(req.episode_id && { episode_id: req.episode_id }),
    ...(req.release_id && { release_id: req.release_id }),
    ...(req.release_id && req.quality != null && { quality: req.quality }),
    ...(req.player && { player: req.player }),
    ...(req.position_seconds != null && { position_seconds: req.position_seconds }),
    ...(force && { force: true }),
  };
}

export interface PlayEffects {
  /** media.play (with a fresh command id per call, force on the confirmed resend). */
  send: (s: Extract<PlayFlow, { step: "sending" }>) => Promise<PlayAction>;
}

/**
 * Runs the flow outside React state so a double tap sees the in-flight step
 * synchronously; the send runs exactly once per entry into "sending".
 */
export function createPlayController(onChange: (f: PlayFlow) => void, fx: PlayEffects) {
  let current: PlayFlow = PLAY_IDLE;
  const dispatch = (a: PlayAction) => {
    const next = playReducer(current, a);
    if (next === current) return;
    current = next;
    onChange(next);
    if (next.step !== "sending") return;
    // Effects map their own errors; this only guards against a bug leaving the flow stuck.
    const fallback: PlayAction = { type: "outcome", outcome: { kind: "error", code: "failed" } };
    void fx.send(next).then(dispatch, () => dispatch(fallback));
  };
  return { dispatch, get: () => current };
}

// ---------------------------------------------------------------- following the TV

export type TvProgress =
  /** media.play acked; the TV hasn't reported this title yet. */
  | { kind: "opening" }
  | { kind: "searching" }
  | { kind: "loading"; stage: string; pct: number; peers: number | null; seeders: number | null; speed: number | null; buffered: number | null; release: string | null }
  | { kind: "playing" }
  | { kind: "failed"; code: string }
  /** The TV moved on to something else (another title, closed the player). */
  | { kind: "gone" };

interface TvStateLite {
  screen?: string;
  media_id?: string | null;
  player_error?: string | null;
  playback?: {
    media_id: string;
    episode_id?: string | null;
    buffering: boolean;
    loading?: {
      stage: string;
      progress: number;
      release?: string | null;
      peers?: number | null;
      seeders?: number | null;
      download_speed_bps?: number | null;
      preloaded_bytes?: number | null;
    } | null;
  } | null;
}

/**
 * What the TV is doing with our media.play, from its device state. `seen`:
 * whether this title already showed on the TV since the send (so "nothing
 * about it" afterwards means the user left the player, not "not there yet").
 */
export function tvProgress(req: Pick<PlayRequest, "media_id" | "episode_id">, st: TvStateLite | null | undefined, seen: boolean): TvProgress {
  if (!st) return { kind: "opening" };
  const p = st.playback;
  const ours = !!p && p.media_id === req.media_id && (!req.episode_id || !p.episode_id || p.episode_id === req.episode_id);
  if (ours && p) {
    const l = p.loading;
    if (l && l.stage === "rebuffering") return { kind: "playing" };
    if (l && (l.stage === "resolving" || l.stage === "searching")) return { kind: "searching" };
    if (l) {
      return {
        kind: "loading",
        stage: l.stage,
        pct: Math.max(0, Math.min(99, Math.round(l.progress * 100))),
        peers: l.peers ?? null,
        seeders: l.seeders ?? null,
        speed: l.download_speed_bps ?? null,
        buffered: l.preloaded_bytes ?? null,
        release: l.release ?? null,
      };
    }
    // Older TVs: no `loading` block — buffering still counts as loading.
    return p.buffering ? { kind: "loading", stage: "starting", pct: 0, peers: null, seeders: null, speed: null, buffered: null, release: null } : { kind: "playing" };
  }
  if (st.screen === "player" && st.media_id === req.media_id && st.player_error) return { kind: "failed", code: st.player_error };
  return seen ? { kind: "gone" } : { kind: "opening" };
}

/** The most the phone has shown for one play request (see holdTvProgress). */
export interface TvPeak {
  pct: number;
  buffered: number;
}

/**
 * The TV's loading percentage and buffered bytes never go back on the phone:
 * a stall right after the first frame reports «buffering» with no loading
 * block (pct 0), and TorrServer's preloaded bytes drop when the TV reads
 * from another position. `peak` (per request) is updated in place.
 */
export function holdTvProgress(p: TvProgress, peak: TvPeak): TvProgress {
  if (p.kind !== "loading") return p;
  peak.pct = Math.max(peak.pct, p.pct);
  peak.buffered = Math.max(peak.buffered, p.buffered ?? 0);
  return { ...p, pct: peak.pct, buffered: p.buffered == null && peak.buffered === 0 ? null : peak.buffered };
}
