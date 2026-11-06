import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { quietHome } from "./quietHome";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

/** A 40 s VP8/Opus WebM (Playwright's Chromium has no H.264). */
const CLIP = readFileSync(new URL("../fixtures/clip.webm", import.meta.url));
const SOURCE_ID = "5e1f0000-0000-4000-8000-0000000000a1";
const SESSION_ID = "5e550000-0000-4000-8000-0000000000b1";
const MESSAGE_ID = "3e550000-0000-4000-8000-0000000000c1";

async function press(tv: Page, key: string, times = 1) {
  for (let i = 0; i < times; i++) {
    await tv.keyboard.press(key);
    await tv.waitForTimeout(160);
  }
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function release(id: string) {
  return {
    id,
    title: `Mock.Release.${id}`,
    indexer: "MockTracker",
    size_bytes: 2_400_000_000,
    seeders: 85,
    leechers: 4,
    published_at: null,
    info_hash: null,
    resolution: "1080p",
    video_codec: "h264",
    hdr: null,
    audio_codecs: ["aac"],
    languages: ["en"],
    voiceovers: [{ kind: "mvo", studio: "LostFilm", language: "ru" }],
    release_group: "MOCK",
    source_quality: "web-dl",
    year: 1999,
    seasons: [],
    episodes: [],
    is_season_pack: false,
    confidence: 0.97,
    score: 10,
    reasons: [],
    warnings: [],
  };
}

/** Releases, one source (preparing → ready) and the clip stream. */
async function mockPlayback(ctx: BrowserContext, mediaId: () => string) {
  let polls = 0;
  const source = () => {
    const ready = polls >= 2;
    return {
      id: SOURCE_ID,
      media_id: mediaId(),
      episode_id: null,
      release: release("rel-good"),
      status: ready ? "ready" : "preparing",
      error: null,
      file: ready ? { index: 0, path: "Movie/good.webm", size_bytes: CLIP.length, is_video: true, season: null, episode: null } : null,
      stream_url: ready ? `/api/v1/stream/tok-good-${polls}` : null,
      stream_expires_at: ready ? new Date(Date.now() + 3600_000).toISOString() : null,
      mime_type: "video/webm",
      media_info: ready
        ? { container: "matroska,webm", video_codec: "vp8", width: 320, height: 180, duration_seconds: 40, audio: [{ index: 1, codec: "opus", language: "eng", title: "Original", channels: 1, default: true }], subtitles: [] }
        : null,
      torrent: { peers: ready ? 14 : 3, seeders: 9, download_speed_bps: 3_200_000, preloaded_bytes: polls * 9_000_000 },
      created_at: new Date().toISOString(),
    };
  };
  // Online sources answer live in dev: keep Details hermetic (no «Смотреть онлайн» button).
  await ctx.route(/\/api\/v1\/media\/[^/]+\/online/, (route) => json(route, { items: [], providers: [], searched_at: new Date().toISOString(), cached: true }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) => json(route, { items: [release("rel-good")], searched_at: new Date().toISOString(), cached: false, indexer_errors: [] }));
  await ctx.route(/\/api\/v1\/playback\/sources(\/[^/?]+)?(\?.*)?$/, (route) => {
    if (route.request().method() === "POST") {
      polls = 0;
      return json(route, source(), 201);
    }
    polls++;
    return json(route, source());
  });
  await ctx.route(/\/api\/v1\/stream\//, (route) => {
    const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers()["range"] ?? "");
    if (!m) return route.fulfill({ status: 200, headers: { "Content-Type": "video/webm", "Accept-Ranges": "bytes" }, body: CLIP });
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), CLIP.length - 1) : CLIP.length - 1;
    return route.fulfill({
      status: 206,
      headers: { "Content-Type": "video/webm", "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${CLIP.length}` },
      body: CLIP.subarray(start, end + 1),
    });
  });
}

interface Report {
  seq: number;
  position_seconds: number;
  duration_seconds: number | null;
  state: string;
  beacon: boolean;
}

/**
 * Watch sync (mocked so the run is deterministic and leaves no progress on
 * the real profile): sessions, progress reports, media progress, continue
 * watching, profile settings, messages.
 */
async function mockWatch(ctx: BrowserContext, media: () => { id: string; title: string }) {
  const state = {
    sessions: [] as Record<string, unknown>[],
    reports: [] as Report[],
    position: null as number | null,
    reads: [] as string[],
  };
  // The clip is 40 s; pretend the title is 10 min long so 30+ s is resumable.
  const DURATION = 600;
  const progress = () =>
    state.position === null
      ? null
      : {
          media_id: media().id,
          episode_id: null,
          season_number: null,
          episode_number: null,
          position_seconds: state.position,
          duration_seconds: DURATION,
          percent: state.position / DURATION,
          completed: false,
          completed_at: null,
          updated_at: new Date().toISOString(),
          device_id: null,
        };
  await ctx.route(/\/api\/v1\/playback\/sessions(\?.*)?$/, (route) => {
    state.sessions.push(route.request().postDataJSON() as Record<string, unknown>);
    return json(route, { id: SESSION_ID, resume_position_seconds: state.position, progress: progress(), report_token: "beacon-token" }, 201);
  });
  await ctx.route(/\/api\/v1\/playback\/sessions\/[^/]+\/progress/, (route) => {
    const req = route.request();
    const body = JSON.parse(req.postData() ?? "{}") as Report;
    const beacon = req.url().includes("token=beacon-token");
    state.reports.push({ ...body, beacon });
    if (body.position_seconds >= 30) state.position = body.position_seconds;
    return json(route, { accepted: true, progress: progress() });
  });
  await ctx.route(/\/api\/v1\/media\/[^/]+\/progress/, (route) =>
    json(route, { media_id: media().id, kind: "movie", movie: progress(), episodes: [], seasons: [], next_up: null }),
  );
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, async (route) => {
    if (state.position === null) return json(route, { items: [] });
    // A real MediaSummary for the card.
    const res = await route.fetch({ url: route.request().url().replace(/\/profiles\/[^/]+\/continue-watching.*/, `/media/${media().id}?lang=en`), method: "GET" });
    const m = await res.json();
    return json(route, { items: [{ media: m, progress: progress(), next_up: null }] });
  });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, (route) =>
    json(route, { theme: "dark", design: "kinozal", hide_anime: false, hide_watched: false, autoplay_next_episode: true, spoiler_free_episodes: false, loading_style: "minimal", onboarding_completed: true }),
  );
  await ctx.route(/\/api\/v1\/messages(\?.*)?$/, (route) =>
    json(route, {
      items: [{ id: MESSAGE_ID, title: "Movie night", body: "Friday at 8, bring snacks.", from_name: "Marty", created_at: new Date().toISOString(), read_at: null }],
      unread: 1,
    }),
  );
  await ctx.route(/\/api\/v1\/messages\/[^/]+\/read/, (route) => {
    state.reads.push(route.request().url());
    return route.fulfill({ status: 204 });
  });
  return state;
}

const video = (tv: Page) => tv.locator("[data-testid=player] video");
const currentTime = (tv: Page) => video(tv).evaluate((v: HTMLVideoElement) => v.currentTime);

/**
 * Phase 5 TV acceptance: playing reports progress (increasing seq), page
 * hide sends a beacon, Back sends a final report; reopening offers "Resume
 * at …" at the reported position; Home shows Continue watching, whose OK
 * resumes straight away. Also: an admin message at start (OK marks read).
 */
test("TV watch progress: reports, resume, continue watching, messages", async ({ browser }) => {
  test.setTimeout(180_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
  await quietHome(tvCtx);
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
  const search = await (await phoneCtx.request.get(`/api/v1/catalog/search?q=${encodeURIComponent("The Matrix")}&kind=movie&lang=en`)).json();
  const movie = { id: search.items[0].id as string, title: search.items[0].title as string };
  await mockPlayback(tvCtx, () => movie.id);
  const watch = await mockWatch(tvCtx, () => movie);

  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Watch TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  try {
    const devices = await (await phoneCtx.request.get("/api/v1/devices")).json();
    const deviceId = devices.items.find((d: { name: string }) => d.name === deviceName).id as string;
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");

    // --- An unread admin message is shown once; OK marks it read.
    const message = tv.getByTestId("tv-message");
    await expect(message).toContainText("Movie night", { timeout: 30_000 });
    await expect(message).toContainText("From Marty");
    await press(tv, "Enter");
    await expect(message).toHaveCount(0);
    expect(watch.reads.some((u) => u.includes(MESSAGE_ID))).toBe(true);

    await expect(tv.getByText("Trending this week")).toBeVisible({ timeout: 30_000 });
    await expect(tv.getByText("Continue watching")).toHaveCount(0);

    // --- Details → Play (no progress yet: plain "Play") → picker → preparing → playing.
    const r = await phone.evaluate(
      async ({ deviceId, mediaId }) => {
        const s = await (await fetch("/api/v1/auth/session")).json();
        const res = await fetch(`/api/v1/devices/${deviceId}/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": s.csrf_token },
          body: JSON.stringify({ type: "media.open", payload: { media_id: mediaId } }),
        });
        return res.json();
      },
      { deviceId, mediaId: movie.id },
    );
    expect(r.ok).toBe(true);
    await expect(tv.locator("[data-media-id] .is-focused")).toHaveText(/^\s*▶\s*Play\s*$/, { timeout: 20_000 });
    // ☰ (sources) next to Play opens the release picker.
    await press(tv, "ArrowRight");
    await press(tv, "Enter");
    const rows = tv.locator("[data-testid=release-picker] [data-release-id]");
    await expect(rows.nth(0)).toHaveClass(/is-focused/);
    await expect(rows.nth(0).locator("[data-voiceover]")).toHaveText("MVO · LostFilm");
    await press(tv, "Enter");
    // The profile's loading style (minimal) is used for the first load.
    await expect(tv.locator("[data-loader=minimal]")).toBeVisible();
    await expect(tv.getByTestId("player-preparing")).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => currentTime(tv), { timeout: 15_000 }).toBeGreaterThan(1);
    expect(watch.sessions[0]).toMatchObject({ media_id: movie.id, source_id: SOURCE_ID });
    await expect.poll(() => watch.reports.length).toBeGreaterThan(0);
    expect(watch.reports[0]).toMatchObject({ seq: 1, state: "playing", beacon: false });

    // --- Seek forward 30 s: a "seeking" report at the new position.
    await press(tv, "ArrowRight");
    await expect.poll(() => watch.reports.some((x) => x.state === "seeking" && x.position_seconds >= 30), { timeout: 10_000 }).toBe(true);
    // Pause → an immediate "paused" report.
    await press(tv, "Enter");
    await expect.poll(() => watch.reports.some((x) => x.state === "paused")).toBe(true);

    // --- Page hidden: a header-less beacon with the report token.
    await tv.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    });
    await expect.poll(() => watch.reports.some((x) => x.beacon)).toBe(true);

    // --- Back: a final "stopped" report; seq always increased. (Paused: the
    // first Back folds the pause overlay, the second leaves.)
    await press(tv, "Escape");
    if (await tv.getByTestId("player").isVisible().catch(() => false)) await press(tv, "Escape");
    await expect(tv.getByTestId("player")).toHaveCount(0);
    await expect.poll(() => watch.reports[watch.reports.length - 1]?.state).toBe("stopped");
    const seqs = watch.reports.map((x) => x.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const stoppedAt = watch.reports[watch.reports.length - 1]!.position_seconds;
    expect(stoppedAt).toBeGreaterThanOrEqual(30);

    // --- Reopening offers "Resume at …" (focused) / "Start over".
    await expect(tv.locator("[data-media-id] .is-focused")).toContainText(/resume/i, { timeout: 10_000 });
    await expect(tv.getByTestId("movie-progress")).toBeVisible();
    await press(tv, "Enter");
    const menu = tv.getByTestId("resume-menu");
    await expect(menu.locator(".is-focused")).toContainText(`Resume at 0:${String(Math.floor(stoppedAt)).padStart(2, "0")}`);
    await expect(menu).toContainText("Start over");
    // One press: Play resumes the auto-selected source (no picker).
    await press(tv, "Enter");
    await expect(rows).toHaveCount(0);
    await expect.poll(() => currentTime(tv), { timeout: 20_000 }).toBeGreaterThanOrEqual(stoppedAt - 1);
    await press(tv, "Escape"); // hide controls / exit
    if (await tv.getByTestId("player").isVisible().catch(() => false)) await press(tv, "Escape");
    await expect(tv.getByTestId("player")).toHaveCount(0);

    // --- Home: "Continue watching" comes first; OK opens Details with Play = «Resume · m:ss».
    await press(tv, "Escape");
    const card = tv.locator(`[data-continue-id="${movie.id}"]`);
    await expect(tv.getByText("Continue watching")).toBeVisible({ timeout: 15_000 });
    await expect(card).toBeVisible();
    await expect(card.locator("[data-progress]")).toBeVisible();
    // Focus may still be on the row it was on before; the continue row is first.
    for (let i = 0; i < 4 && !(await tv.locator(`[data-focus-key*="row-continue"]:has(.is-focused)`).count()); i++) await press(tv, "ArrowUp");
    await expect(tv.locator(`[data-focus-key*="row-continue"]:has(.is-focused)`)).toHaveCount(1);
    await press(tv, "Enter");
    await expect(tv.locator(`[data-media-id="${movie.id}"]`)).toBeVisible();
    await expect(tv.locator("[data-media-id] .is-focused")).toContainText(/Resume · 0:\d\d/, { timeout: 10_000 });
    await expect(tv.getByTestId("player")).toHaveCount(0);
    // Back → the same card; holding OK offers «Resume now» (the old quick path).
    await press(tv, "Escape");
    await expect(tv.locator(`[data-focus-key*="row-continue"]:has(.is-focused)`)).toHaveCount(1);
    await tv.keyboard.down("Enter");
    await tv.waitForTimeout(900);
    await tv.keyboard.up("Enter");
    const quick = tv.getByTestId("continue-menu");
    await expect(quick.locator(".is-focused")).toContainText("Resume now");
    await press(tv, "Enter");
    await expect.poll(() => currentTime(tv), { timeout: 20_000 }).toBeGreaterThanOrEqual(29);
    await press(tv, "Escape");
    if (await tv.getByTestId("player").isVisible().catch(() => false)) await press(tv, "Escape");
    await expect(tv.getByTestId("player")).toHaveCount(0);
  } finally {
    await phone.goto("/devices");
    const card = phone.locator("section", { hasText: deviceName });
    phone.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: /unpair/i }).click();
    await expect(card).toHaveCount(0);
  }
});
