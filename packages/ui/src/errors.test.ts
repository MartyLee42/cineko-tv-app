import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiErrorMiddleware,
  installErrorReporter,
  parseDeviceModel,
  reportError,
  resetErrorReporter,
  Reporter,
  scrubText,
  scrubUrl,
  type ClientErrorEvent,
  type ReporterOptions,
} from "./errors";
import { firstComponent } from "./ErrorBoundary";

type Call = { url: string; init: RequestInit };

function setup(over: Partial<ReporterOptions> = {}) {
  const calls: Call[] = [];
  const beacons: { url: string; data: Blob }[] = [];
  const win = new EventTarget();
  const doc = new EventTarget();
  const opts: ReporterOptions = {
    app: "web",
    release: "test-1",
    getAuth: () => ({ headers: { "X-CSRF-Token": "csrf" }, beacon: true }),
    getRoute: () => "/media/abc?token=secret#x",
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({});
    },
    sendBeacon: (url, data) => {
      beacons.push({ url, data });
      return true;
    },
    window: win,
    document: doc,
    userAgent: "UA",
    ...over,
  };
  const r = installErrorReporter(opts);
  const events = () => calls.flatMap((c) => (JSON.parse(c.init.body as string) as { events: ClientErrorEvent[] }).events);
  return { r, calls, beacons, win, doc, events };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  resetErrorReporter();
  vi.useRealTimers();
});

describe("reporter batching", () => {
  it("debounces for 5 s", () => {
    const { calls, events } = setup();
    reportError("error", new Error("boom"));
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(4999);
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe("/api/v1/client-errors");
    expect((c.init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("csrf");
    const e = events()[0]!;
    expect(e).toMatchObject({ app: "web", kind: "error", message: "Error: boom", release: "test-1", url: "/media/abc", count: 1, user_agent: "UA" });
  });

  it("flushes immediately at 10 events", () => {
    const { calls, events } = setup();
    for (let i = 0; i < 10; i++) reportError("error", `distinct ${i}`);
    expect(calls).toHaveLength(1);
    expect(events()).toHaveLength(10);
  });

  it("dedupes identical errors with a count", () => {
    const { events } = setup();
    const err = new Error("same");
    for (let i = 0; i < 7; i++) reportError("error", err);
    reportError("error", "other");
    vi.advanceTimersByTime(5000);
    expect(events().map((e) => [e.message, e.count])).toEqual([
      ["Error: same", 7],
      ["other", 1],
    ]);
  });

  it("caps at 50 events per page session", () => {
    const { events } = setup();
    for (let i = 0; i < 80; i++) reportError("error", `e${i}`);
    vi.advanceTimersByTime(60_000);
    expect(events()).toHaveLength(50);
  });

  it("keeps events queued without a credential, sends once signed in", () => {
    let auth: ReturnType<ReporterOptions["getAuth"]> = null;
    const { r, calls } = setup({ getAuth: () => auth });
    reportError("error", "early");
    vi.advanceTimersByTime(20_000);
    expect(calls).toHaveLength(0);
    expect(r.pending).toBe(1);
    auth = { headers: {}, beacon: true };
    vi.advanceTimersByTime(5000);
    expect(calls).toHaveLength(1);
  });
});

describe("captures", () => {
  it("window error and unhandledrejection", () => {
    const { win, events } = setup();
    const ev = Object.assign(new Event("error"), { message: "Uncaught x", filename: "http://h/app.js", lineno: 3, colno: 4 });
    win.dispatchEvent(ev);
    const rej = Object.assign(new Event("unhandledrejection"), { reason: new TypeError("nope") });
    win.dispatchEvent(rej);
    vi.advanceTimersByTime(5000);
    expect(events().map((e) => [e.kind, e.message])).toEqual([
      ["error", "Uncaught x"],
      ["unhandledrejection", "TypeError: nope"],
    ]);
    expect(events()[0]!.stack).toBe("at http://h/app.js:3:4");
  });

  it("beacons on pagehide for cookie sessions, keepalive fetch for bearer", async () => {
    const a = setup();
    reportError("error", "bye");
    a.win.dispatchEvent(new Event("pagehide"));
    expect(a.calls).toHaveLength(0);
    expect(a.beacons).toHaveLength(1);
    expect(a.beacons[0]!.data.type).toBe("text/plain");
    expect(JSON.parse(await a.beacons[0]!.data.text()).events[0].message).toBe("bye");

    const b = setup({ getAuth: () => ({ headers: { Authorization: "Bearer mtd_x" }, beacon: false }) });
    reportError("error", "bye");
    b.win.dispatchEvent(new Event("pagehide"));
    expect(b.beacons).toHaveLength(0);
    expect(b.calls[0]!.init.keepalive).toBe(true);
  });

  it("drops on pagehide without a credential", () => {
    const { win, calls, beacons, r } = setup({ getAuth: () => null });
    reportError("error", "x");
    win.dispatchEvent(new Event("pagehide"));
    expect(calls.length + beacons.length).toBe(0);
    expect(r.pending).toBe(0);
  });
});

describe("no loops", () => {
  it("swallows a throwing fetch and never reports it", () => {
    const fake = { error: vi.fn() };
    let n = 0;
    const r = new Reporter({
      app: "tv",
      release: "1",
      getAuth: () => ({ headers: {}, beacon: false }),
      fetch: () => {
        n++;
        fake.error("fetch failed");
        throw new Error("network down");
      },
      window: new EventTarget(),
      document: new EventTarget(),
      console: fake,
      captureConsole: true,
    });
    r.install();
    r.report("error", "first");
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
    expect(n).toBe(1);
    expect(r.pending).toBe(0); // console.error during send was not queued
    vi.advanceTimersByTime(60_000);
    expect(n).toBe(1); // nothing re-sent or re-reported
    r.uninstall();
  });

  it("throttles console.error", () => {
    const fake = { error: vi.fn() };
    const r = new Reporter({
      app: "web",
      release: "1",
      getAuth: () => null,
      window: new EventTarget(),
      document: new EventTarget(),
      console: fake,
      captureConsole: true,
    });
    r.install();
    for (let i = 0; i < 20; i++) fake.error(`msg ${i}`);
    expect(r.pending).toBe(5);
    r.uninstall();
  });

  it("is a no-op before install", () => {
    expect(() => reportError("error", "x")).not.toThrow();
  });
});

describe("scrubbing", () => {
  it.each([
    ["session mts_abcDEF123_-x here", "session mts_[redacted] here"],
    ["Bearer mtp_zzz and mtd_yyy", "Bearer mtp_[redacted] and mtd_[redacted]"],
    ["GET /api/v1/progress?token=abc&x=1", "GET /api/v1/progress?token=[redacted]&x=1"],
    ["u?report_token=r1&password=p&key=k&auth=a", "u?report_token=[redacted]&password=[redacted]&key=[redacted]&auth=[redacted]"],
    ["mail bob@example.com now", "mail [email] now"],
    ["magnet:?xt=urn:btih:abc&dn=x end", "magnet:[redacted] end"],
    ["hash 0123456789abcdef0123456789abcdef01234567.", "hash [infohash]."],
    ["/api/v1/stream/AbCdEfGhIjKlMnOpQrSt/file.mkv", "/api/v1/stream/:token/file.mkv"],
  ])("%s", (input, want) => expect(scrubText(input)).toBe(want));

  it("reduces URLs to the path", () => {
    expect(scrubUrl("https://tv.example/watch/1?token=x#t=5")).toBe("/watch/1");
    expect(scrubUrl("/api/v1/stream/tok123/movie.mkv?x=1")).toBe("/api/v1/stream/:token/movie.mkv");
  });

  it("scrubs before sending", () => {
    const { events } = setup({ getRoute: () => "/stream/abc?key=1" });
    reportError("api", new Error("failed for mts_secret bob@x.io"), { extra: { url: "/x?token=t" } });
    vi.advanceTimersByTime(5000);
    const e = events()[0]!;
    expect(e.message).toBe("Error: failed for mts_[redacted] [email]");
    expect(e.url).toBe("/stream/:token");
    expect(e.extra).toEqual({ url: "/x?token=[redacted]" });
    expect(JSON.stringify(e)).not.toContain("secret");
  });

  it("truncates long fields and drops large extra", () => {
    const { events } = setup();
    const err = new Error("m".repeat(5000));
    err.stack = "s".repeat(20_000);
    reportError("error", err, { extra: { big: "x".repeat(5000) } });
    vi.advanceTimersByTime(5000);
    const e = events()[0]!;
    expect(e.message.length).toBe(1000);
    expect(e.stack!.length).toBe(8000);
    expect(e.extra).toBeUndefined();
  });
});

describe("apiErrorMiddleware", () => {
  const req = (url: string, method = "GET") => new Request(`http://h${url}`, { method });

  it("reports 5xx with the request id, skips expected statuses", async () => {
    const { events } = setup();
    const mw = apiErrorMiddleware();
    for (const s of [400, 401, 403, 404, 422, 429]) {
      mw.onResponse({ request: req("/api/v1/media/x"), response: new Response("{}", { status: s }) });
    }
    mw.onResponse({
      request: req("/api/v1/media/0b5c6f3e-1111-4222-8333-944445555666/releases"),
      response: new Response(JSON.stringify({ error: { code: "internal", request_id: "rid1" } }), { status: 500 }),
    });
    mw.onResponse({ request: req("/api/v1/client-errors", "POST"), response: new Response("{}", { status: 500 }) });
    await vi.runAllTimersAsync();
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      kind: "api",
      component: "GET /api/v1/media/:id/releases",
      message: "GET /api/v1/media/:id/releases → 500 internal",
      extra: { status: 500, code: "internal", request_id: "rid1" },
    });
  });

  it("reports network errors but not aborts", () => {
    const { events } = setup();
    const mw = apiErrorMiddleware();
    mw.onError({ request: req("/api/v1/catalog/home"), error: new TypeError("Failed to fetch") });
    mw.onError({ request: req("/api/v1/catalog/home"), error: Object.assign(new Error("x"), { name: "AbortError" }) });
    vi.advanceTimersByTime(1000); // grace period: a navigation would cancel it
    vi.advanceTimersByTime(6000);
    expect(events().map((e) => e.message)).toEqual(["GET /api/v1/catalog/home → network error"]);
  });
});

describe("helpers", () => {
  it("parses TV models", () => {
    expect(parseDeviceModel("Mozilla/5.0 (SMART-TV; LINUX; Tizen 4.0) AppleWebKit/537.36 SamsungBrowser/2.1 TV Safari/537.36")).toBe(
      "Samsung Tizen 4.0",
    );
    expect(parseDeviceModel("Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 Chrome/53.0.2785.34 Safari/537.36 WebAppManager")).toBe(
      "LG webOS (Chrome 53)",
    );
    expect(parseDeviceModel("Mozilla/5.0 (Linux; Android 9; BRAVIA 4K GB Build/PTT1.190515.001.S52) AppleWebKit Chrome/80 Safari")).toBe(
      "Android TV (BRAVIA 4K GB)",
    );
    expect(parseDeviceModel("Mozilla/5.0 (X11; Linux x86_64) Chrome/120")).toBe("");
  });

  it("finds the first component in a React stack", () => {
    expect(firstComponent("\n    at Details (http://x/a.js:1:2)\n    at App")).toBe("Details");
    expect(firstComponent("\nDetails@http://x/a.js:1:2\nApp@")).toBe("Details");
  });
});
