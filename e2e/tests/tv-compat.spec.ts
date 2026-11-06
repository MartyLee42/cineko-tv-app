// TV playback fixes end to end:
// 1. Compat audio on the TV: an AC3 source (Chromium can't decode AC3) plays
//    through the dev stack's real transcoder (fMP4 + AAC): picked
//    automatically, audio decodes, a seek restarts with start=, the track
//    panel switches audio= and the reported position is offset-corrected.
//    Same wiring as web-compat.spec: Playwright routes stand in for the API's
//    proxy, a fake TorrServer in this process serves fixtures/compat-ac3.mkv.
// 2. A throttled stream shows «Буферизация… N%» and waits (no flapping).
// 3. Inside Media Station X (simulated WebView UA + bridge heartbeat) the
//    external players are hidden with a hint, unless the bridge can launch
//    apps (MSX ≥ 0.1.136 on Android): then they go through the bridge.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import { expect, test, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import { quietHome } from "./quietHome";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
const TC_URL = process.env.TRANSCODER_URL ?? "http://transcoder:8090";
const TC_SECRET = process.env.TRANSCODER_SECRET ?? "dev-only-transcoder-secret-0123456789abcdef";
const MKV = readFileSync(new URL("../fixtures/compat-ac3.mkv", import.meta.url));
/** 40 s VP8/Opus WebM, ~60 kbit/s. */
const CLIP = readFileSync(new URL("../fixtures/clip.webm", import.meta.url));

const SRC_ID = "c0a7c0a7-0000-4000-8000-000000007001";
const SLOW_ID = "5e1ec7ed-0000-4000-8000-00000000b7b7";
const TOKEN = "tok-tvac3";
const TX3_MSX_UA = "Mozilla/5.0 (Linux; Android 11; TX3 Build/RQ1A.210105.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36";

// ---------------------------------------------------------------- fake TorrServer + transcoder jobs

let tsInput = "";
let tsServer: http.Server | null = null;

async function startTorrServer(): Promise<string> {
  const server = http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), MKV.length - 1) : MKV.length - 1;
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", "video/x-matroska");
    if (m) {
      if (start >= MKV.length) {
        res.writeHead(416, { "Content-Range": `bytes */${MKV.length}` }).end();
        return;
      }
      res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${MKV.length}`, "Content-Length": String(end - start + 1) });
    } else res.writeHead(200, { "Content-Length": String(MKV.length) });
    res.end(MKV.subarray(start, end + 1));
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  tsServer = server;
  const ip =
    Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal)?.address ?? "127.0.0.1";
  return `http://${ip}:${(server.address() as AddressInfo).port}/stream?link=c0a7&index=1&play`;
}

test.beforeAll(async () => {
  tsInput = await startTorrServer();
});
test.afterAll(() => {
  tsServer?.close();
});

const jobKey = createHmac("sha256", TC_SECRET).update("martytv/transcoder/job/v1").digest();
function job(kind: "remux" | "keyframe", fields: Record<string, number | boolean | undefined>) {
  const body = JSON.stringify({ v: 1, kind, input: tsInput, exp: Math.floor(Date.now() / 1000) + 60, ...fields });
  return fetch(`${TC_URL}/v1/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Job-Signature": createHmac("sha256", jobKey).update(body).digest("hex") },
    body,
  });
}

// ---------------------------------------------------------------- TV harness

interface Ack {
  ok: boolean;
  error?: string;
  result?: Record<string, unknown>;
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** No first-run guide / continue-watching; sessions mocked, progress captured. */
async function isolateWatch(ctx: BrowserContext, reports: { state: string; position_seconds: number }[]) {
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch().catch(() => null);
    const body = res && res.ok() ? await res.json() : {};
    return json(route, { ...body, onboarding_completed: true });
  });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, (route) => json(route, { items: [] }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/progress/, (route) => json(route, { media_id: "x", kind: "movie", movie: null, episodes: [], seasons: [], next_up: null }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/online/, (route) => json(route, { items: [], providers: [], searched_at: new Date().toISOString(), cached: true }));
  await ctx.route(/\/api\/v1\/playback\/sessions(\?.*)?$/, (route) =>
    json(route, { id: "5e550000-0000-4000-8000-00000000c7c7", resume_position_seconds: null, progress: null, report_token: "x" }, 201),
  );
  await ctx.route(/\/api\/v1\/playback\/sessions\/[^/]+\/progress/, (route) => {
    const b = JSON.parse(route.request().postData() ?? "{}") as { state: string; position_seconds: number };
    reports.push({ state: b.state, position_seconds: b.position_seconds });
    return json(route, { accepted: true, progress: null });
  });
  await ctx.route(/\/api\/v1\/messages(\?.*)?$/, (route) => json(route, { items: [], unread: 0 }));
  // The TV reads the profile's preferences (read-only); none set here.
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/preferences/, (route) =>
    json(route, { ui_language: "en", preferred_audio_languages: [], preferred_subtitle_languages: [], preferred_resolution: "", max_size_gb: null, preferred_codecs: [], preferred_voiceovers: [] }),
  );
}


async function press(tv: Page, key: string, times = 1) {
  for (let i = 0; i < times; i++) {
    await tv.keyboard.press(key);
    await tv.waitForTimeout(160);
  }
}

async function sendCommand(phone: Page, deviceId: string, body: { type: string; payload?: unknown }): Promise<Ack> {
  return phone.evaluate(
    async ({ deviceId, body }) => {
      const session = await (await fetch("/api/v1/auth/session")).json();
      const r = await fetch(`/api/v1/devices/${deviceId}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrf_token },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`commands: HTTP ${r.status} ${await r.text()}`);
      return r.json();
    },
    { deviceId, body },
  );
}

interface Harness {
  phone: Page;
  tv: Page;
  tvCtx: BrowserContext;
  deviceId: string;
  movieId: string;
  reports: { state: string; position_seconds: number }[];
  close(): Promise<void>;
}

/** Phone signs in, pairs a fresh TV (optionally with a UA / init script), lands on Home. */
async function pairTv(browser: Browser, opts: { userAgent?: string; init?: () => void } = {}, mock?: (ctx: BrowserContext, movieId: () => string) => Promise<void>): Promise<Harness> {
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US", ...(opts.userAgent ? { userAgent: opts.userAgent } : {}) });
  await quietHome(tvCtx);
  // Short mocked clips: rate estimates from the first second (no torrent warm-up).
  await tvCtx.addInitScript(() => {
    (globalThis as { __martytvRateWarmupMs?: number }).__martytvRateWarmupMs = 0;
  });
  if (opts.init) await tvCtx.addInitScript(opts.init);
  const reports: Harness["reports"] = [];
  await isolateWatch(tvCtx, reports);
  const phone = await phoneCtx.newPage();
  const tv = await tvCtx.newPage();
  await phone.goto("/login");
  await phone.getByLabel(/username/i).fill(USER);
  await phone.getByLabel(/password/i).fill(PASS);
  await phone.getByRole("button", { name: /sign in/i }).click();
  await expect(phone.getByRole("heading", { name: /welcome/i })).toBeVisible();
  const origin = new URL(phone.url()).origin;
  const session = await (await phoneCtx.request.get("/api/v1/auth/session")).json();
  const profiles = await (await phoneCtx.request.get("/api/v1/profiles")).json();
  if (profiles.items.length === 0) {
    const r = await phoneCtx.request.post("/api/v1/profiles", { data: { name: "E2E", color: "#6366f1" }, headers: { "X-CSRF-Token": session.csrf_token, Origin: origin } });
    expect(r.ok()).toBeTruthy();
  }
  const search = await (await phoneCtx.request.get(`/api/v1/catalog/search?q=${encodeURIComponent("The Shawshank Redemption")}&kind=movie&lang=en`)).json();
  const movieId = search.items[0].id as string;
  if (mock) await mock(tvCtx, () => movieId);

  // Pairing codes are rate-limited per IP (10/min, shared with parallel
  // runs): wait and retry instead of failing on a busy minute.
  const codeEl = tv.locator("p.font-mono");
  for (let attempt = 0; ; attempt++) {
    await tv.goto("/tv/");
    const ok = await expect(codeEl)
      .toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/, { timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (ok) break;
    if (attempt >= 3) await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    await tv.waitForTimeout(20_000);
  }
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E TVPlay ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });
  const devices = await (await phoneCtx.request.get("/api/v1/devices")).json();
  const deviceId = devices.items.find((d: { name: string }) => d.name === deviceName).id as string;
  const who = tv.getByRole("heading", { name: /who's watching/i });
  if (await who.isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");
  await expect(tv.getByText("Trending this week")).toBeVisible({ timeout: 30_000 });
  return {
    phone,
    tv,
    tvCtx,
    deviceId,
    movieId,
    reports,
    close: async () => {
      await phoneCtx.request.delete(`/api/v1/devices/${deviceId}`, { headers: { "X-CSRF-Token": session.csrf_token, Origin: origin } }).catch(() => undefined);
      await tvCtx.close();
      await phoneCtx.close();
    },
  };
}

function baseRelease(id: string, p: Record<string, unknown> = {}) {
  return {
    id,
    title: `Mock.${id}`,
    indexer: "RuTracker",
    size_bytes: 2_000_000_000,
    seeders: 40,
    leechers: 2,
    published_at: null,
    info_hash: null,
    resolution: "1080p",
    video_codec: "h264",
    hdr: null,
    audio_codecs: ["ac3"],
    languages: ["ru"],
    voiceovers: [],
    release_group: null,
    source_quality: "web-dl",
    year: 1994,
    seasons: [],
    episodes: [],
    is_season_pack: false,
    confidence: 0.95,
    score: 1,
    reasons: [],
    warnings: [],
    ...p,
  };
}

const MEDIA_INFO = {
  container: "matroska,webm",
  video_codec: "h264",
  width: 320,
  height: 180,
  duration_seconds: 90,
  audio: [
    { index: 1, codec: "ac3", language: "rus", title: "Дубляж", channels: 2, default: true },
    { index: 2, codec: "ac3", language: "rus", title: "MVO LostFilm", channels: 2, default: false },
  ],
  subtitles: [],
};

/** An XviD AVI as ffprobe sees it (prod: The Last Duel): Chromium has no MPEG-4 Part 2 decoder. */
const XVID_INFO = { ...MEDIA_INFO, container: "avi", video_codec: "mpeg4", video_profile: "Advanced Simple Profile", width: 720, height: 304 };

interface CompatLog {
  heads: { start: number; k: number; video?: string | null }[];
  compat: { audio: number | null; start: number; k: string | null; video?: string | null }[];
  native: number;
}

/**
 * xvid: the source is an XviD AVI the server can re-encode (compat_video).
 * The dev transcoder still gets the fixture's H.264 MKV (no video field):
 * what is checked is that the TV asks for video=h264 from the first load.
 */
async function mockCompat(ctx: BrowserContext, movieId: () => string, log: CompatLog, opts: { infoAfterGets?: number; audioCodecs?: string[]; xvid?: boolean } = {}) {
  let gets = 0;
  const source = (withInfo = true) => ({
    id: SRC_ID,
    media_id: movieId(),
    episode_id: null,
    release: baseRelease("rel-tvac3", opts.audioCodecs ? { audio_codecs: opts.audioCodecs } : {}),
    status: "ready",
    error: null,
    file: { index: 1, path: "Movie/movie.mkv", size_bytes: MKV.length, is_video: true, season: null, episode: null },
    stream_url: `/api/v1/stream/${TOKEN}`,
    stream_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    compat_url: `/api/v1/stream/${TOKEN}/compat.mp4`,
    compat_video: !!opts.xvid && withInfo,
    mime_type: opts.xvid ? "video/x-msvideo" : "video/x-matroska",
    media_info: withInfo ? (opts.xvid ? XVID_INFO : MEDIA_INFO) : null,
    torrent: { peers: 10, seeders: 9, download_speed_bps: 3_200_000, preloaded_bytes: 50_000_000 },
    created_at: new Date().toISOString(),
    kind: "torrent",
  });
  await ctx.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) => json(route, { items: [baseRelease("rel-tvac3")], searched_at: new Date().toISOString(), cached: false, indexer_errors: [] }));
  await ctx.route(/\/api\/v1\/playback\/sources(\/[^/?]+)?(\?.*)?$/, (route) => {
    // infoAfterGets: like a first play in prod — the server's ffprobe runs
    // only after the source is read live, media_info shows up a bit later.
    const post = route.request().method() === "POST";
    const withInfo = opts.infoAfterGets === undefined || (!post && ++gets > opts.infoAfterGets);
    return json(route, source(withInfo), post ? 201 : 200);
  });
  await ctx.route(new RegExp(`/api/v1/stream/${TOKEN}$`), (route) => {
    log.native++;
    return route.fulfill({ status: 200, headers: { "Content-Type": "video/x-matroska", "Accept-Ranges": "bytes" }, body: MKV });
  });
  await ctx.route(new RegExp(`/api/v1/stream/${TOKEN}/compat\\.mp4`), async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const audio = u.searchParams.has("audio") ? Number(u.searchParams.get("audio")) : null;
    const start = Number(u.searchParams.get("start") ?? 0);
    const video = u.searchParams.get("video");
    const fields = { audio: audio ?? 1, start: start || undefined };
    if (req.method() === "HEAD") {
      let k = 0;
      if (start > 0) k = ((await (await job("keyframe", fields)).json()) as { start: number }).start;
      log.heads.push(opts.xvid ? { start, k, video } : { start, k });
      return route.fulfill({ status: 200, headers: { "Content-Type": "video/mp4", "Accept-Ranges": "none", "X-Stream-Start": k.toFixed(3) }, body: "" });
    }
    const r = await job("remux", fields);
    const body = Buffer.from(await r.arrayBuffer());
    log.compat.push(opts.xvid ? { audio, start, k: r.headers.get("x-stream-start"), video } : { audio, start, k: r.headers.get("x-stream-start") });
    return route.fulfill({
      status: r.status,
      headers: { "Content-Type": r.headers.get("content-type") ?? "video/mp4", "Accept-Ranges": "none", "X-Stream-Start": r.headers.get("x-stream-start") ?? "0" },
      body,
    });
  });
}

const tvVideo = (tv: Page) => tv.locator("[data-testid=player] video");
const audioBytes = (tv: Page) => tvVideo(tv).evaluate((v: HTMLVideoElement) => (v as HTMLVideoElement & { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount ?? -1);

test("TV compat audio: auto AAC conversion, seek restarts with start=, track switch changes audio=", async ({ browser }) => {
  test.setTimeout(180_000);
  const log: CompatLog = { heads: [], compat: [], native: 0 };
  const h = await pairTv(browser, {}, (ctx, id) => mockCompat(ctx, id, log));
  const { tv, phone, deviceId } = h;
  try {
    const serverState = async () => (await (await phone.context().request.get(`/api/v1/devices/${deviceId}/state`)).json()).state;
    const play = await sendCommand(phone, deviceId, { type: "media.play", payload: { media_id: h.movieId, source_id: SRC_ID, position_seconds: 20 } });
    expect(play.ok, JSON.stringify(play)).toBe(true);

    // AC3 can't be decoded by this engine, the server has a compat stream →
    // compat from the start, with the file's default track (stream 1: the
    // profile has no voice-over preference).
    await expect(tv.getByTestId("player")).toHaveAttribute("data-compat", "on", { timeout: 20_000 });
    await expect.poll(() => log.compat.length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(log.heads[0]).toEqual({ start: 20, k: 20 });
    expect(log.compat[0]).toMatchObject({ audio: 1, start: 20 });
    expect(log.native).toBe(0);
    await expect.poll(() => audioBytes(tv), { timeout: 20_000 }).toBeGreaterThan(0);
    // The shown/reported position is the stream start + element time.
    await expect.poll(async () => (await serverState()).playback?.position_seconds ?? 0, { timeout: 15_000 }).toBeGreaterThanOrEqual(21);
    const el = await tvVideo(tv).evaluate((v: HTMLVideoElement) => v.currentTime);
    expect(el).toBeLessThan(15);

    // OSD note and the stats line say the audio is converted.
    // Up toggles the controls: show them if hidden.
    if ((await tv.getByTestId("player-controls").count()) === 0) await press(tv, "ArrowUp");
    await expect(tv.getByTestId("player-compat")).toContainText(/Audio is being converted/);

    // Right seeks +30 s: outside a non-seekable stream's buffer → restart at start≈50.
    const n = log.compat.length;
    const before = (await serverState()).playback.position_seconds as number;
    await tv.keyboard.press("ArrowRight");
    await expect.poll(() => log.compat.length, { timeout: 25_000 }).toBeGreaterThan(n);
    const seek = log.compat[n]!;
    expect(seek.audio).toBe(1);
    expect(seek.start).toBeGreaterThanOrEqual(before + 27);
    expect(seek.start).toBeLessThanOrEqual(before + 34);
    await expect.poll(async () => (await serverState()).playback?.position_seconds ?? 0, { timeout: 20_000 }).toBeGreaterThanOrEqual(Math.floor(Number(seek.k)));

    // Down: the panel lists the file's tracks + «Compatible audio (AAC)» (on «Дубляж»); Down+OK picks «MVO LostFilm» → audio=2.
    await press(tv, "ArrowDown");
    const panel = tv.getByTestId("player-tracks");
    await expect(panel).toContainText("MVO LostFilm");
    await expect(panel).toContainText("Compatible audio (AAC)");
    const m = log.compat.length;
    await press(tv, "ArrowDown");
    await press(tv, "Enter");
    await expect.poll(() => log.compat.length, { timeout: 25_000 }).toBeGreaterThan(m);
    expect(log.compat.at(-1)!.audio).toBe(2);
    await expect.poll(() => audioBytes(tv), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await serverState()).playback?.audio_track_id, { timeout: 10_000 }).toBe("a1");
    await press(tv, "Escape");

    // Progress reports carry the absolute position (never the element's small one).
    await press(tv, "Enter");
    await expect.poll(() => h.reports.find((r) => r.state === "paused")?.position_seconds ?? 0, { timeout: 15_000 }).toBeGreaterThanOrEqual(45);
  } finally {
    await h.close();
  }
});

test("TV compat off: undecodable audio shows a notice, OK turns compatible sound back on", async ({ browser }) => {
  test.setTimeout(180_000);
  const log: CompatLog = { heads: [], compat: [], native: 0 };
  // «Совместимый звук» switched off on this TV (the setting a family member had set by accident).
  const h = await pairTv(browser, { init: () => localStorage.setItem("martytv.tv_compat", "off") }, (ctx, id) => mockCompat(ctx, id, log));
  const { tv, phone, deviceId } = h;
  try {
    const play = await sendCommand(phone, deviceId, { type: "media.play", payload: { media_id: h.movieId, source_id: SRC_ID, position_seconds: 0 } });
    expect(play.ok, JSON.stringify(play)).toBe(true);
    // AC3 can't play in this engine and conversion is off: the notice, no compat stream yet.
    const notice = tv.getByTestId("player-compat-off");
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice).toContainText("AC3");
    expect(log.compat).toHaveLength(0);
    // OK: back to «Авто», the compat stream starts, the notice goes away.
    await tv.keyboard.press("Enter");
    await expect.poll(() => log.compat.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(tv.getByTestId("player")).toHaveAttribute("data-compat", "on", { timeout: 20_000 });
    await expect(notice).toHaveCount(0);
    expect(await tv.evaluate(() => localStorage.getItem("martytv.tv_compat"))).toBeNull();
  } finally {
    await h.close();
  }
});

test("TV XviD AVI: the server converts the video to H.264 from the first frame", async ({ browser }) => {
  test.setTimeout(180_000);
  const log: CompatLog = { heads: [], compat: [], native: 0 };
  const h = await pairTv(browser, {}, (ctx, id) => mockCompat(ctx, id, log, { xvid: true }));
  const { tv, phone, deviceId } = h;
  try {
    const play = await sendCommand(phone, deviceId, { type: "media.play", payload: { media_id: h.movieId, source_id: SRC_ID, position_seconds: 20 } });
    expect(play.ok, JSON.stringify(play)).toBe(true);
    // MPEG-4 Part 2 can't be decoded here and the server converts it: compat
    // with video=h264 right away, never the original AVI, no decode error first.
    await expect(tv.getByTestId("player")).toHaveAttribute("data-compat-video", "on", { timeout: 20_000 });
    await expect.poll(() => log.compat.length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(log.heads[0]).toMatchObject({ start: 20, video: "h264" });
    expect(log.compat[0]).toMatchObject({ audio: 1, start: 20, video: "h264" });
    expect(log.native).toBe(0);
    await expect.poll(() => tvVideo(tv).evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20_000 }).toBeGreaterThan(0.5);
    // No «may not play» warning while it's converted; the OSD and stats say so.
    await expect(tv.getByTestId("player-warning")).toHaveCount(0);
    if ((await tv.getByTestId("player-controls").count()) === 0) await press(tv, "ArrowUp");
    await expect(tv.getByTestId("player-compat")).toContainText("Video is being converted on the server");
    await expect(tv.getByTestId("player-stats")).toContainText("H.264 (from MPEG-4 (XviD))");
    // A seek restarts the converted stream (video=h264 kept).
    const n = log.compat.length;
    await tv.keyboard.press("ArrowRight");
    await expect.poll(() => log.compat.length, { timeout: 25_000 }).toBeGreaterThan(n);
    expect(log.compat[n]!.video).toBe("h264");
  } finally {
    await h.close();
  }
});

test("TV compat off + XviD: the notice names the video, OK starts the conversion", async ({ browser }) => {
  test.setTimeout(180_000);
  const log: CompatLog = { heads: [], compat: [], native: 0 };
  const h = await pairTv(browser, { init: () => localStorage.setItem("martytv.tv_compat", "off") }, (ctx, id) => mockCompat(ctx, id, log, { xvid: true }));
  const { tv, phone, deviceId } = h;
  try {
    const play = await sendCommand(phone, deviceId, { type: "media.play", payload: { media_id: h.movieId, source_id: SRC_ID, position_seconds: 0 } });
    expect(play.ok, JSON.stringify(play)).toBe(true);
    const notice = tv.getByTestId("player-compat-off");
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice).toContainText("MPEG-4 (XviD) video");
    expect(log.compat).toHaveLength(0);
    await tv.keyboard.press("Enter");
    await expect.poll(() => log.compat.length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(log.compat[0]!.video).toBe("h264");
    await expect(notice).toHaveCount(0);
  } finally {
    await h.close();
  }
});

test("TV rebuffer: a throttled stream waits with «Buffering… N%» instead of flapping", async ({ browser }) => {
  test.setTimeout(150_000);
  const FIRST_CHUNK = 64 << 10;
  const SLOW_CHUNK = 2 << 10;
  const SLOW_MS = 400;
  const SLOW_FOR_MS = 14_000;
  let firstAt = 0;
  const h = await pairTv(browser, {}, async (ctx, movieId) => {
    const release = baseRelease("rel-slow", { size_bytes: CLIP.length, audio_codecs: ["opus"], video_codec: null });
    const source = () => ({
      id: SLOW_ID,
      media_id: movieId(),
      episode_id: null,
      release,
      status: "ready",
      error: null,
      file: { index: 1, path: "Movie/movie.webm", size_bytes: CLIP.length, is_video: true, season: null, episode: null },
      stream_url: "/api/v1/stream/tok-tvslow",
      stream_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      compat_url: null,
      mime_type: "video/webm",
      media_info: { container: "matroska,webm", video_codec: "vp8", width: 320, height: 180, duration_seconds: 40, audio: [{ index: 1, codec: "opus", language: "en", title: null, channels: 1, default: true }], subtitles: [] },
      torrent: { peers: 3, seeders: 2, download_speed_bps: 5000, preloaded_bytes: 0 },
      created_at: new Date().toISOString(),
      kind: "torrent",
    });
    await ctx.route(/\/api\/v1\/playback\/sources(\/[^/?]+)?(\?.*)?$/, (route) => json(route, source(), route.request().method() === "POST" ? 201 : 200));
    await ctx.route(/\/api\/v1\/stream\/tok-tvslow/, async (route) => {
      const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers()["range"] ?? "");
      const start = m ? Number(m[1]) : 0;
      const wantEnd = m && m[2] ? Number(m[2]) : CLIP.length - 1;
      if (!firstAt) firstAt = Date.now();
      const slow = Date.now() - firstAt < SLOW_FOR_MS;
      let size = CLIP.length - start;
      if (start === 0) size = FIRST_CHUNK;
      else if (slow) {
        size = SLOW_CHUNK;
        await new Promise((r) => setTimeout(r, SLOW_MS));
      }
      const end = Math.min(CLIP.length - 1, wantEnd, start + size - 1);
      return route.fulfill({
        status: 206,
        headers: { "Content-Type": "video/webm", "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${CLIP.length}` },
        body: CLIP.subarray(start, end + 1),
      });
    });
  });
  const { tv, phone, deviceId } = h;
  try {
    const play = await sendCommand(phone, deviceId, { type: "media.play", payload: { media_id: h.movieId, source_id: SLOW_ID, position_seconds: 0 } });
    expect(play.ok, JSON.stringify(play)).toBe(true);
    const playerEl = tv.getByTestId("player");
    await expect(tvVideo(tv)).toHaveCount(1, { timeout: 20_000 });
    await tvVideo(tv).evaluate((v: HTMLVideoElement) => {
      const w = window as unknown as { flips: number[] };
      w.flips = [];
      v.addEventListener("playing", () => w.flips.push(performance.now()));
    });

    // The first chunk runs out → a stall → the TV pauses itself and waits.
    await expect(playerEl).toHaveAttribute("data-rebuffering", "true", { timeout: 40_000 });
    await expect(tv.getByTestId("player-rebuffer")).toContainText(/Buffering… \d+%/);
    await expect(tv.getByTestId("player-rebuffer")).toContainText(/s ahead/);
    const t0 = await tv.evaluate(() => performance.now());
    const slowLeft = SLOW_FOR_MS - (Date.now() - firstAt);
    if (slowLeft > 1000) await tv.waitForTimeout(slowLeft - 500);
    const flips = await tv.evaluate((since) => (window as unknown as { flips: number[] }).flips.filter((x) => x > since).length, t0);
    expect(flips).toBe(0);
    await expect(playerEl).toHaveAttribute("data-rebuffering", "true");
    // Still «playing» for the server and the remote (not the user's pause).
    await expect(playerEl).toHaveAttribute("data-paused", "0");

    // Full speed → resumes by itself once the buffer is deep enough.
    await expect(playerEl).toHaveAttribute("data-rebuffering", "false", { timeout: 30_000 });
    const at = await tvVideo(tv).evaluate((v: HTMLVideoElement) => v.currentTime);
    await expect.poll(() => tvVideo(tv).evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 }).toBeGreaterThan(at + 1);
    expect(h.reports.map((r) => r.state)).not.toContain("paused");
  } finally {
    await h.close();
  }
});

test("Inside MSX: external players hidden with a hint; with MSX's launch action they go through the bridge", async ({ browser }) => {
  test.setTimeout(240_000);
  // An MSX WebView without launch support (bridge heartbeat says launch: false).
  const h = await pairTv(
    browser,
    {
      userAgent: TX3_MSX_UA,
      init: () => {
        const beat = () => localStorage.setItem("martytv.msx_bridge", JSON.stringify({ alive_at: Date.now(), platform: "android", version: "0.1.120", launch: false }));
        beat();
        setInterval(beat, 3000);
        localStorage.removeItem("martytv.default_player");
      },
    },
    (ctx, id) => mockCompat(ctx, id, { heads: [], compat: [], native: 0 }),
  );
  try {
    const play = await sendCommand(h.phone, h.deviceId, { type: "media.play", payload: { media_id: h.movieId, source_id: SRC_ID } });
    expect(play.ok, JSON.stringify(play)).toBe(true);
    const chooser = h.tv.getByTestId("player-chooser");
    await expect(chooser).toBeVisible({ timeout: 20_000 });
    await expect(chooser).toContainText(/Media Station X/);
    await expect(chooser).not.toContainText(/VLC|MX Player/);
    await expect(h.tv.getByTestId("player-chooser-msx-hint")).toContainText("External players aren't available inside Media Station X");
    // MSX's player is recommended (★).
    await expect(chooser).toContainText("★");
  } finally {
    await h.close();
  }

  // MSX ≥ 0.1.136 on Android: the bridge launches the app (system:tvx:launch).
  const h2 = await pairTv(
    browser,
    {
      userAgent: TX3_MSX_UA,
      init: () => {
        const beat = () => localStorage.setItem("martytv.msx_bridge", JSON.stringify({ alive_at: Date.now(), platform: "android", version: "0.1.160", launch: true }));
        beat();
        setInterval(beat, 3000);
        localStorage.removeItem("martytv.default_player");
        // Stand-in bridge: records launches, acks them, then reports «could not launch» (-2).
        const w = window as unknown as { __launch: unknown[] };
        w.__launch = [];
        const ch = new BroadcastChannel("martytv-msx");
        ch.onmessage = (e) => {
          const m = e.data as { type: string; id: string };
          if (m.type !== "launch") return;
          w.__launch.push(m);
          ch.postMessage({ type: "ack", id: m.id, ok: true });
          setTimeout(() => ch.postMessage({ type: "result", id: m.id, code: -2 }), 800);
        };
      },
    },
    (ctx, id) => mockCompat(ctx, id, { heads: [], compat: [], native: 0 }),
  );
  try {
    const play = await sendCommand(h2.phone, h2.deviceId, { type: "media.play", payload: { media_id: h2.movieId, source_id: SRC_ID } });
    expect(play.ok, JSON.stringify(play)).toBe(true);
    const chooser = h2.tv.getByTestId("player-chooser");
    await expect(chooser).toBeVisible({ timeout: 20_000 });
    await expect(chooser).toContainText("VLC");
    await expect(h2.tv.getByTestId("player-chooser-msx-hint")).toHaveCount(0);
    await chooser.getByText("VLC").click();
    await expect.poll(() => h2.tv.evaluate(() => (window as unknown as { __launch: { app: string; url: string }[] }).__launch.length), { timeout: 15_000 }).toBe(1);
    const sent = (await h2.tv.evaluate(() => (window as unknown as { __launch: { app: string; url: string }[] }).__launch[0]))!;
    expect(sent.app).toBe("vlc");
    expect(sent.url).toMatch(/\/api\/v1\/stream\/tok-tvac3\/movie\.mkv$/);
    // MSX reported «could not launch»: a friendly error with the alternatives.
    await expect(h2.tv.getByTestId("player-failed")).toHaveAttribute("data-code", "external_failed", { timeout: 15_000 });
    await expect(h2.tv.getByTestId("player-failed-text")).toContainText("Try the MSX player");
  } finally {
    await h2.close();
  }
});

// ---------------------------------------------------------------- prod regressions (TX3 in MSX, Samsung in MSX)

const bootId = (tv: Page) => tv.evaluate(() => (window as unknown as { __bootId?: string }).__bootId ?? null);
const TIZEN_MSX_UA = "Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36";
/** MSX hosting the app: the bridge heartbeat, built-in player as the default (no chooser). */
const msxInit = () => {
  const beat = () => localStorage.setItem("martytv.msx_bridge", JSON.stringify({ alive_at: Date.now(), platform: "android", version: "0.1.160", launch: false }));
  beat();
  setInterval(beat, 3000);
  localStorage.setItem("martytv.default_player", "builtin");
};

test("first play after the update: no compat flag, no media_info yet → compat from the first frame", async ({ browser }) => {
  test.setTimeout(150_000);
  const log: CompatLog = { heads: [], compat: [], native: 0 };
  // Like prod: the release title gave no audio codecs; media_info appears after a few GETs (server ffprobe).
  const h = await pairTv(browser, {}, (ctx, id) => mockCompat(ctx, id, log, { infoAfterGets: 2, audioCodecs: [] }));
  const { tv, phone, deviceId } = h;
  try {
    expect(await tv.evaluate(() => localStorage.getItem("martytv.tv_compat_server"))).toBeNull();
    const play = await sendCommand(phone, deviceId, { type: "media.play", payload: { media_id: h.movieId, source_id: SRC_ID, position_seconds: 0 } });
    expect(play.ok, JSON.stringify(play)).toBe(true);
    await expect.poll(() => log.compat.length, { timeout: 40_000 }).toBeGreaterThan(0);
    await expect(tv.getByTestId("player")).toHaveAttribute("data-compat", "on");
    expect(log.native).toBe(0);
    await expect.poll(() => audioBytes(tv), { timeout: 20_000 }).toBeGreaterThan(0);
    expect(log.native).toBe(0);
  } finally {
    await h.close();
  }
});

test("slow-link hint: Back dismisses it for this playback, «Not now» works, playback goes on", async ({ browser }) => {
  test.setTimeout(240_000);
  const SLOW_CHUNK = 2 << 10;
  const SLOW_MS = 400;
  const h = await pairTv(browser, {}, async (ctx, movieId) => {
    const release = baseRelease("rel-slow", { size_bytes: CLIP.length, audio_codecs: ["opus"], video_codec: null });
    const source = () => ({
      id: SLOW_ID,
      media_id: movieId(),
      episode_id: null,
      release,
      status: "ready",
      error: null,
      file: { index: 1, path: "Movie/movie.webm", size_bytes: CLIP.length, is_video: true, season: null, episode: null },
      stream_url: "/api/v1/stream/tok-tvhint",
      stream_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      compat_url: null,
      mime_type: "video/webm",
      media_info: { container: "matroska,webm", video_codec: "vp8", width: 320, height: 180, duration_seconds: 40, audio: [{ index: 1, codec: "opus", language: "en", title: null, channels: 1, default: true }], subtitles: [] },
      torrent: { peers: 3, seeders: 1, download_speed_bps: 5000, preloaded_bytes: 0 },
      created_at: new Date().toISOString(),
      kind: "torrent",
    });
    await ctx.route(/\/api\/v1\/playback\/sources(\/[^/?]+)?(\?.*)?$/, (route) => json(route, source(), route.request().method() === "POST" ? 201 : 200));
    // The hint is off by default: turn it on for this TV.
    await ctx.addInitScript(() => localStorage.setItem("martytv.slow_hint", "1"));
    // ~5 KB/s for a ~7.5 KB/s file: the link is slower than the release needs.
    await ctx.route(/\/api\/v1\/stream\/tok-tvhint/, async (route) => {
      const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers()["range"] ?? "");
      const start = m ? Number(m[1]) : 0;
      const wantEnd = m && m[2] ? Number(m[2]) : CLIP.length - 1;
      const size = start === 0 ? 48 << 10 : SLOW_CHUNK;
      if (start > 0) await new Promise((r) => setTimeout(r, SLOW_MS));
      const end = Math.min(CLIP.length - 1, wantEnd, start + size - 1);
      return route.fulfill({
        status: 206,
        headers: { "Content-Type": "video/webm", "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${CLIP.length}` },
        body: CLIP.subarray(start, end + 1),
      });
    });
  });
  const { tv, phone, deviceId } = h;
  await tv.evaluate(() => localStorage.setItem("martytv.slow_hint", "1"));
  const hint = tv.getByTestId("player-slow");
  try {
    const play = await sendCommand(phone, deviceId, { type: "media.play", payload: { media_id: h.movieId, source_id: SLOW_ID, position_seconds: 0 } });
    expect(play.ok, JSON.stringify(play)).toBe(true);
    await expect(hint).toBeVisible({ timeout: 90_000 });
    // «Не сейчас» is focused first: OK never leaves the film by surprise.
    await expect(tv.getByTestId("player-slow-dismiss")).toHaveAttribute("data-focused", "true");
    await expect(tv.getByTestId("player-slow-lighter")).toBeVisible();
    // Back closes the hint, not the player.
    await press(tv, "Escape");
    await expect(hint).toHaveCount(0);
    await expect(tv.getByTestId("player")).toHaveCount(1);
    await expect(tv.getByTestId("release-picker")).toHaveCount(0);
    // Not again in this playback (the link is still slow).
    await tv.waitForTimeout(25_000);
    await expect(hint).toHaveCount(0);
    await expect(tv.getByTestId("player")).toHaveCount(1);

    // A new playback: Left → «lighter», Right → «Not now», OK dismisses.
    await sendCommand(phone, deviceId, { type: "media.stop" }).catch(() => undefined);
    await expect(tv.getByTestId("player")).toHaveCount(0, { timeout: 15_000 });
    const again = await sendCommand(phone, deviceId, { type: "media.play", payload: { media_id: h.movieId, source_id: SLOW_ID, position_seconds: 0, force: true } });
    expect(again.ok, JSON.stringify(again)).toBe(true);
    await expect(hint).toBeVisible({ timeout: 90_000 });
    await press(tv, "ArrowLeft");
    await expect(tv.getByTestId("player-slow-lighter")).toHaveAttribute("data-focused", "true");
    await press(tv, "ArrowRight");
    await expect(tv.getByTestId("player-slow-dismiss")).toHaveAttribute("data-focused", "true");
    await press(tv, "Enter");
    await expect(hint).toHaveCount(0);
    await expect(tv.getByTestId("player")).toHaveCount(1);
  } finally {
    await h.close();
  }
});

/** Back (as `send`) until the player is gone: playing with controls shown takes two presses. */
async function backOutOfPlayer(tv: Page, send: () => Promise<unknown>) {
  for (let i = 0; i < 3 && (await tv.getByTestId("player").count()) > 0; i++) {
    await send();
    await tv.waitForTimeout(400);
  }
  await expect(tv.getByTestId("player")).toHaveCount(0);
}

async function backNavigation(browser: Browser, userAgent: string | undefined, init: (() => void) | undefined, how: { key: (tv: Page) => Promise<unknown>; native: boolean }) {
  const h = await pairTv(browser, { userAgent, init }, (ctx, id) => mockCompat(ctx, id, { heads: [], compat: [], native: 0 }));
  const { tv } = h;
  let loads = 0;
  tv.on("load", () => loads++);
  try {
    const boot = await bootId(tv);
    expect(boot).toBeTruthy();
    const play = await sendCommand(h.phone, h.deviceId, { type: "media.play", payload: { media_id: h.movieId, source_id: SRC_ID, position_seconds: 0 } });
    expect(play.ok, JSON.stringify(play)).toBe(true);
    await expect(tv.getByTestId("player")).toBeVisible({ timeout: 20_000 });
    await tv.waitForTimeout(1500);
    // Player → Details.
    await backOutOfPlayer(tv, () => how.key(tv));
    await expect(tv.locator("[data-media-id]")).toHaveAttribute("data-media-id", h.movieId);
    expect(await bootId(tv)).toBe(boot);
    // Details → Home: the host's own Back (history) where it has one — a
    // separate press (within BACK_DEDUPE_MS it would count as the last keydown's echo).
    await tv.waitForTimeout(1200);
    if (how.native) await tv.evaluate(() => history.back());
    else await how.key(tv);
    await expect(tv.getByText("Trending this week")).toBeVisible({ timeout: 10_000 });
    expect(await bootId(tv)).toBe(boot);
    // Home: Back first jumps to the menu (when deep in the page), then asks
    // «Exit Cineko?» — the keydown and the host's history Back of one press
    // count once; cancelling stays.
    const ask = tv.getByTestId("exit-confirm");
    for (let i = 0; i < 4 && !(await ask.isVisible()); i++) {
      await tv.waitForTimeout(1000);
      await how.key(tv);
      if (how.native) await tv.evaluate(() => history.back());
      await tv.waitForTimeout(500);
    }
    await expect(ask).toBeVisible();
    await expect(ask.locator(".is-focused")).toContainText("Stay");
    await tv.waitForTimeout(1000);
    await expect(ask).toBeVisible();
    await press(tv, "Escape");
    await expect(ask).toHaveCount(0);
    await expect(tv.getByText("Trending this week")).toBeVisible();
    expect(await bootId(tv)).toBe(boot);
    expect(loads).toBe(0);
  } finally {
    await h.close();
  }
}

/** The Tizen / MSX Return key as the engine delivers it (keyCode 10009, no `key`). */
const return10009 = (tv: Page) =>
  tv.evaluate(() => {
    const t = document.activeElement ?? document.body;
    t.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 10009, which: 10009, bubbles: true, cancelable: true } as KeyboardEventInit));
  });

test("Back inside MSX on Android (TX3): player → Details → Home → exit confirm, never a reload", async ({ browser }) => {
  test.setTimeout(150_000);
  await backNavigation(browser, TX3_MSX_UA, msxInit, { key: (tv) => press(tv, "Escape"), native: true });
});

test("Back inside MSX on Tizen (Samsung): Return 10009 + the host's history Back, never a reload or exit", async ({ browser }) => {
  test.setTimeout(150_000);
  await backNavigation(browser, TIZEN_MSX_UA, msxInit, { key: return10009, native: true });
});

test("Back in a plain browser: player → Details → Home → exit confirm", async ({ browser }) => {
  test.setTimeout(150_000);
  await backNavigation(browser, undefined, undefined, { key: (tv) => press(tv, "Escape"), native: false });
});
