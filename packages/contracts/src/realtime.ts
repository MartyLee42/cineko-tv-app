/**
 * WebSocket client for /api/v1/ws, shared by the TV app and the PWA.
 *
 * - Reconnects with exponential backoff + jitter.
 * - Authenticates with a first `auth` message when given a token (TV);
 *   browsers rely on the session cookie.
 * - Sends an app-level ping so dead links are noticed even where the
 *   runtime hides WebSocket ping frames.
 * - `command()` resolves with the TV's ack; a retry reuses the same command
 *   ID so the server can de-duplicate it.
 */

export interface Envelope<P = unknown> {
  id?: string;
  type: string;
  target_device_id?: string;
  device_id?: string;
  payload?: P;
  /** Set by the server on commands forwarded to a TV: who sent it. */
  from?: { user_id: string; username: string; display_name: string };
}

export interface AckPayload {
  ok: boolean;
  error?: string;
  result?: unknown;
}

export type ConnectionState = "connecting" | "open" | "closed";

export interface RealtimeOptions {
  url: string;
  /** Device or API token. Omit for cookie-authenticated browsers. */
  getToken?: () => string | undefined;
  /** Called when the server rejects our credentials. */
  onAuthFailed?: () => void;
  WebSocketImpl?: typeof WebSocket;
  /** Backoff tuning (ms). */
  minDelay?: number;
  maxDelay?: number;
  pingInterval?: number;
  random?: () => number;
  /** Clock (ms), for tests. */
  now?: () => number;
}

type Listener = (env: Envelope) => void;

export class CommandError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Delay before reconnect attempt `attempt` (0-based): full jitter. */
export function backoffDelay(attempt: number, min: number, max: number, random: () => number): number {
  const ceiling = Math.min(max, min * 2 ** attempt);
  return Math.round(min + random() * (ceiling - min));
}

export function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Older TV browsers: fall back to getRandomValues, then Math.random.
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export class RealtimeClient {
  private ws?: WebSocket;
  private attempt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private stopped = true;
  private listeners = new Set<Listener>();
  private stateListeners = new Set<(s: ConnectionState) => void>();
  private pending = new Map<string, { resolve: (a: AckPayload) => void; reject: (e: Error) => void }>();
  private outbox: Envelope[] = [];
  private authFailures = 0;
  /** When the last message arrived (the server answers every ping). */
  private lastHeard = 0;
  state: ConnectionState = "closed";

  constructor(private readonly opts: RealtimeOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.pingTimer);
    this.ws?.close(1000, "client stopped");
    this.ws = undefined;
    this.setState("closed");
  }

  /**
   * Reconnect now (e.g. when the page becomes visible or the network returns).
   * An "open" socket that has been silent too long is replaced too: after a
   * TV's standby the old TCP connection is dead without any close event.
   */
  reconnectNow(): void {
    if (this.stopped) return;
    if (this.state === "open") {
      if (this.now() - this.lastHeard < this.pingEvery() + 5_000) return;
      this.dropDead();
      return;
    }
    clearTimeout(this.timer);
    this.attempt = 0;
    this.connect();
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onState(listener: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Sends a message, queueing it until connected. */
  send(env: Envelope): void {
    if (this.ws && this.state === "open") this.ws.send(JSON.stringify(env));
    else if (this.outbox.length < 50) this.outbox.push(env);
  }

  /**
   * Sends a command to a TV and resolves with its ack. On timeout or a dropped
   * connection it retries once with the same ID.
   */
  async command(deviceId: string, type: string, payload?: unknown, id = newId()): Promise<AckPayload> {
    for (let attempt = 0; ; attempt++) {
      const ack = await this.sendCommandOnce(deviceId, type, payload, id).catch((e: Error) => {
        if (attempt === 0 && (e.message === "timeout" || e.message === "disconnected")) return null;
        throw e;
      });
      if (ack === null) continue;
      if (!ack.ok && ack.error === "timeout" && attempt === 0) continue;
      if (!ack.ok) throw new CommandError(ack.error ?? "failed");
      return ack;
    }
  }

  private sendCommandOnce(deviceId: string, type: string, payload: unknown, id: string): Promise<AckPayload> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("timeout"));
      }, 15_000);
      this.pending.set(id, {
        resolve: (a) => {
          clearTimeout(t);
          resolve(a);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.send({ id, type, target_device_id: deviceId, payload });
    });
  }

  private setState(s: ConnectionState) {
    if (this.state === s) return;
    this.state = s;
    this.stateListeners.forEach((l) => l(s));
  }

  private connect() {
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    this.setState("connecting");
    let ws: WebSocket;
    try {
      ws = new Impl(this.opts.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    let helloSeen = false;

    ws.onopen = () => {
      const token = this.opts.getToken?.();
      if (token) ws.send(JSON.stringify({ type: "auth", payload: { token } }));
    };
    ws.onmessage = (ev) => {
      this.lastHeard = this.now();
      let env: Envelope;
      try {
        env = JSON.parse(String(ev.data)) as Envelope;
      } catch {
        return;
      }
      if (env.type === "hello") {
        helloSeen = true;
        this.attempt = 0;
        this.authFailures = 0;
        this.setState("open");
        this.startPing();
        const queued = this.outbox.splice(0);
        queued.forEach((m) => ws.send(JSON.stringify(m)));
      }
      if (env.type === "ack" && env.id) {
        const p = this.pending.get(env.id);
        if (p) {
          this.pending.delete(env.id);
          p.resolve((env.payload as AckPayload) ?? { ok: false, error: "bad_ack" });
        }
      }
      this.listeners.forEach((l) => l(env));
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.detach();
      // 1008 = policy violation: our credentials were rejected or revoked.
      if (!helloSeen && ev.code === 1008) {
        this.authFailures++;
        if (this.authFailures >= 2) {
          this.opts.onAuthFailed?.();
        }
      }
      if (ev.code === 1000 && /revoked|signed out/.test(ev.reason)) {
        this.opts.onAuthFailed?.();
      }
      this.setState("closed");
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows and handles reconnection.
    };
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private pingEvery(): number {
    return this.opts.pingInterval ?? 25_000;
  }

  /** Forgets the current socket and fails its pending commands. */
  private detach() {
    clearInterval(this.pingTimer);
    this.ws = undefined;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(new Error("disconnected"));
    }
  }

  /** The socket is silently dead (standby, network switch): start over now. */
  private dropDead() {
    const ws = this.ws;
    this.detach();
    if (ws) {
      ws.onclose = ws.onmessage = ws.onopen = ws.onerror = null;
      try {
        ws.close(4000, "stale");
      } catch {
        // already gone
      }
    }
    this.setState("closed");
    clearTimeout(this.timer);
    this.attempt = 0;
    this.connect();
  }

  private startPing() {
    clearInterval(this.pingTimer);
    const every = this.pingEvery();
    let lastTick = this.now();
    this.pingTimer = setInterval(() => {
      const t = this.now();
      // Timers were frozen (the device slept) or nothing came back for two
      // pings: the connection is dead even though no close event arrived.
      const slept = t - lastTick > every * 2;
      lastTick = t;
      if (slept || t - this.lastHeard > every * 2 + 5_000) {
        this.dropDead();
        return;
      }
      this.send({ type: "ping" });
    }, every);
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const delay = backoffDelay(
      this.attempt++,
      this.opts.minDelay ?? 1_000,
      this.opts.maxDelay ?? 30_000,
      this.opts.random ?? Math.random,
    );
    this.timer = setTimeout(() => this.connect(), delay);
  }
}

/** ws:// or wss:// URL for the realtime endpoint on the current origin. */
export function realtimeUrl(origin: string = globalThis.location?.origin ?? ""): string {
  return origin.replace(/^http/, "ws") + "/api/v1/ws";
}
