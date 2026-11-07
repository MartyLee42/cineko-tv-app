import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { translate, type MessageKey } from "@martytv/ui";
import { interruptItem, migrateItem, type DeviceItem } from "./items";
import {
  CHUNK,
  NEW_JOB,
  checkSpace,
  chooseMode,
  classifyError,
  httpError,
  jobReducer,
  parseContentRange,
  percentOf,
  resumeCheck,
  retryDelay,
  shouldAutoRetry,
  type JobState,
} from "./logic";
import { deviceView, errorText, seasonState } from "./view";

const t = (key: MessageKey, vars?: Record<string, string | number>) => translate("ru", key, vars);

describe("job state machine", () => {
  const run = (...events: Parameters<typeof jobReducer>[1][]) => events.reduce(jobReducer, NEW_JOB);

  it("goes queued → preparing → downloading → saved", () => {
    const s = run({ type: "prepare" }, { type: "start", total: 3 * CHUNK, restart: true }, { type: "chunk", chunks: 1, bytes: CHUNK });
    expect(s).toMatchObject({ status: "downloading", chunks: 1, bytes: CHUNK, total: 3 * CHUNK });
    expect(percentOf(s)).toBe(33);
    const done = jobReducer(s, { type: "done", bytes: 3 * CHUNK - 5 });
    expect(done).toMatchObject({ status: "saved", bytes: 3 * CHUNK - 5, total: 3 * CHUNK - 5 });
    expect(percentOf(done)).toBe(100);
  });

  it("ignores events out of order", () => {
    expect(jobReducer(NEW_JOB, { type: "start", total: 1, restart: true }).status).toBe("queued");
    expect(jobReducer(NEW_JOB, { type: "done", bytes: 1 }).status).toBe("queued");
    const saved: JobState = { ...NEW_JOB, status: "saved", bytes: 9, total: 9 };
    expect(jobReducer(saved, { type: "fail", error: "network", keepChunks: true })).toBe(saved);
    expect(jobReducer(saved, { type: "retry" })).toBe(saved);
  });

  it("keeps chunks on a resumable failure and resumes after them", () => {
    let s = run({ type: "prepare" }, { type: "start", total: 10 * CHUNK, restart: true }, { type: "chunk", chunks: 4, bytes: 4 * CHUNK }, { type: "progress", bytes: 4 * CHUNK + 100 });
    s = jobReducer(s, { type: "fail", error: "network", keepChunks: true });
    expect(s).toMatchObject({ status: "failed", error: "network", chunks: 4 });
    s = jobReducer(jobReducer(jobReducer(s, { type: "retry" }), { type: "prepare" }), { type: "start", total: 10 * CHUNK, restart: false });
    expect(s).toMatchObject({ status: "downloading", chunks: 4, bytes: 4 * CHUNK });
    expect(s.error).toBeUndefined();
  });

  it("drops the bytes of a compat failure (no byte ranges to resume)", () => {
    let s = run({ type: "prepare" }, { type: "start", total: null, restart: true }, { type: "chunk", chunks: 2, bytes: 2 * CHUNK });
    s = jobReducer(s, { type: "fail", error: "network", keepChunks: false });
    expect(s).toMatchObject({ status: "failed", chunks: 0, bytes: 0 });
    expect(percentOf(s)).toBeNull();
  });

  it("restart from zero resets the counters", () => {
    const s = jobReducer({ ...NEW_JOB, status: "preparing", chunks: 3, bytes: 3 * CHUNK }, { type: "start", total: 50, restart: true });
    expect(s).toMatchObject({ chunks: 0, bytes: 0, total: 50 });
  });

  it("fail carries a code and sizes", () => {
    const s = jobReducer({ ...NEW_JOB, status: "preparing" }, { type: "fail", error: "quota", vars: { need: 5, free: 1 }, keepChunks: true });
    expect(s).toMatchObject({ error: "quota", errorVars: { need: 5, free: 1 } });
  });

  it("automatic retries: original files, network-ish errors, a few times", () => {
    expect(shouldAutoRetry("network", "original", 0)).toBe(true);
    expect(shouldAutoRetry("expired", "original", 3)).toBe(true);
    expect(shouldAutoRetry("network", "original", 4)).toBe(false);
    expect(shouldAutoRetry("network", "compat", 0)).toBe(false);
    expect(shouldAutoRetry("quota", "original", 0)).toBe(false);
    expect([1, 2, 3, 4, 9].map(retryDelay)).toEqual([3000, 10_000, 30_000, 60_000, 60_000]);
  });
});

describe("chooseMode", () => {
  const ok = { verdict: "playable" as const, noAudio: false, reasons: [] };
  const ac3 = { verdict: "maybe" as const, noAudio: true, reasons: [{ code: "no_audio", severity: "maybe" as const }] };
  const mkvSafari = { verdict: "unlikely" as const, noAudio: false, reasons: [{ code: "container", severity: "unlikely" as const }] };
  const hevc = { verdict: "unlikely" as const, noAudio: false, reasons: [{ code: "video", severity: "unlikely" as const }] };
  const url = "/api/v1/stream/x/compat.mp4";

  it("saves the original when it plays here", () => {
    expect(chooseMode({ support: ok, compatUrl: url, pref: null })).toEqual({ mode: "original" });
  });
  it("saves the compat version when it fixes audio / container", () => {
    expect(chooseMode({ support: ac3, compatUrl: url, pref: null })).toEqual({ mode: "compat", video: false });
    expect(chooseMode({ support: mkvSafari, compatUrl: url, pref: null })).toEqual({ mode: "compat", video: false });
  });
  it("re-encodes old video codecs when the server can", () => {
    expect(chooseMode({ support: hevc, compatUrl: url, compatVideo: true, pref: null })).toEqual({ mode: "compat", video: true });
  });
  it("refuses what nothing can make playable", () => {
    expect(chooseMode({ support: hevc, compatUrl: url, pref: null })).toEqual({ mode: null, reason: "format" });
    expect(chooseMode({ support: mkvSafari, compatUrl: null, pref: null })).toEqual({ mode: null, reason: "format" });
  });
  it("a silent original still saves without a transcoder", () => {
    expect(chooseMode({ support: ac3, compatUrl: null, pref: null })).toEqual({ mode: "original" });
  });
  it("follows the compat setting", () => {
    expect(chooseMode({ support: ok, compatUrl: url, pref: "on" })).toEqual({ mode: "compat", video: false });
    expect(chooseMode({ support: ac3, compatUrl: url, pref: "off" })).toEqual({ mode: "original" });
  });
});

describe("checkSpace", () => {
  const GB = 1024 ** 3;
  it("passes with room and with unknown estimates", () => {
    expect(checkSpace({ quota: 10 * GB, usage: 1 * GB }, 4 * GB)).toEqual({ ok: true });
    expect(checkSpace(null, 4 * GB)).toEqual({ ok: true });
    expect(checkSpace({ quota: 10 * GB }, null)).toEqual({ ok: true });
  });
  it("reports need and free when short", () => {
    expect(checkSpace({ quota: 5 * GB, usage: 2 * GB }, 3 * GB)).toEqual({ ok: false, need: 3 * GB + 50 * 1024 ** 2, free: 3 * GB });
  });
});

describe("ranges", () => {
  it("parses Content-Range", () => {
    expect(parseContentRange("bytes 100-199/1000")).toEqual({ start: 100, end: 199, total: 1000 });
    expect(parseContentRange("bytes 0-9/*")).toEqual({ start: 0, end: 9, total: null });
    expect(parseContentRange(null)).toBeNull();
  });
  it("resumes, restarts or rejects", () => {
    const o = CHUNK * 2;
    expect(resumeCheck({ offset: 0, status: 200, contentRange: null, contentLength: 500, expectedTotal: null })).toEqual({ kind: "restart", total: 500 });
    expect(resumeCheck({ offset: o, status: 206, contentRange: `bytes ${o}-999999999/1000000000`, contentLength: null, expectedTotal: 1e9 })).toEqual({
      kind: "continue",
      total: 1e9,
    });
    // The server ignored the Range: start over.
    expect(resumeCheck({ offset: o, status: 200, contentRange: null, contentLength: 1e9, expectedTotal: 1e9 })).toEqual({ kind: "restart", total: 1e9 });
    // Another file / another start.
    expect(resumeCheck({ offset: o, status: 206, contentRange: `bytes 0-9/10`, contentLength: 10, expectedTotal: 10 }).kind).toBe("mismatch");
    expect(resumeCheck({ offset: o, status: 206, contentRange: `bytes ${o}-9/2000`, contentLength: 10, expectedTotal: 1000 }).kind).toBe("mismatch");
  });
});

describe("errors", () => {
  it("classifies exceptions", () => {
    expect(classifyError(new DOMException("x", "QuotaExceededError"))).toBe("quota");
    expect(classifyError(new DOMException("x", "SecurityError"))).toBe("storage");
    expect(classifyError(new TypeError("Failed to fetch"))).toBe("network");
    expect(classifyError(new TypeError("Failed to fetch"), false)).toBe("offline");
    expect(classifyError(new Error("weird"))).toBe("failed");
  });
  it("maps HTTP statuses", () => {
    expect(httpError(403)).toBe("expired");
    expect(httpError(503)).toBe("server");
  });
});

const item = (over: Partial<DeviceItem>): DeviceItem => ({ ...migrateItem({ id: "m:movie", status: "queued", ...over }) });

describe("view", () => {
  const now = 1_000_000;
  it("labels each state", () => {
    expect(deviceView(null, t, "ru", now)).toMatchObject({ label: "Скачать на устройство", action: "start", tone: "idle" });
    expect(deviceView(item({ status: "queued" }), t, "ru", now)).toMatchObject({ label: "В очереди", action: "list" });
    expect(deviceView(item({ status: "downloading", bytes: CHUNK, total: 4 * CHUNK }), t, "ru", now)).toMatchObject({ label: "Скачивается 25%", percent: 25 });
    expect(deviceView(item({ status: "saved", size: 5 }), t, "ru", now)).toMatchObject({ label: "На устройстве", action: "open", tone: "done" });
    expect(deviceView(item({ status: "paused", bytes: CHUNK, total: 2 * CHUNK }), t, "ru", now)).toMatchObject({ label: "Прервано · 50%", action: "retry" });
  });
  it("compat downloads show the size instead of a percent", () => {
    expect(deviceView(item({ status: "downloading", bytes: 1_500_000, total: null }), t, "ru", now).label).toMatch(/^Скачивается · 1[,.]4/);
  });
  it("failed: explains, and counts down a scheduled retry", () => {
    const v = deviceView(item({ status: "failed", error: "quota", errorVars: { need: 4 * 1024 ** 3, free: 1024 ** 3 } }), t, "ru", now);
    expect(v).toMatchObject({ tone: "error", action: "retry", label: "Не скачалось" });
    expect(v.note).toContain("Недостаточно места");
    expect(v.note).toContain("4");
    const r = deviceView(item({ status: "failed", error: "network", mode: "original", retryAt: now + 9500 }), t, "ru", now);
    expect(r).toMatchObject({ label: "Повторим через 10 с…", action: "list" });
    expect(r.note).toContain("продолжим");
  });
  it("error texts", () => {
    expect(errorText(item({ status: "failed", error: "network", mode: "compat" }), t, "ru")).toContain("заново");
    expect(errorText(item({ status: "failed", error: "storage" }), t, "ru")).toContain("хранилище");
    expect(errorText(item({ status: "failed", error: "format", errorVars: { codec: "HEVC" } }), t, "ru")).toContain("HEVC");
    expect(errorText(item({ status: "failed", error: "source", errorCode: "no_metadata" }), t, "ru")).toBeTruthy();
    expect(errorText(item({ status: "paused", autoResume: true }), t, "ru")).toContain("Нет интернета");
    expect(errorText(item({ status: "saved" }), t, "ru")).toBeNull();
  });
  it("season counts", () => {
    expect(seasonState([item({ status: "saved" }), item({ status: "downloading" }), null, item({ status: "failed" })])).toEqual({ total: 4, saved: 1, running: 1, failed: 1 });
  });
});

describe("store items", () => {
  it("migrates saves of older builds (no status) as saved single entries", () => {
    const it0 = migrateItem({ id: "a:movie", mediaId: "a", title: "Film", size: 123_456_789, at: 5 } as never);
    expect(it0).toMatchObject({ status: "saved", legacy: true, bytes: 123_456_789, total: 123_456_789, title: "Film" });
  });
  it("interrupted jobs pause; compat ones lose their bytes", () => {
    expect(interruptItem(item({ status: "downloading", mode: "original", chunks: 3, bytes: 3 * CHUNK + 7 }))).toMatchObject({ status: "paused", chunks: 3 });
    expect(interruptItem(item({ status: "downloading", mode: "compat", chunks: 3, bytes: 3 * CHUNK }))).toMatchObject({ status: "paused", chunks: 0, bytes: 0 });
    const saved = item({ status: "saved" });
    expect(interruptItem(saved)).toBe(saved);
  });
});

// ---------------------------------------------------------------- service worker

/** Runs public/offline-video-sw.js against an in-memory Cache Storage. */
function loadSw() {
  const store = new Map<string, Response>();
  const cache = {
    match: async (k: string) => store.get(new URL(k, "https://app.test").pathname)?.clone(),
  };
  let handler: ((e: { request: Request; respondWith: (p: Promise<Response>) => void }) => void) | null = null;
  const self = {
    location: { origin: "https://app.test" },
    addEventListener: (_: string, fn: typeof handler) => {
      handler = fn;
    },
  };
  const code = readFileSync(new URL("../../public/offline-video-sw.js", import.meta.url), "utf8");
  new Function("self", "caches", code)(self, { open: async () => cache });
  const fetch = (path: string, headers: Record<string, string> = {}) =>
    new Promise<Response>((resolve) => {
      handler!({ request: new Request(`https://app.test${path}`, { headers }), respondWith: (p) => void p.then(resolve) });
    });
  return { store, fetch };
}

describe("offline-video-sw.js", () => {
  const bytes = Uint8Array.from({ length: 10 }, (_, i) => i);
  const sw = () => {
    const s = loadSw();
    const base = "/offline-video/m%3Amovie";
    s.store.set(`${base}/m`, new Response(JSON.stringify({ v: 2, size: 10, chunk: 4, count: 3, type: "video/x-matroska" })));
    s.store.set(`${base}/c/0`, new Response(bytes.slice(0, 4)));
    s.store.set(`${base}/c/1`, new Response(bytes.slice(4, 8)));
    s.store.set(`${base}/c/2`, new Response(bytes.slice(8, 10)));
    return { ...s, base };
  };

  it("serves the whole file from chunks", async () => {
    const { fetch, base } = sw();
    const r = await fetch(base);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Length")).toBe("10");
    expect(r.headers.get("Content-Type")).toBe("video/x-matroska");
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([...bytes]);
  });

  it("serves ranges across chunk boundaries", async () => {
    const { fetch, base } = sw();
    const r = await fetch(base, { Range: "bytes=3-8" });
    expect(r.status).toBe(206);
    expect(r.headers.get("Content-Range")).toBe("bytes 3-8/10");
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([3, 4, 5, 6, 7, 8]);
    const tail = await fetch(base, { Range: "bytes=-3" });
    expect([...new Uint8Array(await tail.arrayBuffer())]).toEqual([7, 8, 9]);
    const open = await fetch(base, { Range: "bytes=0-" });
    expect(open.headers.get("Content-Length")).toBe("10");
    expect((await fetch(base, { Range: "bytes=20-" })).status).toBe(416);
  });

  it("serves legacy single-entry saves and 404s partial ones", async () => {
    const { fetch, store } = loadSw();
    store.set("/offline-video/old", new Response(new Blob([bytes]), { headers: { "Content-Type": "video/mp4" } }));
    const r = await fetch("/offline-video/old", { Range: "bytes=2-4" });
    expect(r.status).toBe(206);
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([2, 3, 4]);
    store.set("/offline-video/partial/c/0", new Response(bytes));
    expect((await fetch("/offline-video/partial")).status).toBe(404);
  });
});
