// Watch-progress reporting for the built-in player. One playback session per
// played source: POST /playback/sessions when playback starts, then progress
// reports with an increasing `seq`: every 15 s while playing, immediately on
// pause / end / stop, debounced after seeks, and as a keepalive request when
// the page is hidden. Transport and timers are injected (unit-tested).
import type { WatchProgress } from "@martytv/contracts";

export type ReportState = "playing" | "paused" | "seeking" | "ended" | "stopped";

export interface Snapshot {
  position: number;
  duration: number | null;
  paused: boolean;
}

export interface SessionTarget {
  profile_id: string;
  media_id: string;
  episode_id?: string | null;
  source_id?: string | null;
}

export interface SessionStart {
  id: string;
  resume_position_seconds: number | null;
  progress: WatchProgress | null;
  /** Authenticates header-less beacon reports for this session (?token=). */
  report_token?: string;
}

export interface ReportBody {
  seq: number;
  position_seconds: number;
  duration_seconds: number | null;
  state: ReportState;
}

export interface Transport {
  start(t: SessionTarget): Promise<SessionStart>;
  report(sessionId: string, body: ReportBody): Promise<unknown>;
  /** Fire-and-forget that should survive the page going away. */
  beacon(sessionId: string, body: ReportBody, token: string | null): void;
}

export interface Clock {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

const realClock: Clock = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export const REPORT_EVERY = 15_000;
export const SEEK_DEBOUNCE = 800;

interface Session {
  target: SessionTarget;
  probe: () => Snapshot | null;
  /** Null until the server answered (reports wait; the latest one is kept). */
  id: string | null;
  token: string | null;
  failed: boolean;
  seq: number;
  queued: { body: ReportBody; beacon: boolean } | null;
  last: ReportState | null;
  lastPos: number;
  ended: boolean;
  timer: unknown;
  seekTimer: unknown;
}

export class ProgressReporter {
  private s: Session | null = null;

  constructor(
    private readonly transport: Transport,
    private readonly clock: Clock = realClock,
    private readonly every = REPORT_EVERY,
  ) {}

  /** The current session id (null before the server answered / when none). */
  get sessionId(): string | null {
    return this.s?.id ?? null;
  }

  get active(): boolean {
    return this.s !== null;
  }

  /**
   * Starts a session. With `track` false (MSX / external players) the session
   * is only opened — positions can't be known, so nothing is reported.
   * Resolves with the server's answer (where to resume), or null on failure.
   */
  begin(target: SessionTarget, probe: () => Snapshot | null, track = true): Promise<SessionStart | null> {
    this.end();
    const s: Session = {
      target,
      probe,
      id: null,
      token: null,
      failed: false,
      seq: 0,
      queued: null,
      last: null,
      lastPos: 0,
      ended: false,
      timer: null,
      seekTimer: null,
    };
    this.s = s;
    if (track) s.timer = this.clock.setInterval(() => this.tick(s), this.every);
    else s.failed = true; // never reports
    return this.transport.start(target).then(
      (r) => {
        if (!track) return r;
        s.id = r.id;
        s.token = r.report_token ?? null;
        const q = s.queued;
        s.queued = null;
        if (q) this.send(s, q.body, q.beacon);
        return r;
      },
      () => {
        s.failed = true;
        s.queued = null;
        return null;
      },
    );
  }

  private tick(s: Session) {
    const snap = s.probe();
    if (!snap || snap.paused) return;
    this.push(s, "playing", snap);
  }

  /** Reports a state change right away (pause / play / ended). */
  report(state: Exclude<ReportState, "stopped" | "seeking">) {
    const s = this.s;
    if (!s) return;
    const snap = s.probe();
    if (!snap) return;
    // "playing" again after buffering is not news; the periodic report covers it.
    if (state === "playing" && s.last === "playing") return;
    if (state === "ended") s.ended = true;
    else if (state === "playing") s.ended = false;
    this.push(s, state, snap);
  }

  /** A seek finished: reported once the seeking settles. */
  seeked() {
    const s = this.s;
    if (!s) return;
    s.ended = false;
    this.clock.clearTimeout(s.seekTimer);
    s.seekTimer = this.clock.setTimeout(() => {
      s.seekTimer = null;
      if (this.s !== s) return;
      const snap = s.probe();
      if (snap) this.push(s, "seeking", snap);
    }, SEEK_DEBOUNCE);
  }

  /** The page is being hidden / unloaded: a keepalive report now. */
  hidden() {
    const s = this.s;
    if (!s) return;
    const snap = s.probe();
    if (!snap) return;
    this.push(s, s.ended ? "ended" : "paused", snap, true);
  }

  /**
   * Playback stops (Back, Stop, another source, next episode): a final
   * "stopped" report (skipped right after "ended" at the same spot).
   * `snap` is the last position when the video is already gone.
   */
  end(snap?: Snapshot | null) {
    const s = this.s;
    if (!s) return;
    this.s = null;
    this.clock.clearInterval(s.timer);
    this.clock.clearTimeout(s.seekTimer);
    const at = snap ?? s.probe();
    if (!at) return;
    if (s.ended && s.last === "ended" && Math.abs(at.position - s.lastPos) < 2) return;
    this.push(s, "stopped", at);
  }

  private push(s: Session, state: ReportState, snap: Snapshot, beacon = false) {
    if (s.failed) return;
    const body: ReportBody = {
      seq: ++s.seq,
      position_seconds: Math.max(0, Math.round(snap.position * 10) / 10),
      duration_seconds: snap.duration && isFinite(snap.duration) && snap.duration > 0 ? Math.round(snap.duration * 10) / 10 : null,
      state,
    };
    s.last = state;
    s.lastPos = snap.position;
    if (!s.id) {
      // Session not open yet: keep the latest report for when it is.
      s.queued = { body, beacon: beacon || (s.queued?.beacon ?? false) };
      return;
    }
    this.send(s, body, beacon);
  }

  private send(s: Session, body: ReportBody, beacon: boolean) {
    if (beacon) return this.transport.beacon(s.id!, body, s.token);
    void this.transport.report(s.id!, body).then(
      (r) => {
        // Another device took over this title: stop reporting for this session.
        const res = r as { accepted?: boolean; reason?: string } | null | undefined;
        if (res && res.accepted === false && res.reason === "stale_session") s.failed = true;
      },
      () => undefined,
    );
  }
}
