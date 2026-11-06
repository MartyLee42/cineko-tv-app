// Rebuffering to a threshold: on a connection slower than the file, the
// browser player pauses itself after a stall and waits for a deep buffer
// («Буферизация… N%») instead of flapping "play 2 s → loading → play".
// The stream route delivers the clip in small, delayed chunks (slower than
// its bitrate) for a while, then at full speed.
import { readFileSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
/** 40 s VP8/Opus WebM, ~60 kbit/s. */
const CLIP = readFileSync(new URL("../fixtures/clip.webm", import.meta.url));
const SRC_ID = "5e1ec7ed-0000-4000-8000-00000000b001";
const FIRST_CHUNK = 64 << 10; // ≈ 8 s of the clip
const SLOW_CHUNK = 2 << 10; // every 400 ms ≈ 40 kbit/s < the clip's bitrate
const SLOW_MS = 400;
const SLOW_FOR_MS = 14_000;

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
  return search.items[0] as { id: string; title: string };
}

test.use({ viewport: { width: 1280, height: 720 }, locale: "en-US" });

test("slow connection: the player waits for a deep buffer instead of flapping", async ({ page }) => {
  test.setTimeout(120_000);
  const movie = await setup(page);
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const release = {
    id: "rel-web",
    title: "Movie (2010) WEBRip [VP8 Opus].webm",
    indexer: "RuTracker",
    size_bytes: CLIP.length,
    seeders: 40,
    leechers: 2,
    published_at: "2026-10-20T10:00:00Z",
    info_hash: null,
    resolution: "720p",
    video_codec: null,
    hdr: null,
    audio_codecs: ["opus"],
    languages: ["en"],
    voiceovers: [],
    release_group: null,
    source_quality: "webrip",
    year: 2010,
    seasons: [],
    episodes: [],
    is_season_pack: false,
    confidence: 0.95,
    score: 1,
    reasons: [],
    warnings: [],
  };
  const source = {
    id: SRC_ID,
    media_id: movie.id,
    episode_id: null,
    release,
    status: "ready",
    error: null,
    file: { index: 1, path: "Movie/movie.webm", size_bytes: CLIP.length, is_video: true, season: null, episode: null },
    stream_url: "/api/v1/stream/tok-slow",
    stream_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    compat_url: null,
    mime_type: "video/webm",
    media_info: {
      container: "matroska,webm",
      video_codec: "vp8",
      width: 320,
      height: 180,
      duration_seconds: 40,
      audio: [{ index: 1, codec: "opus", language: "en", title: null, channels: 1, default: true }],
      subtitles: [],
    },
    torrent: { peers: 3, seeders: 2, download_speed_bps: 5000, preloaded_bytes: 0 },
    created_at: new Date().toISOString(),
    kind: "torrent",
  };
  const reports: { state: string; position_seconds: number }[] = [];
  await page.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) => json(route, { items: [release], searched_at: new Date().toISOString(), cached: false, indexer_errors: [] }));
  await page.route(/\/api\/v1\/playback\/sources(\/[^/?]+)?(\?.*)?$/, (route) => json(route, source, route.request().method() === "POST" ? 201 : 200));
  await page.route(/\/api\/v1\/playback\/sessions(\?.*)?$/, (route) => json(route, { id: "5e550000-0000-4000-8000-00000000b0b0", resume_position_seconds: null, progress: null, report_token: "t" }, 201));
  await page.route(/\/api\/v1\/playback\/sessions\/[^/]+\/progress/, (route) => {
    const b = JSON.parse(route.request().postData() ?? "{}") as { state: string; position_seconds: number };
    reports.push({ state: b.state, position_seconds: b.position_seconds });
    return json(route, { accepted: true, progress: null });
  });
  await page.route(new RegExp(`/api/v1/media/${movie.id}/progress`), (route) =>
    json(route, { media_id: movie.id, kind: "movie", movie: null, episodes: [], seasons: [], next_up: null }),
  );
  await page.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, (route) => json(route, { items: [] }));

  // The throttled stream: a first chunk, then 2 KB per 400 ms, then full speed.
  let firstAt = 0;
  await page.route(/\/api\/v1\/stream\/tok-slow/, async (route) => {
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

  await page.goto(`/watch/new?media=${movie.id}&release=rel-web&t=0`);
  await expect(page.getByTestId("player-loader")).toHaveCount(0, { timeout: 30_000 });
  const playerEl = page.getByTestId("player");
  // Count the element's play/pause flips from here on.
  await page.getByTestId("video").evaluate((v: HTMLVideoElement) => {
    const w = window as unknown as { flips: { playing: number[] } };
    w.flips = { playing: [] };
    v.addEventListener("playing", () => w.flips.playing.push(performance.now()));
  });

  // The first chunk runs out → a stall → the player rebuffers (paused by itself).
  await expect(playerEl).toHaveAttribute("data-rebuffering", "true", { timeout: 30_000 });
  const indicator = page.getByTestId("player-rebuffer");
  await expect(indicator).toContainText(/Buffering… \d+%/);
  await expect(page.getByTestId("player-rebuffer-stats")).toContainText(/s ahead · .* Mbit\/s/);
  const t0 = await page.evaluate(() => performance.now());

  // While the connection stays slow it keeps waiting: no "playing" flips.
  const slowLeft = SLOW_FOR_MS - (Date.now() - firstAt);
  if (slowLeft > 1000) await page.waitForTimeout(slowLeft - 500);
  const flipsWhileSlow = await page.evaluate((since) => (window as unknown as { flips: { playing: number[] } }).flips.playing.filter((x) => x > since).length, t0);
  expect(flipsWhileSlow).toBe(0);
  await expect(playerEl).toHaveAttribute("data-rebuffering", "true");
  expect(await page.getByTestId("video").evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);

  // Full speed again → resumes by itself once the buffer is deep enough.
  await expect(playerEl).toHaveAttribute("data-rebuffering", "false", { timeout: 30_000 });
  await expect(playerEl).toHaveAttribute("data-last-resume", /threshold|canplaythrough|end/);
  const at = await page.getByTestId("video").evaluate((v: HTMLVideoElement) => v.currentTime);
  await expect.poll(() => page.getByTestId("video").evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 }).toBeGreaterThan(at + 1);
  // Rebuffering was never reported as a user pause.
  expect(reports.map((r) => r.state)).not.toContain("paused");
});
