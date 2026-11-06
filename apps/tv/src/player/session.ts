// The playback flow as a pure reducer: release picker → source preparation →
// playing, with failures that lead back to the picker or another release.
import type { MediaKind, PlaybackSource, PlayerKind, Release } from "@martytv/contracts";
import type { ExternalApp } from "../players/select";

/** What is being played. */
export interface PlayContext {
  media_id: string;
  kind: MediaKind;
  title: string;
  poster_path: string | null;
  backdrop_path: string | null;
  /** Series only. */
  season: number | null;
  episode: number | null;
  episode_id: string | null;
  episode_name: string | null;
  profile_id: string;
  lang: "en" | "ru";
  /** Which player opens the stream (null until chosen). */
  player: PlayerKind | null;
  /** External player: which Android app. */
  app: ExternalApp | null;
  /** Where to start (resume); 0 / absent = the beginning. */
  start_at?: number;
}

interface Attempts {
  /** Release ids that failed for this title/episode. */
  tried: string[];
  /** Codec keys that failed on this TV (e.g. hevc, dts). */
  avoid: string[];
}

export type PrepStep = "resolving" | "searching" | "preparing";

export type Flow =
  | { phase: "idle" }
  | ({ phase: "picker"; ctx: PlayContext } & Attempts)
  /** "Play with…": choosing the player before preparing. */
  | ({ phase: "choose"; ctx: PlayContext; release: Release | null; auto: boolean } & Attempts)
  | ({
      phase: "preparing";
      ctx: PlayContext;
      step: PrepStep;
      release: Release | null;
      source: PlaybackSource | null;
      startAt: number;
      /** Started without the picker (remote media.play, next episode). */
      auto: boolean;
    } & Attempts)
  | ({ phase: "playing"; ctx: PlayContext; release: Release; source: PlaybackSource; startAt: number; auto: boolean } & Attempts)
  | ({
      phase: "failed";
      ctx: PlayContext;
      /** error: preparing failed (code = player.error.*); unplayable: the TV can't decode it. */
      kind: "error" | "unplayable";
      code: string;
      /** Unplayable: what failed, e.g. "HEVC, DTS". */
      reason: string | null;
      release: Release | null;
      auto: boolean;
    } & Attempts);

export type FlowAction =
  | { type: "pick"; ctx: PlayContext }
  | { type: "choose"; ctx: PlayContext; release: Release | null; auto: boolean }
  | { type: "start"; ctx: PlayContext; release: Release | null; startAt?: number; auto: boolean; step?: PrepStep }
  | { type: "step"; step: PrepStep }
  | { type: "chosen"; release: Release }
  | { type: "source"; source: PlaybackSource }
  | { type: "fail"; code: string }
  | { type: "unplayable"; reason: string; avoid: string[]; code?: "unplayable" | "no_audio" }
  | { type: "ctx"; patch: Partial<PlayContext> }
  | { type: "back" }
  | { type: "another" }
  | { type: "close" };

export const IDLE: Flow = { phase: "idle" };

export function sameTarget(a: PlayContext, b: PlayContext): boolean {
  return a.media_id === b.media_id && a.season === b.season && a.episode === b.episode;
}

/** Failed releases are per episode; codecs this TV can't play are per title. */
function attempts(prev: Flow, ctx: PlayContext): Attempts {
  if (prev.phase === "idle" || prev.ctx.media_id !== ctx.media_id) return { tried: [], avoid: [] };
  return { tried: sameTarget(prev.ctx, ctx) ? prev.tried : [], avoid: prev.avoid };
}

function add(list: readonly string[], items: readonly (string | null | undefined)[]): string[] {
  const out = [...list];
  for (const i of items) if (i && !out.includes(i)) out.push(i);
  return out;
}

export function reduceFlow(s: Flow, a: FlowAction): Flow {
  switch (a.type) {
    case "pick":
      return { phase: "picker", ctx: a.ctx, ...attempts(s, a.ctx) };
    case "choose":
      return { phase: "choose", ctx: a.ctx, release: a.release, auto: a.auto, ...attempts(s, a.ctx) };
    case "start":
      return {
        phase: "preparing",
        ctx: a.ctx,
        step: a.step ?? (a.release ? "preparing" : "searching"),
        release: a.release,
        source: null,
        startAt: Math.max(0, a.startAt ?? 0),
        auto: a.auto,
        ...attempts(s, a.ctx),
      };
    case "step":
      return s.phase === "preparing" ? { ...s, step: a.step } : s;
    case "chosen":
      return s.phase === "preparing" ? { ...s, step: "preparing", release: a.release } : s;
    case "source": {
      const src = a.source;
      if (s.phase === "playing") return src.id === s.source.id && src.status === "ready" ? { ...s, source: src } : s;
      if (s.phase !== "preparing") return s;
      const release = s.release ?? src.release;
      if (src.status === "error") {
        return { phase: "failed", ctx: s.ctx, kind: "error", code: src.error || "generic", reason: null, release, auto: s.auto, tried: add(s.tried, [release.id]), avoid: s.avoid };
      }
      if (src.status === "ready" && src.stream_url) {
        return { phase: "playing", ctx: s.ctx, release, source: src, startAt: s.startAt, auto: s.auto, tried: s.tried, avoid: s.avoid };
      }
      return { ...s, step: "preparing", release, source: src };
    }
    case "fail": {
      if (s.phase !== "preparing" && s.phase !== "playing") return s;
      const release = s.release;
      return { phase: "failed", ctx: s.ctx, kind: "error", code: a.code, reason: null, release, auto: s.auto, tried: add(s.tried, [release?.id]), avoid: s.avoid };
    }
    case "unplayable":
      if (s.phase !== "playing" && s.phase !== "preparing") return s;
      return {
        phase: "failed",
        ctx: s.ctx,
        kind: "unplayable",
        code: a.code ?? "unplayable",
        reason: a.reason,
        release: s.release,
        auto: s.auto,
        tried: add(s.tried, [s.release?.id]),
        avoid: add(s.avoid, a.avoid),
      };
    case "ctx":
      return s.phase === "idle" ? s : ({ ...s, ctx: { ...s.ctx, ...a.patch } } as Flow);
    case "back":
      // Back from preparing/failed returns to the picker the user came from;
      // auto-started playback and the player itself return to Details.
      if ((s.phase === "preparing" || s.phase === "failed" || s.phase === "choose") && !s.auto) return { phase: "picker", ctx: s.ctx, tried: s.tried, avoid: s.avoid };
      return IDLE;
    case "another":
      return s.phase === "idle" ? s : { phase: "picker", ctx: s.ctx, tried: s.tried, avoid: s.avoid };
    case "close":
      return IDLE;
  }
}

/** The TV's screen while the flow shows something (else the catalog's). */
export function flowScreen(f: Flow): "player" | null {
  if (f.phase === "choose") return f.auto ? "player" : null;
  return f.phase === "preparing" || f.phase === "playing" || f.phase === "failed" ? "player" : null;
}

/** Playback that a remote command must not interrupt without `force`. */
export function isBusy(f: Flow): boolean {
  return f.phase === "preparing" || f.phase === "playing";
}

/** Maps API / source error codes to a `player.error.*` key (else generic). */
export const KNOWN_ERRORS = ["no_peers", "no_metadata", "no_matching_file", "torrserver_unavailable", "release_unavailable"] as const;
export type KnownError = (typeof KNOWN_ERRORS)[number];

export function errorKey(code: string): KnownError | null {
  return (KNOWN_ERRORS as readonly string[]).includes(code) ? (code as KnownError) : null;
}
