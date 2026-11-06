// Client error reporter shared by the PWA and the TV app.
//
// Errors are scrubbed, queued, deduplicated and sent in small batches to
// POST /api/v1/client-errors (see docs/architecture.md "Client error
// logging"). The reporter never throws, never retries, never reports its own
// failures and stops after MAX_PER_SESSION events per page load.

export type ClientErrorApp = "web" | "tv";
export type ClientErrorKind = "error" | "unhandledrejection" | "react" | "api" | "player" | "console";

export interface ClientErrorEvent {
  app: ClientErrorApp;
  kind: ClientErrorKind;
  message: string;
  stack?: string;
  url?: string;
  component?: string;
  release?: string;
  user_agent?: string;
  device_model?: string;
  profile_id?: string;
  extra?: Record<string, unknown>;
  occurred_at: string;
  count: number;
}

export interface ReporterAuth {
  headers: Record<string, string>;
  /** navigator.sendBeacon can carry this credential (cookie sessions). */
  beacon: boolean;
}

/** Minimal event-target shape (window/document, or a fake in tests). */
interface Target {
  addEventListener(type: string, fn: (e: Event) => void, capture?: boolean): void;
  removeEventListener(type: string, fn: (e: Event) => void, capture?: boolean): void;
}

export interface ReporterOptions {
  app: ClientErrorApp;
  release: string;
  endpoint?: string;
  /** Null when there is no credential: nothing is sent. */
  getAuth: () => ReporterAuth | null;
  getRoute?: () => string;
  getProfileId?: () => string | null | undefined;
  deviceModel?: string;
  /** Also report console.error calls (throttled). */
  captureConsole?: boolean;
  // ---- test seams ----
  fetch?: (url: string, init: RequestInit) => Promise<unknown>;
  sendBeacon?: (url: string, data: Blob) => boolean;
  window?: Target;
  document?: Target;
  console?: { error: (...args: unknown[]) => void };
  userAgent?: string;
  now?: () => number;
}

export const FLUSH_DELAY_MS = 5000;
export const FLUSH_AT = 10;
export const MAX_PER_SESSION = 50;
export const MAX_BATCH = 20;
const MAX_MESSAGE = 1000;
const MAX_STACK = 8000;
const MAX_EXTRA = 2000;
const MAX_FIELD = 500;
const MAX_BODY = 60_000;
const CONSOLE_PER_MINUTE = 5;
const DEFAULT_ENDPOINT = "/api/v1/client-errors";

// ---------------------------------------------------------------- scrubbing

/** Removes secrets from free text (messages, stacks, extra values). */
export function scrubText(s: string): string {
  return s
    .replace(/\bmt([spd])_[A-Za-z0-9_-]+/g, "mt$1_[redacted]")
    .replace(/\/stream\/[A-Za-z0-9_.~-]{16,}/g, "/stream/:token")
    .replace(/([?&;](?:token|key|auth|password|report_token|apikey|api_key)=)[^&\s#"']*/gi, "$1[redacted]")
    .replace(/magnet:\?[^\s"'<>]+/gi, "magnet:[redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b[0-9a-fA-F]{40}\b/g, "[infohash]");
}

/** Path only: no origin, query or hash; stream tokens replaced. */
export function scrubUrl(u: string): string {
  let p = u || "";
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(p);
  if (m) p = p.slice(m[0].length) || "/";
  const cut = p.search(/[?#]/);
  if (cut >= 0) p = p.slice(0, cut);
  p = p.replace(/\/stream\/[^/]+/g, "/stream/:token");
  return scrubText(p).slice(0, MAX_FIELD);
}

function scrubValue(v: unknown, depth: number): unknown {
  if (typeof v === "string") return scrubText(v);
  if (depth > 4 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => scrubValue(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as object).slice(0, 30)) out[k] = scrubValue((v as Record<string, unknown>)[k], depth + 1);
  return out;
}

function scrubExtra(extra: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!extra) return undefined;
  try {
    const clean = scrubValue(extra, 0) as Record<string, unknown>;
    return JSON.stringify(clean).length <= MAX_EXTRA ? clean : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- helpers

function describe(err: unknown): { message: string; stack?: string } {
  try {
    if (err instanceof Error) return { message: `${err.name}: ${err.message}`, stack: err.stack };
    if (typeof err === "string") return { message: err };
    if (err && typeof err === "object") {
      const o = err as { message?: unknown; stack?: unknown };
      if (typeof o.message === "string") return { message: o.message, stack: typeof o.stack === "string" ? o.stack : undefined };
      return { message: JSON.stringify(err).slice(0, MAX_MESSAGE) };
    }
    return { message: String(err) };
  } catch {
    return { message: "Unserializable error" };
  }
}

function topFrame(stack: string | undefined): string {
  if (!stack) return "";
  for (const line of stack.split("\n")) {
    const l = line.trim();
    if (/^at\s|@/.test(l)) return l;
  }
  return "";
}

/** Best-effort TV model from the user agent. */
export function parseDeviceModel(ua: string): string {
  if (!ua) return "";
  let m = /Tizen\s*([\d.]+)?/i.exec(ua);
  if (m) return `Samsung Tizen${m[1] ? " " + m[1] : ""}`;
  if (/Web0S|webOS/i.test(ua)) {
    m = /Chrome\/(\d+)/.exec(ua);
    return `LG webOS${m ? ` (Chrome ${m[1]})` : ""}`;
  }
  if (/NetCast/i.test(ua)) return "LG NetCast";
  m = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?[;)]/.exec(ua);
  if (m && /\b(TV|AFT|BRAVIA|MiBOX|SHIELD)/i.test(ua)) return `Android TV (${m[1]!.trim()})`;
  if (/SMART-TV|SmartTV|HbbTV/i.test(ua)) return "Smart TV";
  return "";
}

// ---------------------------------------------------------------- reporter

export class Reporter {
  private readonly o: ReporterOptions;
  private queue: ClientErrorEvent[] = [];
  private sent = 0; // events accepted into the queue this page session
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false; // reentrancy guard: never report while reporting
  private consoleHits: number[] = [];
  private cleanups: (() => void)[] = [];

  constructor(opts: ReporterOptions) {
    this.o = opts;
  }

  private now(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  /** Queues one error. Never throws. */
  report(kind: ClientErrorKind, err: unknown, ctx?: { component?: string; extra?: Record<string, unknown>; stack?: string }): void {
    if (this.busy) return;
    this.busy = true;
    let flushNow = false;
    try {
      flushNow = this.add(kind, err, ctx);
    } catch {
      // never let reporting break the app
    } finally {
      this.busy = false;
    }
    if (flushNow) this.flush();
  }

  /** Queues the event; true when the batch is full and should go now. */
  private add(kind: ClientErrorKind, err: unknown, ctx?: { component?: string; extra?: Record<string, unknown>; stack?: string }): boolean {
    const d = describe(err);
    const message = scrubText(d.message || "Unknown error").slice(0, MAX_MESSAGE);
    const stackRaw = d.stack || ctx?.stack;
    const stack = stackRaw ? scrubText(stackRaw).slice(0, MAX_STACK) : undefined;
    const component = ctx?.component ? scrubText(ctx.component).slice(0, MAX_FIELD) : undefined;
    const frame = topFrame(stack);
    const dup = this.queue.find(
      (e) => e.kind === kind && e.message === message && topFrame(e.stack) === frame && e.component === component,
    );
    if (dup) {
      dup.count = Math.min(dup.count + 1, 1000);
      return false;
    }
    if (this.sent >= MAX_PER_SESSION) return false;
    this.sent++;
    const route = safe(() => (this.o.getRoute ? this.o.getRoute() : typeof location !== "undefined" ? location.pathname : "")) || "";
    const profileId = safe(() => this.o.getProfileId?.()) || undefined;
    const ua = this.o.userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
    this.queue.push({
      app: this.o.app,
      kind,
      message,
      stack,
      url: route ? scrubUrl(route) : undefined,
      component,
      release: this.o.release.slice(0, 100),
      user_agent: ua.slice(0, MAX_FIELD),
      device_model: this.o.deviceModel || undefined,
      profile_id: profileId,
      extra: scrubExtra(ctx?.extra),
      occurred_at: new Date(this.now()).toISOString(),
      count: 1,
    });
    if (this.queue.length >= FLUSH_AT) return true;
    this.schedule();
    return false;
  }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, FLUSH_DELAY_MS);
  }

  /** Takes up to MAX_BATCH events whose JSON fits the body limit. */
  private take(): string | null {
    const batch: ClientErrorEvent[] = [];
    let size = 20;
    while (this.queue.length && batch.length < MAX_BATCH) {
      const n = JSON.stringify(this.queue[0]).length + 1;
      if (size + n > MAX_BODY) {
        if (batch.length === 0) this.queue.shift(); // single oversized event: drop
        break;
      }
      size += n;
      batch.push(this.queue.shift()!);
    }
    return batch.length ? JSON.stringify({ events: batch }) : null;
  }

  /** Sends what is queued (when there is a credential). Never throws. */
  flush(): void {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      const auth = this.o.getAuth();
      if (!auth) {
        if (this.queue.length) this.schedule(); // keep until signed in
        return;
      }
      const f = this.o.fetch ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : undefined);
      if (!f) return;
      for (let body = this.take(); body; body = this.take()) {
        try {
          const p = f(this.o.endpoint ?? DEFAULT_ENDPOINT, {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", ...auth.headers },
            body,
          });
          if (p && typeof (p as Promise<unknown>).catch === "function") (p as Promise<unknown>).catch(() => undefined);
        } catch {
          // dropped: never retried or reported
        }
      }
    } catch {
      // ignore
    } finally {
      this.busy = false;
    }
  }

  /** Page is going away: beacon (cookie) or keepalive fetch (bearer). */
  flushOnHide(): void {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      const auth = this.o.getAuth();
      if (!auth) {
        this.queue = [];
        return;
      }
      const url = this.o.endpoint ?? DEFAULT_ENDPOINT;
      const beacon =
        this.o.sendBeacon ??
        (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function"
          ? navigator.sendBeacon.bind(navigator)
          : undefined);
      const f = this.o.fetch ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : undefined);
      for (let body = this.take(); body; body = this.take()) {
        try {
          if (auth.beacon && beacon && typeof Blob !== "undefined") {
            beacon(url, new Blob([body], { type: "text/plain" }));
          } else if (f) {
            const p = f(url, {
              method: "POST",
              credentials: "same-origin",
              keepalive: true,
              headers: { "Content-Type": "application/json", ...auth.headers },
              body,
            });
            if (p && typeof (p as Promise<unknown>).catch === "function") (p as Promise<unknown>).catch(() => undefined);
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    } finally {
      this.busy = false;
    }
  }

  /** Number of events waiting to be sent (tests). */
  get pending(): number {
    return this.queue.length;
  }

  install(): void {
    const win = this.o.window ?? (typeof window !== "undefined" ? (window as Target) : undefined);
    const doc = this.o.document ?? (typeof document !== "undefined" ? (document as Target) : undefined);
    const on = (t: Target | undefined, type: string, fn: (e: Event) => void, capture?: boolean) => {
      if (!t) return;
      t.addEventListener(type, fn, capture);
      this.cleanups.push(() => t.removeEventListener(type, fn, capture));
    };
    on(win, "error", (e) => {
      const ev = e as ErrorEvent;
      // Resource load errors (img/script) don't bubble to window; ignore anything without a message.
      if (!ev.error && !ev.message) return;
      const where = ev.filename ? `at ${ev.filename}:${ev.lineno ?? 0}:${ev.colno ?? 0}` : undefined;
      this.report("error", ev.error ?? ev.message, { stack: where });
    });
    on(win, "unhandledrejection", (e) => {
      const reason = (e as Event & { reason?: unknown }).reason;
      this.report("unhandledrejection", reason ?? "Unhandled promise rejection");
    });
    on(
      doc,
      "error",
      (e) => {
        const el = e.target as (HTMLMediaElement & { error?: MediaError | null }) | null;
        if (!el || typeof HTMLMediaElement === "undefined" || !(el instanceof HTMLMediaElement)) return;
        const me = el.error;
        const codes = ["", "MEDIA_ERR_ABORTED", "MEDIA_ERR_NETWORK", "MEDIA_ERR_DECODE", "MEDIA_ERR_SRC_NOT_SUPPORTED"];
        const msg = me ? `${codes[me.code] ?? "MEDIA_ERR_" + me.code}${me.message ? ": " + me.message : ""}` : "Media element error";
        let ctx: Record<string, unknown> | undefined;
        try {
          ctx = mediaContext?.();
        } catch {
          ctx = undefined;
        }
        this.report("player", msg, { component: el.tagName.toLowerCase(), extra: { code: me?.code ?? null, ...(ctx ?? {}) } });
      },
      true,
    );
    on(win, "pagehide", () => this.flushOnHide());
    if (this.o.captureConsole) this.wrapConsole();
  }

  private wrapConsole() {
    const c = this.o.console ?? (typeof console !== "undefined" ? console : undefined);
    if (!c) return;
    const original = c.error;
    c.error = (...args: unknown[]) => {
      try {
        original.apply(c, args);
      } catch {
        // ignore
      }
      if (this.busy) return;
      const t = this.now();
      this.consoleHits = this.consoleHits.filter((x) => t - x < 60_000);
      if (this.consoleHits.length >= CONSOLE_PER_MINUTE) return;
      this.consoleHits.push(t);
      const first = args.find((a) => a instanceof Error);
      const text = args
        .map((a) => (typeof a === "string" ? a : a instanceof Error ? `${a.name}: ${a.message}` : safeJson(a)))
        .join(" ")
        .slice(0, MAX_MESSAGE);
      this.report("console", first instanceof Error ? { message: text, stack: first.stack } : text);
    };
    this.cleanups.push(() => {
      c.error = original;
    });
  }

  uninstall(): void {
    this.cleanups.forEach((f) => {
      try {
        f();
      } catch {
        // ignore
      }
    });
    this.cleanups = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

function safe<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

let current: Reporter | null = null;

/** Installs the global listeners and makes `reportError` live. */
export function installErrorReporter(opts: ReporterOptions): Reporter {
  try {
    current?.uninstall();
    current = new Reporter(opts);
    current.install();
  } catch {
    // never block app start-up
  }
  return current!;
}

/** Reports an error from app code (player, error boundary). No-op before install. */
/**
 * What the app's player is doing, attached to media element errors (mode,
 * source, codecs…) so a decode error can be diagnosed from the report alone.
 * The TV player registers it; nothing sensitive (no URLs/tokens).
 */
let mediaContext: (() => Record<string, unknown> | undefined) | null = null;
export function setMediaContext(fn: (() => Record<string, unknown> | undefined) | null): void {
  mediaContext = fn;
}

export function reportError(
  kind: ClientErrorKind,
  err: unknown,
  ctx?: { component?: string; extra?: Record<string, unknown> },
): void {
  try {
    current?.report(kind, err, ctx);
  } catch {
    // ignore
  }
}

/** Test helper: drops the global reporter. */
export function resetErrorReporter(): void {
  current?.uninstall();
  current = null;
}

// ---------------------------------------------------------------- API middleware

/** Expected statuses that are not bugs. Other 4xx are skipped too. */
const isReportable = (status: number) => status >= 500;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function operation(request: Request): string {
  let path = request.url;
  try {
    path = new URL(request.url, "http://x").pathname;
  } catch {
    // keep raw
  }
  path = scrubUrl(path).replace(UUID_RE, ":id").replace(/\/\d+(?=\/|$)/g, "/:n");
  return `${request.method} ${path}`;
}

/** Network failures are reported after this delay unless the page unloads. */
export const NETWORK_ERROR_GRACE_MS = 1500;
let unloading = false;
let unloadWatched = false;
function watchUnload() {
  if (unloadWatched || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  unloadWatched = true;
  const mark = () => {
    unloading = true;
  };
  window.addEventListener("beforeunload", mark);
  window.addEventListener("pagehide", mark);
  window.addEventListener("pageshow", () => {
    unloading = false;
  });
}

function isOwnEndpoint(request: Request): boolean {
  return request.url.indexOf("/client-errors") >= 0;
}

/**
 * openapi-fetch middleware: reports 5xx responses and network failures as
 * kind "api" (401/403/404/422/429 and other 4xx are expected and skipped).
 */
export function apiErrorMiddleware() {
  return {
    onResponse({ request, response }: { request: Request; response: Response }) {
      try {
        if (!isReportable(response.status) || isOwnEndpoint(request)) return undefined;
        const op = operation(request);
        const status = response.status;
        response
          .clone()
          .json()
          .then(
            (body: unknown) => {
              const e = (body as { error?: { code?: string; request_id?: string; message?: string } } | null)?.error;
              reportError("api", `${op} → ${status}${e?.code ? " " + e.code : ""}`, {
                component: op,
                extra: { status, code: e?.code ?? null, request_id: e?.request_id ?? null },
              });
            },
            () => reportError("api", `${op} → ${status}`, { component: op, extra: { status } }),
          )
          .catch(() => undefined);
      } catch {
        // ignore
      }
      return undefined;
    },
    onError({ request, error }: { request: Request; error: unknown }) {
      try {
        if (isOwnEndpoint(request)) return;
        // Aborted requests (navigation, unmount) are not failures.
        if (error && typeof error === "object" && (error as { name?: string }).name === "AbortError") return;
        const op = operation(request);
        const message = describe(error).message.slice(0, 200);
        watchUnload();
        // Requests cut off by a navigation/reload or a lost connection fail
        // the same way; report only if the page is still here a bit later.
        setTimeout(() => {
          try {
            if (unloading || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
            if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
            reportError("api", `${op} → network error`, { component: op, extra: { status: 0, error: message } });
          } catch {
            // ignore
          }
        }, NETWORK_ERROR_GRACE_MS);
      } catch {
        // ignore
      }
    },
  };
}
