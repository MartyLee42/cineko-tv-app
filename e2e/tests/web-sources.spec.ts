import { mkdirSync, readFileSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

/** A 16 s VP9/Opus fMP4 HLS (Playwright's Chromium has no H.264): playlist, init, 4 segments. */
const HLS = (name: string) => readFileSync(new URL(`../fixtures/hls/${name}`, import.meta.url));
const SHOTS = "test-results/sources-shots";
mkdirSync(SHOTS, { recursive: true });

const SOURCE_ID = "5e1ec7ed-0000-4000-8000-00000000b001";
const SESSION = "5e550000-0000-4000-8000-00000000b0b0";

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function release(id: string, provider: "prowlarr" | "jacred", o: Record<string, unknown> = {}) {
  return {
    id,
    provider: { id: provider, name: provider === "prowlarr" ? "Prowlarr" : "Jacred", kind: "torrent" },
    title: `Movie (2010) ${id} 1080p WEB-DL`,
    indexer: provider === "prowlarr" ? "RuTracker" : "Kinozal",
    size_bytes: 3_000_000_000,
    seeders: 40,
    leechers: 2,
    published_at: "2026-10-20T10:00:00Z",
    info_hash: null,
    resolution: "1080p",
    video_codec: "h264",
    hdr: null,
    audio_codecs: ["aac"],
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
    ...o,
  };
}

function variant(id: string, o: Record<string, unknown> = {}) {
  return {
    id,
    provider: { id: "anilibria", name: "AniLiberty", kind: "anime" },
    voice: "AniLibria",
    voiceover: { kind: "mvo", studio: "AniLibria", language: "ru" },
    title: null,
    max_quality: 1080,
    qualities: [1080, 720, 480],
    format: "hls",
    subtitle_langs: [],
    season: null,
    episode: null,
    episodes: [],
    preferred: false,
    score: 0.8,
    ...o,
  };
}

const SETTINGS = {
  theme: "dark",
  design: "kinozal",
  hide_anime: false,
  hide_watched: false,
  autoplay_next_episode: true,
  spoiler_free_episodes: false,
  onboarding_completed: true,
  loading_style: "minimal",
  poster_rating: "kp",
};

interface Log {
  created: Record<string, unknown>[];
  patched: Record<string, unknown>[];
  streams: Record<string, number>;
  settingsPuts: Record<string, unknown>[];
  releaseQueries: URLSearchParams[];
}

/** Sources, online variants, releases (filtered by the profile's sources), an online HLS source and its stream. */
async function mockSources(page: Page, mediaId: string, opts: { settings?: Record<string, unknown>; markers?: unknown[] } = {}): Promise<Log> {
  const log: Log = { created: [], patched: [], streams: {}, settingsPuts: [], releaseQueries: [] };
  let enabled: "all" | string[] = "all";
  let quality = 1080;
  const on = (id: string) => enabled === "all" || enabled.includes(id);

  const sourceItems = () =>
    [
      { id: "prowlarr", kind: "torrent", name: "Prowlarr", needs_credentials: true, configured: true, enabled_by_admin: true, healthy: true },
      { id: "jacred", kind: "torrent", name: "Jacred", needs_credentials: false, configured: true, enabled_by_admin: true, healthy: true },
      { id: "anilibria", kind: "anime", name: "AniLiberty", needs_credentials: false, configured: true, enabled_by_admin: true, healthy: null },
    ].map((s) => ({ ...s, enabled: on(s.id), available: true }));

  await page.route(/\/api\/v1\/sources(\?.*)?$/, (route) => json(route, { items: sourceItems(), enabled }));
  await page.route(/\/api\/v1\/profiles\/[^/]+\/settings$/, async (route) => {
    const req = route.request();
    if (req.method() === "PUT") {
      const body = req.postDataJSON() as { sources?: { enabled: "all" | string[] } };
      log.settingsPuts.push(body);
      if (body.sources) enabled = body.sources.enabled;
    }
    return json(route, { ...SETTINGS, ...opts.settings, sources: { enabled } });
  });
  await page.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) => {
    log.releaseQueries.push(new URL(route.request().url()).searchParams);
    const items = [release("rel-p", "prowlarr"), release("rel-j", "jacred", { resolution: "720p", seeders: 12 })].filter((r) => on(r.provider.id));
    return json(route, { items, searched_at: new Date().toISOString(), cached: false, indexer_errors: [] });
  });
  await page.route(/\/api\/v1\/media\/[^/]+\/online/, (route) =>
    json(route, {
      items: on("anilibria")
        ? [variant("o-pref", { preferred: true, score: 0.93 }), variant("o-alt", { voice: "AniLibria (2-я версия)", max_quality: 720, qualities: [720, 480] })]
        : [],
      providers: [
        { id: "anilibria", name: "AniLiberty", kind: "anime", status: "ok", count: 2, error: null, cached: false },
        { id: "anifake", name: "AniMirror", kind: "anime", status: "timeout", count: 0, error: "timeout", cached: false },
      ],
      searched_at: new Date().toISOString(),
      cached: false,
    }),
  );

  const source = () => ({
    id: SOURCE_ID,
    media_id: mediaId,
    episode_id: null,
    release: { ...release("o-pref", "prowlarr"), provider: { id: "anilibria", name: "AniLiberty", kind: "anime" }, title: "AniLiberty", size_bytes: 0 },
    status: "ready",
    error: null,
    file: null,
    stream_url: `/api/v1/stream/tok-q${quality}/index.m3u8`,
    stream_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    mime_type: "application/vnd.apple.mpegurl",
    media_info: null,
    torrent: null,
    created_at: new Date().toISOString(),
    kind: "online",
    provider: { id: "anilibria", name: "AniLiberty", kind: "anime" },
    format: "hls",
    quality,
    qualities: [1080, 720, 480],
    subtitles: [{ url: `/api/v1/stream/tok-q${quality}/subs.vtt`, lang: "en", label: "English" }],
    markers: opts.markers ?? [{ kind: "opening", start_seconds: 1, end_seconds: 9 }],
    duration_seconds: 16,
  });
  await page.route(/\/api\/v1\/playback\/sources(\/[^/?]+)?(\?.*)?$/, (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      log.created.push(req.postDataJSON() as Record<string, unknown>);
      return json(route, source(), 201);
    }
    if (req.method() === "PATCH") {
      const body = req.postDataJSON() as { quality: number };
      log.patched.push(body);
      quality = body.quality;
    }
    return json(route, source());
  });
  await page.route(/\/api\/v1\/stream\//, (route) => {
    const parts = new URL(route.request().url()).pathname.split("/");
    const tok = parts.at(-2)!;
    const file = parts.at(-1)!;
    log.streams[tok] = (log.streams[tok] ?? 0) + 1;
    if (file === "subs.vtt") return route.fulfill({ status: 200, contentType: "text/vtt", body: "WEBVTT\n\n00:00.000 --> 00:15.000\nHello\n" });
    const type = file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4";
    return route.fulfill({ status: 200, headers: { "Content-Type": type }, body: HLS(file) });
  });
  // Sessions / progress: nothing is recorded on the real profile.
  await page.route(/\/api\/v1\/playback\/sessions(\?.*)?$/, (route) => json(route, { id: SESSION, resume_position_seconds: null, progress: null, report_token: "t" }, 201));
  await page.route(/\/api\/v1\/playback\/sessions\/[^/]+\/progress/, (route) => json(route, { accepted: true, progress: null }));
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
  // The owner's language (labels below are Russian); applied on the next navigation.
  await page.evaluate(() => localStorage.setItem("martytv.locale", "ru"));
  const search = await (await req.get("/api/v1/catalog/search?q=Spirited%20Away&kind=movie")).json();
  const movie = search.items[0] as { id: string; title: string };
  expect(movie).toBeTruthy();
  return { movie, profileId: profiles[0].id as string };
}

const video = (page: Page) => page.getByTestId("video");
const currentTime = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.currentTime);

// Recent Chromium answers "maybe" for HLS (native playback, like Safari/iOS
// and TV engines); desktop pretends it can't, as Firefox does, so hls.js runs.
for (const vp of [
  { name: "phone", viewport: { width: 390, height: 844 }, engine: "native" },
  { name: "desktop", viewport: { width: 1366, height: 900 }, engine: "hlsjs" },
]) {
  test.describe(`sources (${vp.name})`, () => {
    test.use({ viewport: vp.viewport, locale: "en-US" });

    /**
     * Release list: provider chips on torrents and the «Аниме · AniLiberty»
     * group; "Watch here" on the preferred variant plays the HLS stream
     * (hls.js), skips the opening, switches quality keeping the position.
     */
    /** «Пропускать сами»: the recap goes by itself; «Вернуть» brings it back (then a button). */
    test("auto-skip recap → undo", async ({ page }) => {
      test.setTimeout(90_000);
      if (vp.engine === "hlsjs") {
        await page.addInitScript(() => {
          const orig = HTMLMediaElement.prototype.canPlayType;
          HTMLMediaElement.prototype.canPlayType = function (t: string) {
            return /mpegurl/i.test(t) ? "" : orig.call(this, t);
          };
        });
      }
      const { movie } = await setup(page);
      await mockSources(page, movie.id, {
        settings: { skip_segments: "auto" },
        markers: [{ kind: "recap", start_seconds: 0, end_seconds: 9, source: "theintrodb" }],
      });
      await page.goto(`/title/${movie.id}`);
      await page.getByTestId("play-more").click(); // «Где и как смотреть» menu
      await page.getByTestId("choose-release").click();
      await page.getByTestId("release-sheet").getByTestId("online-row").nth(0).getByTestId("online-watch-here").click();
      await expect(page).toHaveURL(new RegExp(`/watch/${SOURCE_ID}`), { timeout: 15_000 });

      const undo = page.getByTestId("skip-undo");
      await expect(undo).toBeVisible({ timeout: 20_000 });
      await expect(undo).toContainText("Пересказ пропущен");
      await expect.poll(() => currentTime(page)).toBeGreaterThanOrEqual(8.9);
      await page.screenshot({ path: `${SHOTS}/web-player-autoskip-${vp.name}.png` });
      await undo.getByRole("button", { name: "Вернуть" }).click();
      await expect.poll(() => currentTime(page)).toBeLessThan(6);
      await expect(undo).toHaveCount(0);
      // Once undone it stays a button.
      const skip = page.getByTestId("skip-opening");
      await expect(skip).toHaveAttribute("data-kind", "recap");
      await expect(skip).toHaveText(/Пропустить пересказ/);
    });

    test("anime group → watch here (HLS) → skip opening → quality switch", async ({ page }) => {
      test.setTimeout(120_000);
      if (vp.engine === "hlsjs") {
        await page.addInitScript(() => {
          const orig = HTMLMediaElement.prototype.canPlayType;
          HTMLMediaElement.prototype.canPlayType = function (t: string) {
            return /mpegurl/i.test(t) ? "" : orig.call(this, t);
          };
        });
      }
      const { movie, profileId } = await setup(page);
      const log = await mockSources(page, movie.id);

      await page.goto(`/title/${movie.id}`);
      await page.getByTestId("play-more").click(); // «Где и как смотреть» menu
      await page.getByTestId("choose-release").click();
      const sheet = page.getByTestId("release-sheet");
      const group = sheet.getByTestId("online-group");
      await expect(group).toBeVisible();
      await expect(group).toContainText("Аниме");
      await expect(group).toContainText("AniLiberty");
      await expect(sheet.getByTestId("online-failed")).toContainText("AniMirror");
      const rows = sheet.getByTestId("online-row");
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0)).toHaveAttribute("data-preferred", "true");
      await expect(rows.nth(0)).toContainText("AniLibria");
      await expect(rows.nth(0)).toContainText("1080p · 720p · 480p");
      await expect(rows.nth(0)).toContainText(/hls/i);
      // Torrents keep their own rows, each with the source that found it.
      await expect(sheet.getByTestId("release-row")).toHaveCount(2);
      await expect(sheet.getByTestId("provider-chip")).toHaveText(["Prowlarr", "Jacred"]);
      await page.screenshot({ path: `${SHOTS}/web-releases-${vp.name}.png`, fullPage: false });

      // Watch here: the variant id is the release_id.
      await rows.nth(0).getByTestId("online-watch-here").click();
      await expect(page).toHaveURL(new RegExp(`/watch/${SOURCE_ID}`), { timeout: 15_000 });
      expect(log.created).toEqual([expect.objectContaining({ media_id: movie.id, release_id: "o-pref", profile_id: profileId })]);
      await expect(video(page)).toHaveAttribute("data-engine", vp.engine);
      await expect(page.getByTestId("player-loader")).toHaveCount(0, { timeout: 20_000 });
      await expect.poll(() => currentTime(page), { timeout: 15_000 }).toBeGreaterThan(1);
      expect(log.streams["tok-q1080"]).toBeGreaterThan(1); // playlist + segments through the proxy URL

      // Subtitles from source.subtitles are offered.
      await page.mouse.move(200, 300);
      await expect(page.getByTestId("player-subs")).toBeVisible();

      // «Пропустить опенинг» while inside the opening (1–9 s).
      const skip = page.getByTestId("skip-opening");
      await expect(skip).toBeVisible();
      await expect(skip).toHaveText(/Пропустить опенинг/);
      await page.screenshot({ path: `${SHOTS}/web-player-${vp.name}.png` });
      await skip.click();
      await expect.poll(() => currentTime(page)).toBeGreaterThanOrEqual(8.9);
      await expect(skip).toHaveCount(0);

      // Quality: pause, switch to 480p → PATCH, new stream URL, same position.
      await page.mouse.move(220, 320);
      await page.getByTestId("player-toggle").click();
      await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
      const at = await currentTime(page);
      await page.getByTestId("player-quality").click();
      const menu = page.getByTestId("player-menu-quality");
      await expect(menu.getByRole("menuitemradio")).toHaveText(["1080p", "720p", "480p"]);
      await menu.getByRole("menuitemradio", { name: "480p" }).click();
      await expect.poll(() => log.patched).toEqual([{ quality: 480 }]);
      await expect.poll(() => log.streams["tok-q480"] ?? 0, { timeout: 10_000 }).toBeGreaterThan(1);
      await expect.poll(() => currentTime(page), { timeout: 10_000 }).toBeGreaterThan(at - 0.6);
      expect(await currentTime(page)).toBeLessThan(at + 0.6);
      await expect(page.getByTestId("player-quality")).toContainText("480p");
    });

    /** Settings → Источники: Jacred off → saved as an explicit list → the release search reflects it. */
    test("settings: turning Jacred off changes the release search", async ({ page }) => {
      test.setTimeout(90_000);
      const { movie, profileId } = await setup(page);
      const log = await mockSources(page, movie.id);

      await page.goto("/settings");
      const rows = page.getByTestId("source-row");
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0)).toContainText("Prowlarr");
      await expect(rows.nth(2)).toContainText("Аниме");
      const jacred = page.getByTestId("source-switch-jacred");
      await expect(jacred).toHaveAttribute("aria-checked", "true");
      await page.getByTestId("settings-sources").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/web-settings-${vp.name}.png` });
      await jacred.click();
      await expect.poll(() => log.settingsPuts).toEqual([{ sources: { enabled: ["prowlarr", "anilibria"] } }]);
      await expect(jacred).toHaveAttribute("aria-checked", "false");

      // The release list now only has Prowlarr's results.
      await page.goto(`/title/${movie.id}`);
      await page.getByTestId("play-more").click(); // «Где и как смотреть» menu
      await page.getByTestId("choose-release").click();
      const sheet = page.getByTestId("release-sheet");
      await expect(sheet.getByTestId("release-row")).toHaveCount(1);
      await expect(sheet.getByTestId("provider-chip")).toHaveText(["Prowlarr"]);
      expect(log.releaseQueries.at(-1)?.get("profile_id")).toBe(profileId);

      // Back on: every source is on again → "all".
      await page.goto("/settings");
      await page.getByTestId("source-switch-jacred").click();
      await expect.poll(() => log.settingsPuts.at(-1)).toEqual({ sources: { enabled: "all" } });
    });
  });
}

/** Admin → Sources (real API): enable switch, base URL, key field, probe. */
test.describe("admin sources", () => {
  test.use({ viewport: { width: 1366, height: 900 }, locale: "en-US" });
  test("lists sources with health, probe and a write-only key", async ({ page }) => {
    await setup(page);
    // Writes are mocked so the real configuration is untouched; reads are real.
    const patches: Record<string, unknown>[] = [];
    await page.route(/\/api\/v1\/admin\/sources\/[^/]+$/, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      const body = route.request().postDataJSON() as Record<string, unknown>;
      patches.push(body);
      const cur = await (await page.context().request.get(route.request().url())).json();
      return json(route, { ...cur, ...(body.credentials ? { has_credentials: Object.keys(body.credentials).length > 0 } : {}) });
    });
    await page.goto("/admin?tab=sources");
    const cards = page.getByTestId("admin-source");
    await expect(cards.first()).toBeVisible();
    await expect(page.locator("[data-testid=admin-source][data-source-id=anilibria]")).toContainText("AniLiberty");
    const jacred = page.locator("[data-source-id=jacred]").locator("xpath=ancestor::section[1]");
    await jacred.getByTestId("admin-source-key").fill("secret-key");
    await jacred.getByRole("button", { name: "Сохранить" }).last().click();
    await expect.poll(() => patches).toEqual([{ credentials: { apikey: "secret-key" } }]);
    await expect(jacred.getByTestId("admin-source-key")).toHaveValue("");
    await expect(jacred.getByTestId("admin-source-key-state")).toHaveText("Ключ сохранён");
    // Probe runs the real health check.
    const anilibria = page.locator("[data-source-id=anilibria]").locator("xpath=ancestor::section[1]");
    await anilibria.getByTestId("admin-source-probe").click();
    await expect(anilibria.getByTestId("admin-source-probe-result")).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/web-admin-sources-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${SHOTS}/web-admin-sources-phone.png`, fullPage: true });
  });
});
