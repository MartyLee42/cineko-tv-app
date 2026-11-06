import { mkdirSync, readFileSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";

// «Смотреть онлайн» on the web title page: the no-torrent button appears
// only with non-anime online variants; the compact picker groups them by
// source (voice chips, quality, episodes) and plays here through the
// existing online source flow. /online, sources and the stream are mocked.

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
const HLS = (name: string) => readFileSync(new URL(`../fixtures/hls/${name}`, import.meta.url));
const SHOTS = "test-results/online-shots";
mkdirSync(SHOTS, { recursive: true });

const SOURCE_ID = "5e1ec7ed-0000-4000-8000-00000000c001";
const SESSION = "5e550000-0000-4000-8000-00000000c0c0";

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const CVH = { id: "cdnvideohub", name: "CDNVideoHub", kind: "online" };
const COLLAPS = { id: "collaps", name: "Collaps", kind: "online" };
const ANI = { id: "anilibria", name: "AniLiberty", kind: "anime" };

function variant(id: string, provider: typeof CVH, voice: string, o: Record<string, unknown> = {}) {
  return {
    id,
    provider,
    voice,
    voiceover: { kind: null, studio: voice, language: "ru" },
    title: null,
    max_quality: 1080,
    qualities: [1080, 720, 480],
    format: "mp4",
    subtitle_langs: [],
    season: null,
    episode: null,
    episodes: [],
    preferred: false,
    score: 0.5,
    ...o,
  };
}

const MOVIE_ITEMS = [
  variant("o-cvh-dub", CVH, "Дубляж", { preferred: true, score: 0.9, max_quality: 2160, qualities: [2160, 1440, 1080, 720, 480] }),
  variant("o-col-ntv", COLLAPS, "НТВ", { format: "hls", max_quality: 720, qualities: [720], subtitle_langs: ["ru", "en"], score: 0.7 }),
  variant("o-cvh-gavr", CVH, "Андрей Гаврилов", { score: 0.6 }),
  variant("o-col-dub", COLLAPS, "Дубляж", { format: "hls", max_quality: 720, qualities: [720], score: 0.55 }),
  variant("o-ani", ANI, "AniLibria", { format: "hls", score: 0.1 }),
];

interface Log {
  created: Record<string, unknown>[];
  onlineQueries: URLSearchParams[];
}

async function mockOnline(page: Page, mediaId: string, items: unknown[], nextUp: unknown = null): Promise<Log> {
  const log: Log = { created: [], onlineQueries: [] };
  await page.route(/\/api\/v1\/media\/[^/]+\/online/, (route) => {
    log.onlineQueries.push(new URL(route.request().url()).searchParams);
    return json(route, {
      items,
      providers: [
        { id: "cdnvideohub", name: "CDNVideoHub", kind: "online", status: "ok", count: 2, error: null, cached: false },
        { id: "collaps", name: "Collaps", kind: "online", status: "ok", count: 2, error: null, cached: false },
      ],
      searched_at: new Date().toISOString(),
      cached: false,
    });
  });
  await page.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) =>
    json(route, { items: [], searched_at: new Date().toISOString(), cached: false, indexer_errors: [] }),
  );
  const source = () => ({
    id: SOURCE_ID,
    media_id: mediaId,
    episode_id: null,
    release: {
      id: "o-cvh-dub", provider: CVH, title: "CDNVideoHub", indexer: "CDNVideoHub", size_bytes: 0, seeders: 0, leechers: null,
      published_at: null, info_hash: null, resolution: "720p", video_codec: null, hdr: null, audio_codecs: [], languages: ["ru"],
      voiceovers: [{ kind: "dub", studio: "Дубляж", language: "ru" }], release_group: null, source_quality: null, year: null,
      seasons: [], episodes: [], is_season_pack: false, confidence: 1, score: 1, reasons: [], warnings: [],
    },
    status: "ready",
    error: null,
    file: null,
    stream_url: "/api/v1/stream/tok-online/index.m3u8",
    stream_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    mime_type: "application/vnd.apple.mpegurl",
    media_info: null,
    torrent: null,
    created_at: new Date().toISOString(),
    kind: "online",
    provider: CVH,
    format: "hls",
    quality: 720,
    qualities: [2160, 1440, 1080, 720, 480],
    subtitles: [],
    duration_seconds: 16,
  });
  await page.route(/\/api\/v1\/playback\/sources(\/[^/?]+)?(\?.*)?$/, (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      log.created.push(req.postDataJSON() as Record<string, unknown>);
      return json(route, source(), 201);
    }
    return json(route, source());
  });
  await page.route(/\/api\/v1\/stream\//, (route) => {
    const file = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const type = file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4";
    return route.fulfill({ status: 200, headers: { "Content-Type": type }, body: HLS(file) });
  });
  await page.route(/\/api\/v1\/playback\/sessions(\?.*)?$/, (route) => json(route, { id: SESSION, resume_position_seconds: null, progress: null, report_token: "t" }, 201));
  await page.route(/\/api\/v1\/playback\/sessions\/[^/]+\/progress/, (route) => json(route, { accepted: true, progress: null }));
  await page.route(new RegExp(`/api/v1/media/${mediaId}/progress`), (route) =>
    json(route, { media_id: mediaId, kind: nextUp ? "series" : "movie", movie: null, episodes: [], seasons: [], next_up: nextUp }),
  );
  await page.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, (route) => json(route, { items: [] }));
  return log;
}

async function setup(page: Page, query: string, kind: "movie" | "series") {
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
  await page.evaluate(() => localStorage.setItem("martytv.locale", "ru"));
  const search = await (await req.get(`/api/v1/catalog/search?q=${encodeURIComponent(query)}&kind=${kind}`)).json();
  const media = search.items[0] as { id: string; title: string };
  expect(media).toBeTruthy();
  return { media, profileId: profiles[0].id as string };
}

const video = (page: Page) => page.getByTestId("video");

test.describe("watch online (web)", () => {
  test.use({ viewport: { width: 390, height: 844 }, locale: "en-US" });

  test("movie: button → picker grouped by source → quality → play here", async ({ page }) => {
    test.setTimeout(120_000);
    const { media, profileId } = await setup(page, "The Matrix", "movie");
    const log = await mockOnline(page, media.id, MOVIE_ITEMS);

    await page.goto(`/title/${media.id}`);
    const btn = page.getByTestId("watch-online");
    await expect(btn).toBeVisible();
    await expect(btn).toHaveText(/Смотреть онлайн/);
    expect(log.onlineQueries[0]?.get("profile_id")).toBe(profileId);
    expect(log.onlineQueries[0]?.has("season")).toBe(false);
    await btn.click();

    const picker = page.getByTestId("online-picker");
    await expect(picker).toBeVisible();
    const sources = picker.getByTestId("online-source");
    await expect(sources).toHaveCount(2); // no anime here
    await expect(sources.nth(0)).toHaveAttribute("data-source-id", "cdnvideohub");
    await expect(sources.nth(1)).toHaveAttribute("data-source-id", "collaps");
    await expect(sources.nth(0).getByTestId("online-voice-chip")).toHaveText([/Дубляж/, /Андрей Гаврилов/]);
    await expect(sources.nth(1).getByTestId("online-voice-chip")).toHaveText([/НТВ/, /Дубляж/]);
    // The preferred voice is preselected.
    const dub = sources.nth(0).getByTestId("online-voice-chip").nth(0);
    await expect(dub).toHaveAttribute("data-preferred", "true");
    await expect(dub).toHaveAttribute("aria-checked", "true");
    await expect(picker.getByTestId("online-quality")).toHaveText(["Авто", "2160p", "1440p", "1080p", "720p", "480p"]);

    // Collaps (one HLS quality): no quality row, subtitles listed.
    await sources.nth(1).getByTestId("online-voice-chip").nth(0).click();
    await expect(picker.getByTestId("online-quality")).toHaveCount(0);
    await expect(picker.getByTestId("online-selected")).toContainText("ru, en");
    await page.screenshot({ path: `${SHOTS}/web-online-picker-phone.png` });

    // Back to CDNVideoHub · Дубляж, 720p, play here.
    await dub.click();
    await picker.getByTestId("online-quality").filter({ hasText: "720p" }).click();
    await picker.getByTestId("online-play-here").click();
    await expect(page).toHaveURL(new RegExp(`/watch/${SOURCE_ID}`), { timeout: 15_000 });
    expect(log.created).toEqual([{ media_id: media.id, release_id: "o-cvh-dub", profile_id: profileId, quality: 720 }]);
    await expect(page.getByTestId("player-loader")).toHaveCount(0, { timeout: 20_000 });
    await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 }).toBeGreaterThan(1);
  });

  test("movie: the release sheet lists the «Онлайн» group too", async ({ page }) => {
    const { media } = await setup(page, "The Matrix", "movie");
    await mockOnline(page, media.id, MOVIE_ITEMS);
    await page.goto(`/title/${media.id}`);
    await page.getByTestId("choose-release").click();
    const sheet = page.getByTestId("release-sheet");
    const online = sheet.locator("[data-testid=online-group][data-kind=online]");
    await expect(online).toContainText("Онлайн");
    await expect(online).toContainText("CDNVideoHub, Collaps");
    await expect(online.getByTestId("online-row")).toHaveCount(4);
    await expect(sheet.locator("[data-testid=online-group][data-kind=anime]").getByTestId("online-row")).toHaveCount(1);
  });

  for (const c of [
    { name: "only anime", items: [variant("o-ani", ANI, "AniLibria", { format: "hls" })] },
    { name: "nothing", items: [] },
  ]) {
    test(`no button with ${c.name}`, async ({ page }) => {
      const { media } = await setup(page, "The Matrix", "movie");
      await mockOnline(page, media.id, c.items);
      const answered = page.waitForResponse(/\/api\/v1\/media\/[^/]+\/online/);
      await page.goto(`/title/${media.id}`);
      await answered;
      await expect(page.getByTestId("play-on-tv")).toBeVisible();
      await expect(page.getByTestId("watch-online")).toHaveCount(0);
    });
  }

  test("series: season lookup, next-up episode preselected, play here with the episode", async ({ page }) => {
    test.setTimeout(120_000);
    const { media, profileId } = await setup(page, "Breaking Bad", "series");
    const season = await (await page.context().request.get(`/api/v1/media/${media.id}/seasons/1?lang=ru`)).json();
    const eps = season.episodes as { id: string; episode_number: number; name: string }[];
    const ep2 = eps.find((e) => e.episode_number === 2)!;
    const nextUp = { episode_id: ep2.id, season_number: 1, episode_number: 2, name: ep2.name, still_path: null, air_date: null, runtime: null, position_seconds: 0, overview: null };
    const items = [
      variant("o-s-cvh", CVH, "LostFilm", { preferred: true, season: 1, episodes: [1, 2, 3] }),
      variant("o-s-col", COLLAPS, "Кубик в кубе", { format: "hls", qualities: [720], max_quality: 720, season: 1, episodes: [1, 3] }),
    ];
    const log = await mockOnline(page, media.id, items, nextUp);

    await page.goto(`/title/${media.id}`);
    await page.getByTestId("watch-online").click();
    expect(log.onlineQueries.at(-1)?.get("season")).toBe("1");
    const picker = page.getByTestId("online-picker");
    const select = picker.getByTestId("online-episode");
    await expect(select).toHaveValue("2");
    await expect(select.locator("option")).toHaveCount(3);
    // A voice without episode 2 falls back to its first episode.
    await picker.getByTestId("online-voice-chip").filter({ hasText: "Кубик в кубе" }).click();
    await expect(select).toHaveValue("1");
    await expect(select.locator("option")).toHaveCount(2);
    await picker.getByTestId("online-voice-chip").filter({ hasText: "LostFilm" }).click();
    await select.selectOption("3");
    await page.screenshot({ path: `${SHOTS}/web-online-series-phone.png` });
    await picker.getByTestId("online-play-here").click();
    await expect(page).toHaveURL(new RegExp(`/watch/${SOURCE_ID}`), { timeout: 15_000 });
    const ep3 = eps.find((e) => e.episode_number === 3)!;
    expect(log.created).toEqual([{ media_id: media.id, release_id: "o-s-cvh", episode_id: ep3.id, profile_id: profileId }]);
    // The player's controls: ⏮ the previous and ⏭ the next episode.
    await expect(page.getByTestId("player-prev-episode")).toHaveAttribute("aria-label", /S01E02/, { timeout: 15_000 });
    await expect(page.getByTestId("player-next-episode")).toHaveAttribute("aria-label", /S01E04/);
  });
});
