import { readFileSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

/** A 40 s VP8/Opus WebM (Playwright's Chromium has no H.264). */
const CLIP = readFileSync(new URL("../fixtures/clip.webm", import.meta.url));

const SRC = { good: "5e1ec7ed-0000-4000-8000-00000000a001", bad: "5e1ec7ed-0000-4000-8000-00000000a002" };
const SESSION = "5e550000-0000-4000-8000-00000000a0a0";

function release(id: string, o: Record<string, unknown> = {}) {
  return {
    id,
    title: `Movie (2010) ${id}`,
    indexer: "RuTracker",
    size_bytes: 3_000_000_000,
    seeders: 40,
    leechers: 2,
    published_at: "2026-10-20T10:00:00Z",
    info_hash: null,
    resolution: "1080p",
    video_codec: "h264",
    hdr: null,
    audio_codecs: ["aac"],
    languages: ["ru", "en"],
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
    ...o,
  };
}

// Ranked by the "server": a 4K HEVC + DTS remux first (won't play in a
// browser), a WebM that does, an AVI that doesn't.
const RELEASES = [
  release("rel-4k", { resolution: "2160p", video_codec: "hevc", audio_codecs: ["dts", "ac3"], source_quality: "remux", size_bytes: 58_000_000_000 }),
  release("rel-web", { title: "Movie (2010) WEBRip 720p [VP8 Opus].webm", video_codec: null, audio_codecs: ["opus"], resolution: "720p", source_quality: "webrip" }),
  release("rel-avi", { title: "Movie (2010) DVDRip XviD.avi", video_codec: "xvid", audio_codecs: ["mp3"], resolution: "480p", source_quality: "dvd" }),
];

interface Log {
  created: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  reports: { seq: number; position_seconds: number; state: string; beacon: boolean }[];
  streams: number;
}

/** Releases, sources (preparing → ready), the stream (with Range), sessions and progress. */
async function mockPlayback(page: Page, mediaId: string): Promise<Log> {
  const log: Log = { created: [], sessions: [], reports: [], streams: 0 };
  const polls = new Map<string, number>();
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  const source = (key: keyof typeof SRC) => {
    const id = SRC[key];
    const n = polls.get(id) ?? 0;
    const ready = n >= 2;
    const good = key === "good";
    return {
      id,
      media_id: mediaId,
      episode_id: null,
      release: good ? RELEASES[1] : RELEASES[2],
      status: ready ? "ready" : "preparing",
      error: null,
      file: ready ? { index: 1, path: good ? "Movie/movie.webm" : "Movie/movie.avi", size_bytes: CLIP.length, is_video: true, season: null, episode: null } : null,
      stream_url: ready ? `/api/v1/stream/tok-${key}-${n}` : null,
      stream_expires_at: ready ? new Date(Date.now() + 3600_000).toISOString() : null,
      mime_type: good ? "video/webm" : "video/x-msvideo",
      media_info: ready
        ? good
          ? {
              container: "matroska,webm",
              video_codec: "vp8",
              width: 320,
              height: 180,
              duration_seconds: 40,
              audio: [{ index: 1, codec: "opus", language: "en", title: null, channels: 1, default: true }],
              subtitles: [],
            }
          : { container: "avi", video_codec: "mpeg4", width: 640, height: 360, duration_seconds: 40, audio: [{ index: 1, codec: "mp3", language: "ru", title: null, channels: 2, default: true }], subtitles: [] }
        : null,
      torrent: { peers: ready ? 14 : 4, seeders: 9, download_speed_bps: 3_200_000, preloaded_bytes: n * 12_000_000 },
      created_at: new Date().toISOString(),
    };
  };

  await page.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) =>
    json(route, { items: RELEASES, searched_at: new Date().toISOString(), cached: false, indexer_errors: [] }),
  );
  await page.route(/\/api\/v1\/playback\/sources(\/[^/?]+)?(\?.*)?$/, async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      const body = req.postDataJSON() as Record<string, unknown>;
      log.created.push(body);
      const key = body.release_id === "rel-web" ? "good" : "bad";
      polls.set(SRC[key], 0);
      return json(route, source(key), 201);
    }
    const id = new URL(req.url()).pathname.split("/").pop()!;
    const key = id === SRC.good ? "good" : id === SRC.bad ? "bad" : null;
    if (!key) return json(route, { error: { code: "not_found", message: "no source" } }, 404);
    polls.set(id, (polls.get(id) ?? 0) + 1);
    return json(route, source(key));
  });
  await page.route(/\/api\/v1\/stream\//, (route) => {
    log.streams++;
    const good = route.request().url().includes("tok-good");
    const body = good ? CLIP : Buffer.from("RIFF....AVI LIST this is not a playable avi ".repeat(400));
    const type = good ? "video/webm" : "video/x-msvideo";
    // Like the real proxy: HTTP Range support (needed for seeking).
    const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers()["range"] ?? "");
    if (!m) return route.fulfill({ status: 200, headers: { "Content-Type": type, "Accept-Ranges": "bytes" }, body });
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
    return route.fulfill({
      status: 206,
      headers: { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${body.length}` },
      body: body.subarray(start, end + 1),
    });
  });

  // Sessions and progress are mocked: nothing is recorded on the real profile.
  let last: { position: number; duration: number | null } | null = null;
  await page.route(/\/api\/v1\/playback\/sessions(\?.*)?$/, (route) => {
    log.sessions.push(route.request().postDataJSON() as Record<string, unknown>);
    return json(route, { id: SESSION, resume_position_seconds: last?.position ?? null, progress: null, report_token: "beacon-token" }, 201);
  });
  await page.route(/\/api\/v1\/playback\/sessions\/[^/]+\/progress/, (route) => {
    const req = route.request();
    const body = JSON.parse(req.postData() ?? "{}") as { seq: number; position_seconds: number; duration_seconds: number | null; state: string };
    const beacon = new URL(req.url()).searchParams.get("token") === "beacon-token";
    log.reports.push({ seq: body.seq, position_seconds: body.position_seconds, state: body.state, beacon });
    last = { position: body.position_seconds, duration: body.duration_seconds };
    return json(route, { accepted: true, progress: null });
  });
  await page.route(new RegExp(`/api/v1/media/${mediaId}/progress`), (route) =>
    json(route, {
      media_id: mediaId,
      kind: "movie",
      movie:
        last && last.position >= 30
          ? {
              media_id: mediaId,
              episode_id: null,
              season_number: null,
              episode_number: null,
              position_seconds: last.position,
              duration_seconds: last.duration,
              percent: last.duration ? last.position / last.duration : 0,
              completed: false,
              completed_at: null,
              updated_at: new Date().toISOString(),
              device_id: null,
            }
          : null,
      episodes: [],
      seasons: [],
      next_up: null,
    }),
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
  return { movie, profileId: profiles[0].id as string };
}

const video = (page: Page) => page.getByTestId("video");
const currentTime = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.currentTime);
const isPaused = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.paused);

test.use({ viewport: { width: 390, height: 844 }, locale: "en-US" });

/**
 * Watch in the browser: title → "Watch here" → first-load screen → the video
 * plays; pause / seek; progress reports with increasing seq; leaving sends a
 * final report (and a beacon on pagehide); reopening offers "Resume at …";
 * a release this browser can't play shows the fallback actions.
 */
test("watch a title in the browser with progress, resume and fallback", async ({ page }) => {
  test.setTimeout(120_000);
  const { movie, profileId } = await setup(page);
  const log = await mockPlayback(page, movie.id);

  // Title → Watch here: the best release *for this browser* is prepared (not the 4K remux).
  await page.goto(`/title/${movie.id}`);
  await page.getByTestId("play-more").click(); // «Где и как смотреть»
  await page.getByTestId("watch-here").click();
  await expect(page).toHaveURL(/\/watch\//);
  await expect(page.getByTestId("player-loader")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/watch/${SRC.good}\\?media=${movie.id}`), { timeout: 15_000 });
  expect(log.created).toEqual([expect.objectContaining({ media_id: movie.id, release_id: "rel-web", profile_id: profileId })]);

  // Plays: the loader goes away and time advances.
  await expect(page.getByTestId("player-loader")).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(() => currentTime(page), { timeout: 15_000 }).toBeGreaterThan(1);
  await expect(page.getByTestId("player-title")).toHaveText(movie.title);
  expect(log.sessions).toEqual([expect.objectContaining({ profile_id: profileId, media_id: movie.id, source_id: SRC.good })]);

  // Pause with the button (controls show on activity), play with K, pause with Space.
  await page.mouse.move(200, 400);
  await page.getByTestId("player-toggle").click();
  await expect.poll(() => isPaused(page)).toBe(true);
  await page.keyboard.press("k");
  await expect.poll(() => isPaused(page)).toBe(false);
  await page.keyboard.press(" ");
  await expect.poll(() => isPaused(page)).toBe(true);
  // Paused: what plays and how it loads (quality · peers/seeders · speed).
  await page.mouse.move(500, 300);
  await expect(page.getByTestId("player-paused-stats")).toContainText(/seeders/i);

  // Seek: +30 s button.
  const before = await currentTime(page);
  await page.getByTestId("player-forward30").click();
  await expect.poll(() => currentTime(page)).toBeGreaterThan(before + 25);
  await expect(page.getByTestId("player-time")).toContainText("0:3");

  // Reports: playing, paused, playing, paused, seeking… with increasing seq.
  await expect.poll(() => log.reports.map((r) => r.state)).toEqual(expect.arrayContaining(["playing", "paused", "seeking"]));
  const seqs = log.reports.map((r) => r.seq);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(new Set(seqs).size).toBe(seqs.length);

  // pagehide → a beacon with the report token.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await expect.poll(() => log.reports.some((r) => r.beacon)).toBe(true);

  // Leaving the player → a final "stopped" report.
  const n = log.reports.length;
  await page.getByTestId("player-back").click();
  await expect(page).toHaveURL(new RegExp(`/title/${movie.id}`));
  await expect.poll(() => log.reports.slice(n).map((r) => r.state)).toContain("stopped");
  const lastSeq = log.reports.at(-1)!.seq;
  expect(lastSeq).toBe(Math.max(...log.reports.map((r) => r.seq)));
  const resumeAt = log.reports.at(-1)!.position_seconds;
  expect(resumeAt).toBeGreaterThanOrEqual(30);

  // Reopen: the play button says "Resume at 0:3x"; its menu ("From 0:3x" preselected) → here
  // starts at that position (the choice was made on the title page: no second question).
  await page.reload();
  await expect(page.getByTestId("play-on-tv")).toContainText(/Resume at 0:3\d/);
  await page.getByTestId("play-more").click();
  await expect(page.getByTestId("resume-from")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("watch-here").click();
  await expect(page).toHaveURL(/[?&]t=3\d/);
  await expect(page.getByTestId("resume-prompt")).toHaveCount(0);
  await expect(page.getByTestId("player-loader")).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(() => currentTime(page)).toBeGreaterThan(resumeAt - 1);
  await page.getByTestId("player-back").click();
  await expect(page).toHaveURL(new RegExp(`/title/${movie.id}`));

  // Release list in "This browser" mode: badges, playable first.
  await page.getByTestId("play-more").click(); // «Где и как смотреть» menu
  await page.getByTestId("choose-release").click();
  const sheet = page.getByTestId("release-sheet");
  await sheet.locator('[data-testid=release-mode] [data-mode="here"]').click();
  await expect(sheet.getByTestId("release-row")).toHaveCount(3, { timeout: 15_000 });
  await expect(sheet.getByTestId("release-row").first()).toHaveAttribute("data-release-id", "rel-web");
  await expect(sheet.locator('[data-release-id="rel-web"] [data-testid=browser-badge]')).toHaveAttribute("data-verdict", /playable|maybe/);
  await expect(sheet.locator('[data-release-id="rel-4k"] [data-testid=browser-badge]')).toHaveText("Won't play here");
  await expect(sheet.locator('[data-release-id="rel-avi"] [data-testid=browser-badge]')).toHaveAttribute("data-verdict", "unlikely");

  // An AVI (video/x-msvideo) → the fallback screen with its actions.
  await sheet.locator('[data-release-id="rel-avi"] [data-testid=release-pick]').click();
  const fallback = page.getByTestId("player-fallback");
  await expect(fallback).toBeVisible({ timeout: 20_000 });
  await expect(fallback).toHaveAttribute("data-mode", "precheck");
  await expect(fallback.getByTestId("fallback-reasons")).toContainText(/AVI/);
  await expect(fallback.getByTestId("fallback-another")).toBeEnabled();
  await fallback.getByTestId("fallback-apps").click();
  await expect(fallback.getByTestId("play-here-options")).toBeVisible();
  // On a computer: playlist + link (vlc:// only exists on phones).
  await expect(fallback.locator('[data-option="m3u"]')).toBeVisible();
  await expect(fallback.locator('[data-option="vlc"]')).toHaveCount(0);

  // "Try anyway" → the engine refuses the file → still the fallback (unsupported).
  await fallback.getByTestId("fallback-try").click();
  await expect(page.getByTestId("player-fallback")).toHaveAttribute("data-mode", /unsupported|decode/, { timeout: 20_000 });

  // "Try another release (better for browsers)" → the WebM plays.
  await page.getByTestId("fallback-another").click();
  await expect(page).toHaveURL(new RegExp(`/watch/${SRC.good}`), { timeout: 15_000 });
  await expect(page.getByTestId("player-fallback")).toHaveCount(0);
});

/**
 * «Уточнить»: the automatic search finds nothing → "Refine the search" →
 * pre-filled query (Russian title + year), chip to the original title,
 * uncertain matches on → results flagged "Uncertain match"; the refine is
 * remembered for the title.
 */
test("refine an empty release search", async ({ page }) => {
  test.setTimeout(90_000);
  const { movie } = await setup(page);
  const asked: URLSearchParams[] = [];
  await page.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) => {
    const u = new URL(route.request().url());
    asked.push(u.searchParams);
    const q = u.searchParams.get("q");
    const items = q
      ? [release("rel-loose", { title: `${q} (2010) BDRip 1080p`, confidence: 0.4, warnings: ["uncertain_match"] })]
      : [];
    return route.fulfill({ json: { items, searched_at: new Date().toISOString(), cached: false, indexer_errors: [] } });
  });
  await page.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, (route) => route.fulfill({ json: { items: [] } }));

  await page.goto(`/title/${movie.id}`);
  await page.getByTestId("play-more").click(); // «Где и как смотреть» menu
  await page.getByTestId("choose-release").click();
  const sheet = page.getByTestId("release-sheet");
  await expect(sheet.getByTestId("releases-empty")).toBeVisible({ timeout: 15_000 });
  await sheet.getByTestId("releases-refine-empty").click();

  const refine = page.getByTestId("refine-sheet");
  const input = refine.getByTestId("refine-query");
  await expect(input).toHaveValue(/2010$/);
  await expect(input).not.toHaveValue(/^Inception/); // the Russian title first
  await refine.locator('[data-chip="original"]').click();
  await expect(input).toHaveValue("Inception 2010");
  await refine.getByTestId("refine-loose").check();
  await refine.getByTestId("refine-search").click();

  await expect(refine).toHaveCount(0);
  await expect(sheet.getByTestId("release-row")).toHaveCount(1, { timeout: 15_000 });
  await expect(sheet.getByTestId("release-row")).toContainText("Uncertain match");
  await expect(sheet.getByTestId("refine-active")).toContainText("Inception 2010");
  const last = asked.at(-1)!;
  expect(last.get("q")).toBe("Inception 2010");
  expect(last.get("loose")).toBe("true");

  // Remembered for this title: reopening the list uses the refined search.
  await page.keyboard.press("Escape");
  await page.getByTestId("play-more").click(); // «Где и как смотреть» menu
  await page.getByTestId("choose-release").click();
  await expect(page.getByTestId("release-sheet").getByTestId("refine-active")).toBeVisible();
  await expect(page.getByTestId("release-sheet").getByTestId("release-row")).toHaveCount(1);
});
