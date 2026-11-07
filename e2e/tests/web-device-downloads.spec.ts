// «Скачать на устройство» (PWA offline downloads) end to end against mocked
// catalog / playback APIs: the title page and episode buttons, live progress,
// chunked storage in Cache Storage with a resumed Range request after a
// dropped connection, the «Загрузки» list, the space check and the season
// button. Offline playback through the service worker needs a production
// build (the dev server registers none); its range logic has unit tests.
import { mkdirSync, readFileSync } from "node:fs";
import net from "node:net";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
const MOVIE = "d1d1d1d1-0000-4000-8000-000000000001";
const SERIES = "d1d1d1d1-0000-4000-8000-000000000002";
const CHUNK = 8 * 1024 * 1024;
// A "file" of 2.5 chunks: resumes after the first chunk.
const FILE = Buffer.alloc(Math.floor(CHUNK * 2.5), 7);
// H.264 + AC3 (plays muted in Chromium): the offline playback test.
const MKV = readFileSync(new URL("../fixtures/compat-ac3.mkv", import.meta.url));
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function release(id: string, o: Record<string, unknown> = {}) {
  return {
    id,
    title: `Film (2010) WEB-DL 1080p ${id}`,
    indexer: "RuTracker",
    size_bytes: FILE.length,
    seeders: 40,
    leechers: 2,
    published_at: "2026-10-20T10:00:00Z",
    info_hash: "0123456789abcdef0123456789abcdef01234567",
    resolution: "1080p",
    video_codec: "h264",
    hdr: null,
    audio_codecs: ["aac"],
    languages: ["ru"],
    voiceovers: [],
    release_group: null,
    source_quality: "webdl",
    year: 2010,
    seasons: [],
    episodes: [],
    is_season_pack: false,
    confidence: 0.95,
    score: 1,
    reasons: [],
    warnings: [],
    ...o,
  };
}

const base = (id: string, kind: "movie" | "series", title: string) => ({
  id,
  kind,
  tmdb_id: kind === "movie" ? 101 : 102,
  title,
  original_title: title,
  year: 2010,
  release_date: "2010-07-16",
  overview: "Overview.",
  poster_path: null,
  backdrop_path: null,
  rating: 8,
  vote_count: 100,
  genre_ids: [],
  tagline: null,
  runtime: 120,
  status: "Released",
  original_language: "en",
  genres: [],
  countries: ["US"],
  cast: [],
  crew: [],
  external_ids: { tmdb: 1, imdb: null, tvdb: null },
  trailer: null,
});
const seasons = [{ season_number: 1, name: "Season 1", overview: "", air_date: "2020-01-01", episode_count: 3, poster_path: null }];
const episodeId = (n: number) => `e0e0e0e0-0000-4000-8000-00000000000${n}`;

interface Mock {
  streams: { range: string | null }[];
  dropFirst: boolean;
  created: Record<string, unknown>[];
  /** A real video instead of the filler bytes (offline playback). */
  video: { body: Buffer; mime: string; info: Record<string, unknown> } | null;
}

async function mockAll(page: Page): Promise<Mock> {
  const m: Mock = { streams: [], dropFirst: false, created: [], video: null };
  await page.context().route(/\/api\/v1\/(catalog|media)\//, (route) => {
    const u = new URL(route.request().url());
    const path = u.pathname.replace("/api/v1", "");
    if (path === "/catalog/config")
      return json(route, { image_base_url: "https://image.tmdb.org/t/p", poster_sizes: [], backdrop_sizes: [], profile_sizes: [], still_sizes: [], attribution: "", region: "US", available: true });
    if (path === "/catalog/home") return json(route, { rows: [] });
    if (path.endsWith("/releases")) return json(route, { items: [release("rel-1")], searched_at: new Date().toISOString(), cached: false, indexer_errors: [] });
    if (path.endsWith("/progress")) return json(route, { media_id: path.split("/")[2], kind: "movie", movie: null, episodes: [], seasons: [], next_up: null });
    if (/\/seasons\/1$/.test(path))
      return json(route, {
        ...seasons[0],
        media_id: SERIES,
        episodes: [1, 2, 3].map((n) => ({ id: episodeId(n), season_number: 1, episode_number: n, name: `Episode ${n}`, overview: "", air_date: "2020-01-01", runtime: 50, still_path: null, rating: 8 })),
      });
    if (path === `/media/${MOVIE}`) return json(route, base(MOVIE, "movie", "Начало"));
    if (path === `/media/${SERIES}`) return json(route, { ...base(SERIES, "series", "Сериал"), seasons, number_of_seasons: 1, number_of_episodes: 3 });
    if (path.startsWith("/catalog/") || path.endsWith("/similar") || path.endsWith("/recommendations")) return json(route, { items: [], page: 1, total_pages: 1, total_results: 0 });
    return json(route, { error: { code: "not_found", message: "nf" } }, 404);
  });

  let n = 0;
  const sources = new Map<string, { polls: number; media_id: string; episode_id: string | null }>();
  const source = (id: string) => {
    const s = sources.get(id)!;
    const ready = s.polls >= 1;
    const file = m.video?.body ?? FILE;
    return {
      id,
      media_id: s.media_id,
      episode_id: s.episode_id,
      release: release("rel-1"),
      status: ready ? "ready" : "preparing",
      error: null,
      file: ready ? { index: 1, path: "Film/film.mp4", size_bytes: file.length, is_video: true } : null,
      stream_url: ready ? `/api/v1/stream/tok-${id}` : null,
      stream_expires_at: null,
      mime_type: m.video?.mime ?? "video/mp4",
      media_info: !ready
        ? null
        : (m.video?.info ?? { container: "mov,mp4,m4a,3gp,3g2,mj2", video_codec: "h264", width: 1920, height: 1080, duration_seconds: 7200, audio: [{ index: 1, codec: "aac", language: "rus", title: null, channels: 2, default: true }], subtitles: [] }),
      torrent: { peers: 3, seeders: 2, download_speed_bps: 200_000, preloaded_bytes: 0 },
      created_at: new Date().toISOString(),
      kind: "torrent",
      compat_url: null,
      download: null,
    };
  };
  await page.context().route(/\/api\/v1\/playback\/sources(\/[^/?]+)?(\?.*)?$/, async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      const body = req.postDataJSON() as { media_id: string; episode_id?: string };
      m.created.push(body);
      const id = `5e1ec7ed-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      sources.set(id, { polls: 0, media_id: body.media_id, episode_id: body.episode_id ?? null });
      return json(route, source(id), 201);
    }
    const id = new URL(req.url()).pathname.split("/").pop()!;
    if (!sources.has(id)) return json(route, { error: { code: "not_found", message: "nf" } }, 404);
    sources.get(id)!.polls++;
    return json(route, source(id));
  });
  await page.context().route(/\/api\/v1\/stream\//, async (route) => {
    const range = route.request().headers()["range"] ?? null;
    m.streams.push({ range });
    const body = m.video?.body ?? FILE;
    const type = m.video?.mime ?? "video/mp4";
    const r = /bytes=(\d+)-/.exec(range ?? "");
    if (!r) {
      if (m.dropFirst && m.streams.length === 1) {
        // The connection drops after a chunk and a bit: the body is shorter than announced.
        return route.fulfill({ status: 200, headers: { "Content-Type": type, "Content-Length": String(body.length) }, body: body.subarray(0, CHUNK + 4096) });
      }
      return route.fulfill({ status: 200, headers: { "Content-Type": type, "Accept-Ranges": "bytes" }, body });
    }
    const start = Number(r[1]);
    return route.fulfill({
      status: 206,
      headers: { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${body.length - 1}/${body.length}` },
      body: body.subarray(start),
    });
  });
  return m;
}

async function login(page: Page) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel(/username|имя пользователя|логин/i).fill(USER);
  await page.getByLabel(/password|пароль/i).fill(PASS);
  await page.getByRole("button", { name: /sign in|войти/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  const req = page.context().request;
  const session = await (await req.get("/api/v1/auth/session")).json();
  const headers = { "X-CSRF-Token": session.csrf_token as string, Origin: new URL(page.url()).origin };
  let profiles = (await (await req.get("/api/v1/profiles")).json()).items as { id: string }[];
  if (!profiles.length) {
    expect((await req.post("/api/v1/profiles", { data: { name: "E2E", color: "#6366f1" }, headers })).ok()).toBeTruthy();
    profiles = (await (await req.get("/api/v1/profiles")).json()).items;
  }
  await req.put(`/api/v1/profiles/${profiles[0]!.id}/settings`, { data: { onboarding_completed: true, ...(process.env.DESIGN && { design: process.env.DESIGN }) }, headers });
  await page.evaluate(
    ([u, p]) => {
      localStorage.setItem(`martytv.active_profile.${u}`, p);
      localStorage.setItem("martytv.locale", "ru");
    },
    [session.user.id as string, profiles[0]!.id],
  );
}

/** Bytes stored for an item (chunks) and its manifest, read from Cache Storage. */
async function stored(page: Page, id: string) {
  return page.evaluate(async (id) => {
    const c = await caches.open("martytv-offline-video-v1");
    const base = `/offline-video/${encodeURIComponent(id)}`;
    const keys = (await c.keys()).map((k) => new URL(k.url).pathname).filter((p) => p.startsWith(base));
    let bytes = 0;
    for (const k of keys.filter((p) => p.includes("/c/"))) bytes += (await (await c.match(k))?.arrayBuffer())?.byteLength ?? 0;
    const m = await c.match(`${base}/m`);
    return { chunks: keys.filter((p) => p.includes("/c/")).length, bytes, manifest: m ? await m.json() : null };
  }, id);
}

/** Screenshots for the visual check (SHOTS_DIR set; DESIGN picks the design). */
async function shot(page: Page, name: string) {
  const dir = process.env.SHOTS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/${process.env.DESIGN ?? "default"}-${name}.png` });
}

async function fakeQuota(ctx: BrowserContext, quota: number) {
  await ctx.addInitScript((q) => {
    Object.defineProperty(navigator.storage, "estimate", { value: async () => ({ quota: q, usage: 0 }) });
    Object.defineProperty(navigator.storage, "persist", { value: async () => true });
  }, quota);
}

// Cache Storage and service workers need a secure context, and the dev stack
// is plain HTTP (web-device-downloads-http.spec.ts checks the explanation
// there): reach it through localhost (secure) with a TCP relay in this process.
const UPSTREAM = new URL(process.env.E2E_BASE_URL ?? "http://localhost:8080");
const LOCAL = UPSTREAM.hostname === "localhost" || UPSTREAM.hostname === "127.0.0.1";
const RELAY_PORT = 8080; // the API's allowed origins include http://localhost:8080
let relay: net.Server | null = null;
test.beforeAll(async () => {
  if (LOCAL) return;
  relay = net.createServer((c) => {
    const up = net.connect(Number(UPSTREAM.port || 80), UPSTREAM.hostname);
    c.pipe(up).pipe(c);
    c.on("error", () => up.destroy());
    up.on("error", () => c.destroy());
  });
  await new Promise<void>((resolve, reject) => relay!.once("error", reject).listen(RELAY_PORT, "127.0.0.1", resolve));
});
test.afterAll(() => {
  relay?.close();
});
test.use({ baseURL: LOCAL ? UPSTREAM.origin : `http://localhost:${RELAY_PORT}` });

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, locale: "ru-RU", isMobile: true, hasTouch: true });

  test("movie: the title page button saves it in chunks, resuming after a dropped connection", async ({ page, context }) => {
    test.setTimeout(90_000);
    await fakeQuota(context, 10 * 1024 ** 3);
    await login(page);
    const m = await mockAll(page);
    m.dropFirst = true;
    await page.goto(`/title/${MOVIE}`);
    await page.getByTestId("play-more").click(); // «Скачать на устройство» is in the play menu (stays open)
    const box = page.getByTestId("save-device");
    await expect(box.getByTestId("save-device-button")).toHaveText("Скачать на устройство");
    await box.getByTestId("save-device-button").click();

    // Best release → source → ready → original file (H.264/AAC MP4 plays here).
    await expect(box).toHaveAttribute("data-status", /queued|preparing|downloading|failed/);
    // The first stream breaks after one chunk: an automatic retry resumes with Range.
    await expect(box).toHaveAttribute("data-status", "saved", { timeout: 40_000 });
    await expect(box.getByTestId("save-device-button")).toHaveText("На устройстве");
    await shot(page, "movie-saved");
    expect(m.streams[0]!.range).toBeNull();
    expect(m.streams.at(-1)!.range).toBe(`bytes=${CHUNK}-`);
    const s = await stored(page, `${MOVIE}:movie`);
    expect(s.manifest).toMatchObject({ v: 2, size: FILE.length, chunk: CHUNK, count: 3, type: "video/mp4" });
    expect(s).toMatchObject({ chunks: 3, bytes: FILE.length });

    // «Загрузки»: on this device, with play and delete.
    await page.goto("/downloads");
    const row = page.getByTestId("device-row");
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-status", "saved");
    await expect(row).toContainText("Начало");
    await expect(row.getByTestId("device-play")).toHaveAttribute("href", `/offline/${encodeURIComponent(`${MOVIE}:movie`)}`);
    await row.getByTestId("device-delete").click();
    await expect(page.getByTestId("device-empty")).toBeVisible();
    await expect.poll(async () => (await stored(page, `${MOVIE}:movie`)).chunks).toBe(0);
  });

  test("not enough space: explained before downloading, with a retry", async ({ page, context }) => {
    await fakeQuota(context, 30 * 1024 * 1024);
    await login(page);
    const m = await mockAll(page);
    await page.goto(`/title/${MOVIE}`);
    await page.getByTestId("play-more").click(); // «Скачать на устройство» is in the play menu (stays open)
    const box = page.getByTestId("save-device");
    await box.getByTestId("save-device-button").click();
    await expect(box).toHaveAttribute("data-status", "failed", { timeout: 20_000 });
    await expect(box.getByTestId("save-device-button")).toHaveText("Не скачалось");
    await expect(box.getByTestId("save-device-note")).toContainText("Недостаточно места на устройстве: нужно");
    expect(m.streams).toHaveLength(0);
    await page.goto("/downloads");
    await expect(page.getByTestId("device-row")).toHaveAttribute("data-status", "failed");
    await expect(page.getByTestId("device-retry")).toHaveText("Повторить");
    await shot(page, "downloads-quota");
    await page.getByTestId("device-delete").click();
  });

  test("series: episode and season buttons queue the episodes one by one", async ({ page, context }) => {
    test.setTimeout(90_000);
    await fakeQuota(context, 10 * 1024 ** 3);
    await login(page);
    const m = await mockAll(page);
    await page.goto(`/title/${SERIES}`);
    const eps = page.getByTestId("episode-save-device");
    await expect(eps).toHaveCount(3);
    await eps.nth(0).click();
    await expect(eps.nth(0)).toHaveAttribute("data-status", "saved", { timeout: 30_000 });
    const season = page.getByTestId("season-save-device");
    await expect(season).toContainText("1/3");
    await season.click();
    await page.waitForTimeout(1500);
    await shot(page, "season-running");
    await expect(eps.nth(1)).toHaveAttribute("data-status", /queued|preparing|downloading|saved/);
    await expect(season).toContainText("Сезон на устройстве: 3 из 3", { timeout: 60_000 });
    await shot(page, "season-saved");
    expect(m.created.map((c) => c.episode_id)).toEqual([episodeId(1), episodeId(2), episodeId(3)]);
    await page.goto("/downloads");
    await expect(page.getByTestId("device-row")).toHaveCount(3);
    for (let i = 0; i < 3; i++) await page.getByTestId("device-delete").first().click();
    await expect(page.getByTestId("device-empty")).toBeVisible();
  });

  test("offline: a saved film plays with no network (production build: service worker)", async ({ page, context }) => {
    test.setTimeout(90_000);
    await fakeQuota(context, 10 * 1024 ** 3);
    await login(page);
    const sw = await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()));
    test.skip(!sw, "no service worker (dev server): run against a production build");
    const m = await mockAll(page);
    m.video = {
      body: MKV,
      mime: "video/x-matroska",
      info: { container: "matroska,webm", video_codec: "h264", width: 320, height: 180, duration_seconds: 90, audio: [{ index: 1, codec: "ac3", language: "rus", title: null, channels: 2, default: true }], subtitles: [] },
    };
    await page.goto(`/title/${MOVIE}`);
    await page.getByTestId("play-more").click();
    await page.getByTestId("save-device-button").click();
    await expect(page.getByTestId("save-device")).toHaveAttribute("data-status", "saved", { timeout: 30_000 });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload(); // the service worker controls the page from here

    await context.setOffline(true);
    await page.goto("/downloads"); // app shell from the precache; the server is unreachable
    await expect(page.getByTestId("offline-screen")).toBeVisible({ timeout: 15_000 });
    const row = page.getByTestId("device-row");
    await expect(row).toHaveAttribute("data-status", "saved");
    await row.getByTestId("device-play").click();
    const video = page.getByTestId("offline-player").locator("video");
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.duration), { timeout: 15_000 }).toBeGreaterThan(80);
    await video.evaluate(async (v: HTMLVideoElement) => {
      v.muted = true;
      v.currentTime = 60;
      await v.play();
    });
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 }).toBeGreaterThan(60.5);
    expect(await video.evaluate((v: HTMLVideoElement) => v.error?.code ?? null)).toBeNull();
    await context.setOffline(false);
  });
});
