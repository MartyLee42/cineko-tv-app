// Watch-progress reporting for the in-browser player. One playback session per
// played source: POST /playback/sessions when playback starts, then reports
// with an increasing `seq`: every 15 s while playing, right away on pause /
// end, debounced after seeks, a final "stopped" when leaving, and a
// navigator.sendBeacon report (?token=report_token, text/plain JSON) when the
// page is hidden. `accepted:false, reason:stale_session` (another device took
// over) stops reporting. Transport and timers are injected (unit-tested).
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
  report_token?: string;
}

export interface ReportBody {
  seq: number;
  position_seconds: number;
  duration_seconds: number | null;
  state: ReportState;
}

export interface ReportResult {
  accepted?: boolean;
  reason?: string;
}

export interface Transport {
  start(t: SessionTarget): Promise<SessionStart>;
  report(sessionId: string, body: ReportBody): Promise<ReportResult | null | undefined>;
  /** Fire-and-forget that survives the page going away. */
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
  probe: () => Snapshot | null;
  id: string | null;
  token: string | null;
  /** No more reports (start failed, stale session, or closed). */
  stopped: boolean;
  seq: number;
  /** Latest report made before the server answered the start. */
  queued: { body: ReportBody; beacon: boolean } | null;
  last: ReportState | null;
  lastPos: number;
  ended: boolean;
  timer: unknown;
  seekTimer: unknown;
}

export class ProgressReporter {
  private s: Session | null = null;
  /** Called once when the server says another device took over. */
  onStale: (() => void) | null = null;

  constructor(
    private readonly transport: Transport,
    private readonly clock: Clock = realClock,
    private readonly every = REPORT_EVERY,
  ) {}

  get sessionId(): string | null {
    return this.s?.id ?? null;
  }

  get active(): boolean {
    return this.s !== null && !this.s.stopped;
  }

  /** Last sequence number used (for tests / debugging). */
  get seq(): number {
    return this.s?.seq ?? 0;
  }

  /** Opens a session; resolves with the server's answer (null on failure). */
  begin(target: SessionTarget, probe: () => Snapshot | null): Promise<SessionStart | null> {
    this.end();
    const s: Session = {
      probe,
      id: null,
      token: null,
      stopped: false,
      seq: 0,
      queued: null,
      last: null,
      lastPos: 0,
      ended: false,
      timer: null,
      seekTimer: null,
    };
    this.s = s;
    s.timer = this.clock.setInterval(() => this.tick(s), this.every);
    return this.transport.start(target).then(
      (r) => {
        s.id = r.id;
        s.token = r.report_token ?? null;
        const q = s.queued;
        s.queued = null;
        if (q && !s.stopped) this.send(s, q.body, q.beacon);
        return r;
      },
      () => {
        s.stopped = true;
        s.queued = null;
        this.clock.clearInterval(s.timer);
        return null;
      },
    );
  }

  private tick(s: Session) {
    const snap = s.probe();
    if (!snap || snap.paused) return;
    this.push(s, "playing", snap);
  }

  /** A state change, reported right away (play / pause / ended). */
  report(state: "playing" | "paused" | "ended") {
    const s = this.s;
    if (!s) return;
    const snap = s.probe();
    if (!snap) return;
    // Resuming after a buffering stall is not news; the periodic report covers it.
    if (state === "playing" && s.last === "playing") return;
    // A pause right after "ended" (the element pauses itself at the end) adds nothing.
    if (state === "paused" && s.last === "ended") return;
    if (state === "ended") s.ended = true;
    else if (state === "playing") s.ended = false;
    this.push(s, state, snap);
  }

  /** A seek happened: reported once seeking settles (scrubbing sends one report). */
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

  /** The page is being hidden or unloaded: a beacon report now. */
  hidden() {
    const s = this.s;
    if (!s) return;
    const snap = s.probe();
    if (!snap) return;
    this.push(s, s.ended ? "ended" : "paused", snap, true);
  }

  /**
   * Playback stops (Back, another release, next episode, unmount): a final
   * "stopped" report, skipped right after "ended" at the same spot.
   * `beacon` when the page itself is going away.
   */
  end(snap?: Snapshot | null, beacon = false) {
    const s = this.s;
    if (!s) return;
    this.s = null;
    this.clock.clearInterval(s.timer);
    this.clock.clearTimeout(s.seekTimer);
    const at = snap ?? s.probe();
    if (at && !(s.ended && s.last === "ended" && Math.abs(at.position - s.lastPos) < 2)) this.push(s, "stopped", at, beacon);
    s.stopped = true;
  }

  private push(s: Session, state: ReportState, snap: Snapshot, beacon = false) {
    if (s.stopped) return;
    const body: ReportBody = {
      seq: ++s.seq,
      position_seconds: Math.max(0, Math.round(snap.position * 10) / 10),
      duration_seconds: snap.duration && Number.isFinite(snap.duration) && snap.duration > 0 ? Math.round(snap.duration * 10) / 10 : null,
      state,
    };
    s.last = state;
    s.lastPos = snap.position;
    if (!s.id) {
      s.queued = { body, beacon: beacon || (s.queued?.beacon ?? false) };
      return;
    }
    this.send(s, body, beacon);
  }

  private send(s: Session, body: ReportBody, beacon: boolean) {
    if (beacon) return this.transport.beacon(s.id!, body, s.token);
    void this.transport.report(s.id!, body).then(
      (r) => {
        if (r && r.accepted === false && r.reason === "stale_session" && !s.stopped) {
          s.stopped = true;
          this.clock.clearInterval(s.timer);
          this.clock.clearTimeout(s.seekTimer);
          this.onStale?.();
        }
      },
      () => undefined,
    );
  }
}
