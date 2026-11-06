// Browser compatibility stream (compat mode) end to end, with the dev stack's
// real transcoder container and real ffmpeg:
//
//   Chromium ──/api/v1/stream/tok-ac3/compat.mp4──▶ (Playwright route, stands in
//   for the API's proxy) ──signed job──▶ transcoder:8090 ──HTTP Range──▶ a fake
//   TorrServer in this test process serving fixtures/compat-ac3.mkv
//
// The fixture is H.264 + two AC3 tracks + SRT. Chromium can't decode AC3, so
// decoded audio bytes prove the conversion. iPads get the HLS variant
// (compat.m3u8 → the transcoder's fMP4 HLS session), relayed the same way. The API side of compat.mp4 (token,
// validation, job signing) is covered by the Go tests; sources, sessions and
// progress are mocked as in web-watch-here.spec.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import { expect, test, type Page, type Route } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
const TC_URL = process.env.TRANSCODER_URL ?? "http://transcoder:8090";
const TC_SECRET = process.env.TRANSCODER_SECRET ?? "dev-only-transcoder-secret-0123456789abcdef";
const MKV = readFileSync(new URL("../fixtures/compat-ac3.mkv", import.meta.url));

const SRC_ID = "c0a7c0a7-0000-4000-8000-00000000c001";
const SESSION = "c0a7c0a7-0000-4000-8000-00000000cafe";
const TOKEN = "tok-ac3";

// ---------------------------------------------------------------- fake TorrServer

let tsInput = "";
let tsServer: http.Server | null = null;

/** Serves the fixture with Range support on this container's network address. */
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

// ---------------------------------------------------------------- transcoder

const jobKey = createHmac("sha256", TC_SECRET).update("martytv/transcoder/job/v1").digest();

/** A signed job, like the API sends (services/api/internal/playback/compat.go). */
function job(kind: "remux" | "keyframe" | "subtitles" | "hls", fields: Record<string, number | boolean | string | undefined>) {
  const body = JSON.stringify({ v: 1, kind, input: tsInput, exp: Math.floor(Date.now() / 1000) + 60, ...fields });
  return fetch(`${TC_URL}/v1/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Job-Signature": createHmac("sha256", jobKey).update(body).digest("hex") },
    body,
  });
}

/** A session file, signed like the API does (services/api/internal/playback/compat_hls.go). */
function hlsFile(method: string, session: string, file: string, range?: string) {
  const exp = Math.floor(Date.now() / 1000) + 60;
  const sig = createHmac("sha256", jobKey).update(`hls-file\n${session}\n${file}\n${SRC_ID}\n${exp}`).digest("hex");
  return fetch(`${TC_URL}/v1/hls/${session}/${file}?owner=${SRC_ID}&exp=${exp}`, {
    method,
    headers: { "X-Job-Signature": sig, ...(range ? { Range: range } : {}) },
  });
}

/** The API's media playlist rewrite: start at the beginning, steady target duration. */
function rewritePlaylist(pl: string): string {
  return pl
    .replace(/#EXT-X-TARGETDURATION:(\d+)/, (_m, n: string) => `#EXT-X-TARGETDURATION:${Math.max(Number(n), 10)}`)
    .replace('#EXT-X-MAP:URI="init.mp4"', '#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n#EXT-X-MAP:URI="init.mp4"');
}

// ---------------------------------------------------------------- mocks

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
  subtitles: [{ index: 3, codec: "subrip", language: "rus", title: null, default: false }],
};

const RELEASE = {
  id: "rel-ac3",
  title: "Movie (2010) WEB-DL 1080p [AC3].mkv",
  indexer: "RuTracker",
  size_bytes: 2_000_000_000,
  seeders: 40,
  leechers: 2,
  published_at: "2026-10-20T10:00:00Z",
  info_hash: null,
  resolution: "1080p",
  video_codec: "h264",
  hdr: null,
  audio_codecs: ["ac3"],
  languages: ["ru"],
  voiceovers: [],
  release_group: null,
  source_quality: "web-dl",
  year: 2010,
  seasons: [],
  episodes: [],
  is_season_pack: false,
  confidence: 0.95,
  score: 1,
  reasons: ["title_exact"],
  warnings: [],
};

interface Log {
  heads: { start: number; k: number }[];
  /** compat.m3u8 requests (HLS sessions) and the session files fetched. */
  hls: { audio: number | null; start: number; k: string | null; session: string }[];
  hlsFiles: string[];
  compat: { audio: number | null; start: number; k: string | null }[];
  subs: { stream: number; start: number }[];
  native: number;
  reports: { seq: number; position_seconds: number; state: string }[];
}

async function mockPlayback(page: Page, mediaId: string, voiceovers: string[]): Promise<Log> {
  const log: Log = { heads: [], hls: [], hlsFiles: [], compat: [], subs: [], native: 0, reports: [] };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const source = {
    id: SRC_ID,
    media_id: mediaId,
    episode_id: null,
    release: RELEASE,
    status: "ready",
    error: null,
    file: { index: 1, path: "Movie/movie.mkv", size_bytes: MKV.length, is_video: true, season: null, episode: null },
    stream_url: `/api/v1/stream/${TOKEN}`,
    stream_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    compat_url: `/api/v1/stream/${TOKEN}/compat.mp4`,
    mime_type: "video/x-matroska",
    media_info: MEDIA_INFO,
    torrent: { peers: 10, seeders: 9, download_speed_bps: 3_200_000, preloaded_bytes: 50_000_000 },
    created_at: new Date().toISOString(),
    kind: "torrent",
  };
  await page.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) => json(route, { items: [RELEASE], searched_at: new Date().toISOString(), cached: false, indexer_errors: [] }));
  await page.route(/\/api\/v1\/playback\/sources(\/[^/?]+)?(\?.*)?$/, (route) => json(route, source, route.request().method() === "POST" ? 201 : 200));
  await page.route(/\/api\/v1\/profiles\/[^/]+\/preferences/, (route) =>
    json(route, {
      ui_language: "en",
      preferred_audio_languages: ["ru"],
      preferred_subtitle_languages: [],
      preferred_resolution: "1080p",
      max_size_gb: null,
      preferred_codecs: [],
      preferred_voiceovers: voiceovers,
    }),
  );

  // Native stream: the MKV itself (Chromium plays the video, not the AC3).
  await page.route(new RegExp(`/api/v1/stream/${TOKEN}$`), (route) => {
    log.native++;
    const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers()["range"] ?? "");
    if (!m) return route.fulfill({ status: 200, headers: { "Content-Type": "video/x-matroska", "Accept-Ranges": "bytes" }, body: MKV });
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), MKV.length - 1) : MKV.length - 1;
    return route.fulfill({
      status: 206,
      headers: { "Content-Type": "video/x-matroska", "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${MKV.length}` },
      body: MKV.subarray(start, end + 1),
    });
  });

  // Compat stream → the real transcoder.
  await page.route(new RegExp(`/api/v1/stream/${TOKEN}/compat\\.mp4`), async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const audio = u.searchParams.has("audio") ? Number(u.searchParams.get("audio")) : null;
    const start = Number(u.searchParams.get("start") ?? 0);
    // The API resolves the default track from media_info.
    const fields = { audio: audio ?? 1, start: start || undefined };
    if (req.method() === "HEAD") {
      let k = 0;
      if (start > 0) k = ((await (await job("keyframe", fields)).json()) as { start: number }).start;
      log.heads.push({ start, k });
      return route.fulfill({ status: 200, headers: { "Content-Type": "video/mp4", "Accept-Ranges": "none", "X-Stream-Start": k.toFixed(3) }, body: "" });
    }
    const r = await job("remux", fields);
    const body = Buffer.from(await r.arrayBuffer());
    log.compat.push({ audio, start, k: r.headers.get("x-stream-start") });
    return route.fulfill({
      status: r.status,
      headers: { "Content-Type": r.headers.get("content-type") ?? "video/mp4", "Accept-Ranges": "none", "X-Stream-Start": r.headers.get("x-stream-start") ?? "0" },
      body,
    });
  });
  // HLS compat (Safari / iOS) → the real transcoder's HLS session.
  await page.route(new RegExp(`/api/v1/stream/${TOKEN}/compat\\.m3u8`), async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const audio = u.searchParams.has("audio") ? Number(u.searchParams.get("audio")) : null;
    const start = Number(u.searchParams.get("start") ?? 0);
    const fields = { audio: audio ?? 1, start: start || undefined };
    if (req.method() === "HEAD") {
      let k = 0;
      if (start > 0) k = ((await (await job("keyframe", fields)).json()) as { start: number }).start;
      log.heads.push({ start, k });
      return route.fulfill({ status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl", "X-Stream-Start": k.toFixed(3) }, body: "" });
    }
    const r = await job("hls", { ...fields, owner: SRC_ID });
    if (r.status !== 200) return route.fulfill({ status: r.status, contentType: "application/json", body: await r.text() });
    const out = (await r.json()) as { session: string; start: number };
    log.hls.push({ audio, start, k: r.headers.get("x-stream-start"), session: out.session });
    return route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/vnd.apple.mpegurl", "X-Stream-Start": r.headers.get("x-stream-start") ?? "0", "Cache-Control": "no-store" },
      body: `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=320x180\ncompat/${out.session}/index.m3u8\n`,
    });
  });
  await page.route(new RegExp(`/api/v1/stream/${TOKEN}/compat/([0-9a-f]{32})/([^/?]+)`), async (route) => {
    const req = route.request();
    const [, session, file] = new RegExp(`/compat/([0-9a-f]{32})/([^/?]+)`).exec(new URL(req.url()).pathname)!;
    log.hlsFiles.push(file!);
    const r = await hlsFile(req.method(), session!, file!, req.headers()["range"]);
    const headers: Record<string, string> = { "Cache-Control": "no-store" };
    for (const k of ["content-type", "content-range", "accept-ranges", "content-length"]) {
      const v = r.headers.get(k);
      if (v) headers[k] = v;
    }
    if (file === "index.m3u8" && r.ok) {
      const body = rewritePlaylist(await r.text());
      delete headers["content-length"];
      return route.fulfill({ status: 200, headers, body });
    }
    return route.fulfill({ status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) });
  });
  await page.route(new RegExp(`/api/v1/stream/${TOKEN}/subs/(\\d+)\\.vtt`), async (route) => {
    const u = new URL(route.request().url());
    const stream = Number(/subs\/(\d+)\.vtt/.exec(u.pathname)![1]);
    const start = Number(u.searchParams.get("start") ?? 0);
    log.subs.push({ stream, start });
    const r = await job("subtitles", { stream, start: start || undefined, burst: Number(u.searchParams.get("burst") ?? 0) || undefined });
    return route.fulfill({ status: r.status, headers: { "Content-Type": "text/vtt; charset=utf-8" }, body: Buffer.from(await r.arrayBuffer()) });
  });

  // Sessions and progress are mocked: nothing is recorded on the real profile.
  await page.route(/\/api\/v1\/playback\/sessions(\?.*)?$/, (route) =>
    json(route, { id: SESSION, resume_position_seconds: null, progress: null, report_token: "beacon-token" }, 201),
  );
  await page.route(/\/api\/v1\/playback\/sessions\/[^/]+\/progress/, (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { seq: number; position_seconds: number; state: string };
    log.reports.push({ seq: body.seq, position_seconds: body.position_seconds, state: body.state });
    return json(route, { accepted: true, progress: null });
  });
  await page.route(new RegExp(`/api/v1/media/${mediaId}/progress`), (route) =>
    json(route, { media_id: mediaId, kind: "movie", movie: null, episodes: [], seasons: [], next_up: null }),
  );
  await page.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, (route) => json(route, { items: [] }));
  return log;
}

async function setup(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(USER);
  await page.getByLabel(/password/i).fill(PASS);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
  const req = page.context().request;
  const session = await (await req.get("/api/v1/auth/session")).json();
  const headers = { "X-CSRF-Token": session.csrf_token as string, Origin: new URL(page.url()).origin };
  let profiles = (await (await req.get("/api/v1/profiles")).json()).items;
  if (!profiles.length) {
    expect((await req.post("/api/v1/profiles", { data: { name: "E2E", color: "#6366f1" }, headers })).ok()).toBeTruthy();
    profiles = (await (await req.get("/api/v1/profiles")).json()).items;
  }
  await page.evaluate(([u, p]) => localStorage.setItem(`martytv.active_profile.${u}`, p), [session.user.id, profiles[0].id as string]);
  const search = await (await req.get("/api/v1/catalog/search?q=Inception&kind=movie")).json();
  const movie = search.items[0] as { id: string; title: string };
  expect(movie).toBeTruthy();
  return { movie };
}

const video = (page: Page) => page.getByTestId("video");
const player = (page: Page) => page.getByTestId("player");
const elementTime = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.currentTime);
/** Chromium's count of decoded audio bytes (0 = silent: AC3 isn't decodable here). */
const audioBytes = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => (v as HTMLVideoElement & { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount ?? -1);
const shownTime = async (page: Page) => {
  const txt = (await page.getByTestId("player-time").textContent()) ?? "";
  const [m, s] = txt.split("/")[0]!.trim().split(":").map(Number);
  return m! * 60 + s!;
};

test.use({ viewport: { width: 1280, height: 720 }, locale: "en-US" });

test("AC3 source plays in compat mode: converted audio, seek restart, audio switch, corrected progress", async ({ page }) => {
  test.setTimeout(120_000);
  const { movie } = await setup(page);
  await page.evaluate(() => localStorage.removeItem("martytv.compat"));
  const log = await mockPlayback(page, movie.id, ["LostFilm"]);

  // Start at 1:00 (t=60): the support check says "no sound" (AC3) and the
  // server has a compat stream → compat mode from the start.
  await page.goto(`/watch/new?media=${movie.id}&release=rel-ac3&t=60`);
  await expect(player(page)).toHaveAttribute("data-compat", "on", { timeout: 20_000 });
  await expect(page.getByTestId("player-loader")).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => elementTime(page), { timeout: 20_000 }).toBeGreaterThan(1);

  // The stream was asked for at 60 s with the preferred voice-over (MVO
  // LostFilm = stream 2); it starts at the keyframe there (every 2 s).
  expect(log.heads[0]).toEqual({ start: 60, k: 60 });
  expect(log.compat[0]).toMatchObject({ audio: 2, start: 60, k: "60.000" });
  await expect(player(page)).toHaveAttribute("data-offset", "60");
  expect(log.native).toBe(0);
  // Chromium decodes the converted AAC (it can't decode AC3).
  await expect.poll(() => audioBytes(page), { timeout: 15_000 }).toBeGreaterThan(0);
  // Time shown = stream start + element time.
  await expect.poll(() => shownTime(page)).toBeGreaterThanOrEqual(61);

  // Progress reports carry the corrected (file) position, not the element's.
  await page.mouse.move(640, 360);
  await page.getByTestId("player-toggle").click();
  await expect.poll(() => log.reports.find((r) => r.state === "paused")?.position_seconds ?? 0).toBeGreaterThanOrEqual(60);
  const el = await elementTime(page);
  const paused = log.reports.find((r) => r.state === "paused")!;
  expect(paused.position_seconds).toBeCloseTo(60 + el, 0);
  await page.getByTestId("player-toggle").click();

  // Seek back 10 s from the seek bar: before the stream's start, so outside
  // the buffer → a new stream at the keyframe ≤ the target.
  const before = await shownTime(page);
  const n = log.compat.length;
  await page.getByTestId("player-seek").focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => log.compat.length, { timeout: 20_000 }).toBeGreaterThan(n);
  const restart = log.compat[n]!;
  expect(restart.audio).toBe(2);
  expect(restart.start).toBeGreaterThanOrEqual(before - 12);
  expect(restart.start).toBeLessThanOrEqual(before - 8);
  expect(Number(restart.k)).toBeLessThanOrEqual(restart.start);
  expect(restart.start - Number(restart.k)).toBeLessThan(2.01);
  await expect(player(page)).toHaveAttribute("data-offset", String(Number(restart.k)));
  await expect.poll(() => shownTime(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(Number(restart.k));
  expect(await shownTime(page)).toBeLessThan(before);

  // Seek forward 10 s: Chromium only demuxes a few seconds ahead of a
  // non-seekable stream, so this is past the buffer too → restart there.
  await expect.poll(() => shownTime(page)).toBeGreaterThan(Number(restart.k));
  const fwdFrom = await shownTime(page);
  const m = log.compat.length;
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => log.compat.length, { timeout: 20_000 }).toBeGreaterThan(m);
  const fwd = log.compat[m]!;
  expect(fwd.start).toBeGreaterThanOrEqual(fwdFrom + 8);
  expect(fwd.start).toBeLessThanOrEqual(fwdFrom + 12);
  await expect(player(page)).toHaveAttribute("data-offset", String(Number(fwd.k)));
  await expect.poll(() => shownTime(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(Number(fwd.k));

  // Audio menu: the file's tracks; switching restarts here with audio=1.
  await page.mouse.move(640, 300);
  await page.getByTestId("player-audio").click();
  const menu = page.getByTestId("player-menu-audio");
  await expect(menu.getByRole("menuitemradio")).toHaveText([/Дубляж/, /MVO LostFilm/, /Compatible mode/]);
  await expect(menu.getByRole("menuitemradio", { name: /MVO LostFilm/ })).toHaveAttribute("aria-checked", "true");
  const at = await shownTime(page);
  await menu.getByRole("menuitemradio", { name: /Дубляж/ }).click();
  await expect.poll(() => log.compat.at(-1)?.audio, { timeout: 20_000 }).toBe(1);
  expect(log.compat.at(-1)!.start).toBeGreaterThanOrEqual(at - 1);
  await expect.poll(() => audioBytes(page), { timeout: 15_000 }).toBeGreaterThan(0);

  // Subtitles: the text track as WebVTT, timed like the current stream.
  await page.mouse.move(640, 300);
  await page.getByTestId("player-subs").click();
  await page.getByTestId("player-menu-subs").getByRole("menuitemradio", { name: /Русский|Russian/ }).click();
  await expect.poll(() => log.subs.length, { timeout: 15_000 }).toBeGreaterThan(0);
  const offset = Number(await player(page).getAttribute("data-offset"));
  expect(log.subs[0]).toMatchObject({ stream: 3, start: offset });
  const cue = await page.waitForFunction(
    () => {
      const v = document.querySelector("video")!;
      const tr = Array.from(v.textTracks).find((t) => t.id === "compat-sub");
      const c = tr?.cues?.[0] as VTTCue | undefined;
      return c ? { start: c.startTime, text: c.text, mode: tr!.mode } : null;
    },
    null,
    { timeout: 20_000 },
  );
  const c = (await cue.jsonValue())!;
  // The fixture's 80 s cue (the first after the stream's start), relative to it.
  expect(c.text).toContain("восьмидесятой");
  expect(c.start).toBeCloseTo(80 - offset, 1);
  expect(c.mode).toBe("showing");

  // Turning compat mode off is remembered for this browser.
  await page.mouse.move(640, 300);
  await page.getByTestId("player-audio").click();
  await page.getByTestId("player-menu-audio").getByRole("menuitemradio", { name: /Compatible mode/ }).click();
  await expect(player(page)).toHaveAttribute("data-compat", "off");
  await expect.poll(() => log.native).toBeGreaterThan(0);
  expect(await page.evaluate(() => localStorage.getItem("martytv.compat"))).toBe("off");
  await page.evaluate(() => localStorage.removeItem("martytv.compat"));
});

test("compat switched off: no sound → fallback «Convert audio and watch here»", async ({ page }) => {
  test.setTimeout(90_000);
  const { movie } = await setup(page);
  await page.evaluate(() => localStorage.setItem("martytv.compat", "off"));
  const log = await mockPlayback(page, movie.id, []);

  await page.goto(`/watch/new?media=${movie.id}&release=rel-ac3&t=0`);
  await expect(page.getByTestId("player-loader")).toHaveCount(0, { timeout: 30_000 });
  await expect(player(page)).toHaveAttribute("data-compat", "off");
  // The MKV plays without sound in Chromium → the no-sound banner.
  await expect(page.getByTestId("silent-banner")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("silent-banner").getByRole("button", { name: "Fix" }).click();
  const fallback = page.getByTestId("player-fallback");
  await expect(fallback).toHaveAttribute("data-mode", "silent");
  await expect(fallback.getByTestId("fallback-compat")).toContainText("Convert audio and watch here");
  await fallback.getByTestId("fallback-compat").click();

  await expect(fallback).toHaveCount(0);
  await expect(player(page)).toHaveAttribute("data-compat", "on", { timeout: 20_000 });
  // Restarted where it was, default track (no voice-over preference).
  await expect.poll(() => log.compat.length, { timeout: 20_000 }).toBeGreaterThan(0);
  expect(log.compat[0]!.audio).toBe(1);
  await expect.poll(() => audioBytes(page), { timeout: 20_000 }).toBeGreaterThan(0);
  await page.evaluate(() => localStorage.removeItem("martytv.compat"));
});

const MSX_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

/** Does this engine play HLS in a plain <video src> (Safari / iOS: AVFoundation)? */
const nativeHls = (page: Page) => page.evaluate(() => document.createElement("video").canPlayType("application/vnd.apple.mpegurl") !== "");

test.describe("iPad in Media Station X", () => {
  // The MSX web view's UA (seen on prod): a Mac without "Safari", on a touch screen.
  test.use({ userAgent: MSX_UA, hasTouch: true });

  test("an MKV goes straight to the HLS compat stream (never the raw MKV, never compat.mp4)", async ({ page, browserName }) => {
    // Chromium (native HLS in Playwright's build) plays it end to end; Linux
    // WebKit has no native HLS (no AVFoundation), so it checks the request
    // flow. Firefox is never an iPad.
    test.skip(browserName === "firefox", "not an iPad engine");
    test.setTimeout(120_000);
    // iPadOS opens no Matroska; Linux WebKit does (GStreamer): answer like an iPad.
    await page.addInitScript(() => {
      const orig = HTMLMediaElement.prototype.canPlayType;
      HTMLMediaElement.prototype.canPlayType = function (this: HTMLMediaElement, t: string) {
        return /matroska|mkv/i.test(t) ? "" : orig.call(this, t);
      } as typeof orig;
    });
    const { movie } = await setup(page);
    await page.evaluate(() => localStorage.removeItem("martytv.compat"));
    const log = await mockPlayback(page, movie.id, ["LostFilm"]);
    const scripts: string[] = [];
    page.on("request", (r) => {
      if (r.resourceType() === "script") scripts.push(r.url());
    });
    const hls = await nativeHls(page);

    await page.goto(`/watch/new?media=${movie.id}&release=rel-ac3&t=30`);
    await expect(player(page)).toHaveAttribute("data-compat", "on", { timeout: 20_000 });
    await expect(player(page)).toHaveAttribute("data-compat-format", "hls");
    // The element plays the playlist itself (iOS has no MSE for hls.js; it isn't loaded).
    await expect(video(page)).toHaveAttribute("data-engine", "native");
    await expect(video(page)).toHaveAttribute("src", /\/api\/v1\/stream\/tok-ac3\/compat\.m3u8\?audio=2&start=30$/);
    // The session was started for the preferred voice-over at the keyframe at 30 s.
    await expect.poll(() => log.hls.length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(log.hls[0]).toMatchObject({ audio: 2, start: 30, k: "30.000" });
    await expect(player(page)).toHaveAttribute("data-offset", "30");
    expect(log.compat).toHaveLength(0);
    expect(log.native).toBe(0);
    expect(scripts.some((u) => /hls(\.light)?[-.][\w-]*\.js|hls\.js/i.test(u))).toBe(false);

    if (!hls) {
      // No native HLS in this engine (Linux Chromium): the request flow is all
      // there is to see; the transcoder tests ffprobe the HLS output itself.
      test.info().annotations.push({ type: "note", description: `${browserName}: no native HLS, playback not checked` });
      return;
    }
    // Native HLS (WebKit): the media playlist, init segment and segments, and playback.
    await expect.poll(() => log.hlsFiles.includes("index.m3u8") && log.hlsFiles.includes("init.mp4"), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => log.hlsFiles.some((f) => /^seg\d+\.m4s$/.test(f)), { timeout: 30_000 }).toBe(true);
    await expect(page.getByTestId("player-loader")).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => elementTime(page), { timeout: 30_000 }).toBeGreaterThan(1);
    // Shown time = stream start + element time; progress reports the file position.
    await expect.poll(() => shownTime(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(31);
    await page.mouse.move(640, 360);
    await page.getByTestId("player-toggle").click();
    await expect.poll(() => log.reports.find((r) => r.state === "paused")?.position_seconds ?? 0, { timeout: 15_000 }).toBeGreaterThanOrEqual(30);
    const paused = log.reports.find((r) => r.state === "paused")!;
    expect(paused.position_seconds).toBeCloseTo(30 + (await elementTime(page)), 0);

    // Seek within the generated segments: Safari's own seek, same session.
    const sessions = log.hls.length;
    await page.getByTestId("player-seek").focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => shownTime(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(40);
    expect(log.hls.length).toBe(sessions);
    // Seek before the stream's start: a new session at the keyframe there.
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("ArrowLeft");
      await page.waitForTimeout(400);
    }
    await expect.poll(() => log.hls.some((x) => Number(x.k) < 30), { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => Number(await player(page).getAttribute("data-offset")), { timeout: 15_000 }).toBeLessThan(30);
    await expect.poll(() => shownTime(page), { timeout: 15_000 }).toBeLessThan(30);
    expect(log.compat).toHaveLength(0);
  });
});
