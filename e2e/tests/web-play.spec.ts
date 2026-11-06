import { expect, test, type Page, type Route } from "@playwright/test";
import { quietHome } from "./quietHome";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

const SOURCE_ID = "5e1ec7ed-0000-4000-8000-00000000c0de";
const GB = 1024 ** 3;

// Realistic Prowlarr results (normalized by the releases API), mocked on the phone.
const release = (o: Record<string, unknown>) => ({
  indexer: "RuTracker",
  leechers: 4,
  published_at: "2026-10-20T10:00:00Z",
  info_hash: null,
  hdr: null,
  audio_codecs: ["ac3"],
  release_group: null,
  year: 2024,
  seasons: [],
  episodes: [],
  is_season_pack: false,
  score: 1,
  reasons: ["title_exact", "year_match"],
  warnings: [],
  ...o,
});
const RELEASES = [
  release({
    id: "rel-2160",
    title: "Дюна: Часть вторая / Dune: Part Two (2024) WEB-DL 2160p | 4K | HDR10 | Dolby Vision | D, P, A | Лицензия + Original Eng",
    size_bytes: Math.round(31.6 * GB),
    seeders: 412,
    leechers: 37,
    resolution: "2160p",
    video_codec: "hevc",
    hdr: "dolby_vision",
    audio_codecs: ["eac3", "ac3"],
    languages: ["ru", "en"],
    source_quality: "web-dl",
    confidence: 0.97,
  }),
  release({
    id: "rel-1080",
    title: "Дюна: Часть вторая / Dune: Part Two (2024) BDRip 1080p от селезень | D | Лицензия",
    size_bytes: Math.round(14.2 * GB),
    seeders: 1203,
    resolution: "1080p",
    video_codec: "h264",
    audio_codecs: ["ac3", "dts"],
    languages: ["ru", "en"],
    source_quality: "bdrip",
    confidence: 0.95,
    indexer: "Rutor",
  }),
  release({
    id: "rel-720",
    title: "Дюна 2 (2024) WEBRip 720p | Дубляж",
    size_bytes: Math.round(3.1 * GB),
    seeders: 2,
    leechers: null,
    resolution: "720p",
    video_codec: "h264",
    audio_codecs: ["aac"],
    languages: ["ru"],
    source_quality: "webrip",
    confidence: 0.72,
    warnings: ["low_seeders"],
    indexer: "NNM-Club",
  }),
];

function source(mediaId: string, releaseId: string, status: "preparing" | "ready") {
  return {
    id: SOURCE_ID,
    media_id: mediaId,
    episode_id: null,
    release: RELEASES.find((r) => r.id === releaseId) ?? RELEASES[1],
    status,
    error: null,
    file: { index: 0, path: "Dune.Part.Two.2024.BDRip.1080p.mkv", size_bytes: Math.round(14.2 * GB), is_video: true, season: null, episode: null },
    stream_url: status === "ready" ? "/api/v1/stream/e2e-not-a-real-token" : null,
    stream_expires_at: null,
    mime_type: "video/x-matroska",
    media_info: null,
    torrent: { peers: 14, seeders: 9, download_speed_bps: 2_500_000, preloaded_bytes: 0 },
    created_at: new Date().toISOString(),
  };
}

/** Mocks the releases + sources endpoints on a page; records what was asked. */
async function mockPlayback(page: Page, log: { releaseQueries: URLSearchParams[]; created: unknown[]; sourceGets: number }) {
  let mediaId = "";
  let releaseId = "rel-1080";
  await page.route(/\/api\/v1\/media\/[^/]+\/releases/, async (route: Route) => {
    const u = new URL(route.request().url());
    mediaId = u.pathname.split("/")[4]!;
    log.releaseQueries.push(u.searchParams);
    await route.fulfill({
      json: {
        items: RELEASES,
        searched_at: new Date().toISOString(),
        cached: false,
        indexer_errors: [{ indexer: "Kinozal", message: "timeout" }],
      },
    });
  });
  await page.route(/\/api\/v1\/playback\/sources(\/[^/?]+)?(\?.*)?$/, async (route: Route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { media_id: string; release_id: string };
      log.created.push(body);
      mediaId = body.media_id;
      releaseId = body.release_id;
      return route.fulfill({ status: 201, json: source(mediaId, releaseId, "preparing") });
    }
    log.sourceGets++;
    return route.fulfill({ json: source(mediaId, releaseId, log.sourceGets > 1 ? "ready" : "preparing") });
  });
}

/**
 * Phase 4 acceptance (phone side): choose a release on the phone, send it to
 * a paired TV: media.play carries the release id and the TV prepares that
 * release itself (the phone creates no source); the remote shows it.
 */
test("choose a release on the phone and play it on the TV", async ({ browser }) => {
  test.setTimeout(180_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US" });
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
  await quietHome(tvCtx);
  const phone = await phoneCtx.newPage();
  const tv = await tvCtx.newPage();

  const phoneLog = { releaseQueries: [] as URLSearchParams[], created: [] as unknown[], sourceGets: 0 };
  await mockPlayback(phone, phoneLog);
  // The TV player fetches the source by id: mock it there too, and record that it asked.
  const tvLog = { releaseQueries: [] as URLSearchParams[], created: [] as unknown[], sourceGets: 0 };
  await mockPlayback(tv, tvLog);
  const tvAskedForSource = tv
    .waitForRequest((r) => r.url().includes(`/playback/sources/${SOURCE_ID}`), { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);

  await phone.goto("/login");
  await phone.getByLabel(/username/i).fill(USER);
  await phone.getByLabel(/password/i).fill(PASS);
  await phone.getByRole("button", { name: /sign in/i }).click();
  await expect(phone.getByRole("heading", { name: /welcome/i })).toBeVisible();

  const origin = new URL(phone.url()).origin;
  const session = await (await phoneCtx.request.get("/api/v1/auth/session")).json();
  const profiles = await (await phoneCtx.request.get("/api/v1/profiles")).json();
  if (profiles.items.length === 0) {
    const r = await phoneCtx.request.post("/api/v1/profiles", {
      data: { name: "E2E", color: "#6366f1" },
      headers: { "X-CSRF-Token": session.csrf_token, Origin: origin },
    });
    expect(r.ok()).toBeTruthy();
  }

  // Pair the TV.
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Play TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  try {
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await tv.keyboard.press("Enter");
    await expect(tv.getByText("Trending this week").first()).toBeVisible({ timeout: 30_000 });

    const devices = (await (await phoneCtx.request.get("/api/v1/devices")).json()).items as { id: string; name: string }[];
    const deviceId = devices.find((d) => d.name === deviceName)!.id;
    const tvState = (await (await phoneCtx.request.get(`/api/v1/devices/${deviceId}/state`)).json()).state as {
      profile_id: string | null;
    } | null;

    // Make this TV the default target (ranking + auto choice), then open a movie.
    await phone.goto(`/remote/${deviceId}`);
    await expect(phone.getByTestId("remote-status")).toContainText(/online/i);
    await phone.goto(`/search?q=${encodeURIComponent("Dune Part Two")}`);
    const card = phone.getByTestId("poster-card").first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.click();
    await expect(phone).toHaveURL(/\/title\/[0-9a-f-]{36}/);
    const mediaId = phone.url().split("/title/")[1]!.split(/[?#]/)[0]!;

    // The release list: rows with normalized badges, best match first.
    await phone.getByTestId("choose-release").click();
    const sheet = phone.getByTestId("release-sheet");
    await expect(sheet.getByTestId("release-row")).toHaveCount(3, { timeout: 20_000 });
    const best = sheet.locator('[data-release-id="rel-2160"]');
    await expect(best).toHaveAttribute("data-best", "true");
    await expect(best).toContainText("4K");
    await expect(best).toContainText("Dolby Vision");
    await expect(best).toContainText("WEB-DL");
    await expect(best).toContainText("31.6 GB");
    await expect(best).toContainText("Match 97%");
    await expect(sheet.locator('[data-release-id="rel-720"]')).toContainText("Few seeders");
    await expect(sheet.getByTestId("indexer-errors")).toContainText("Kinozal");
    await expect(sheet.locator('[data-release-id="rel-1080"] [data-testid=release-title]')).toContainText("от селезень");
    // Ranked for the TV's active profile.
    if (tvState?.profile_id) expect(phoneLog.releaseQueries.at(-1)?.get("profile_id")).toBe(tvState.profile_id);

    // Quick filter: 720p only.
    await sheet.getByRole("button", { name: "720p", exact: true }).click();
    await expect(sheet.getByTestId("release-row")).toHaveCount(1);
    await sheet.getByRole("button", { name: "All", exact: true }).first().click();
    await expect(sheet.getByTestId("release-row")).toHaveCount(3);

    // Pick the 1080p release → (TV picker if several TVs) → (player choice if asked) → media.play.
    await sheet.locator('[data-release-id="rel-1080"] [data-testid=release-pick]').click();
    const tvPicker = phone.getByTestId("tv-picker");
    const playerPicker = phone.getByTestId("player-picker");
    const progress = phone.getByTestId("play-progress");
    await expect(tvPicker.or(playerPicker).or(progress)).toBeVisible({ timeout: 20_000 });
    if (await tvPicker.isVisible()) await tvPicker.getByRole("button", { name: new RegExp(deviceName) }).click();
    await expect(playerPicker.or(progress)).toBeVisible({ timeout: 20_000 });
    if (await playerPicker.isVisible()) await playerPicker.locator('[data-player="builtin"]').click();

    await expect(progress).toHaveAttribute("data-step", "done", { timeout: 30_000 });
    // The phone only sends ids: the TV creates the source for the chosen release.
    expect(phoneLog.created).toEqual([]);
    const outcome = await progress.getAttribute("data-outcome");
    expect(outcome, "media.play ack").toMatch(/^(sent|unsupported)$/);
    if (outcome === "unsupported") {
      test.info().annotations.push({ type: "note", description: "TV acked media.play as unsupported (TV player not merged)." });
    } else {
      // The TV prepared exactly the chosen release, then follows that source.
      await expect.poll(() => tvLog.created.length, { timeout: 20_000 }).toBeGreaterThan(0);
      expect(tvLog.created[0]).toEqual(expect.objectContaining({ media_id: mediaId, release_id: "rel-1080" }));
      expect(await tvAskedForSource, "TV fetched the mocked source").toBe(true);

      // The remote shows what the TV is doing (player screen / now playing).
      await progress.getByTestId("play-remote-link").click();
      await expect(phone).toHaveURL(new RegExp(`/remote/${deviceId}`));
      await expect(phone.getByTestId("remote-screen")).toHaveText(/playing/i, { timeout: 20_000 });
      await expect(phone.getByTestId("now-on-tv")).toHaveAttribute("data-media-id", mediaId, { timeout: 20_000 });
    }
  } finally {
    await phone.goto("/devices");
    const card = phone.locator("section", { hasText: deviceName });
    phone.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: /unpair/i }).click();
    await expect(card).toHaveCount(0);
  }
});
