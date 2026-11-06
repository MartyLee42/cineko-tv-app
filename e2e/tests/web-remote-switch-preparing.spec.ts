import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { quietHome } from "./quietHome";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

// Mocked releases / sources (never added to the real TorrServer): the TV keeps
// preparing the first one forever, so the second is sent mid-preparation.
const SRC = { "rel-1080": "5e1ec7ed-0000-4000-8000-0000000000a1", "rel-720": "5e1ec7ed-0000-4000-8000-0000000000b2" } as const;
type Rel = keyof typeof SRC;
const GB = 1024 ** 3;

const release = (o: Record<string, unknown>) => ({
  indexer: "RuTracker",
  leechers: 4,
  published_at: "2026-10-20T10:00:00Z",
  info_hash: null,
  hdr: null,
  release_group: null,
  year: 2024,
  seasons: [],
  episodes: [],
  is_season_pack: false,
  score: 1,
  reasons: ["title_exact"],
  warnings: [],
  voiceovers: [],
  source_quality: "web-dl",
  confidence: 0.95,
  languages: ["ru"],
  // AAC: the TV never swaps it for a «lighter» release (headless Chromium has no AC3).
  audio_codecs: ["aac"],
  ...o,
});
const RELEASES = [
  release({ id: "rel-1080", title: "Dune Part Two (2024) WEB-DL 1080p", size_bytes: Math.round(8 * GB), seeders: 300, resolution: "1080p", video_codec: "h264" }),
  release({ id: "rel-720", title: "Dune Part Two (2024) WEBRip 720p", size_bytes: Math.round(3 * GB), seeders: 120, resolution: "720p", video_codec: "h264" }),
];

function source(mediaId: string, rel: Rel) {
  return {
    id: SRC[rel],
    media_id: mediaId,
    episode_id: null,
    release: RELEASES.find((r) => r.id === rel),
    status: "preparing",
    error: null,
    file: null,
    stream_url: null,
    stream_expires_at: null,
    mime_type: null,
    media_info: null,
    torrent: { peers: 3, seeders: 2, download_speed_bps: 400_000, preloaded_bytes: 0 },
    created_at: new Date().toISOString(),
  };
}

interface Log {
  created: string[];
  fetched: Set<string>;
  cancelled: string[];
}

/** Releases + sources on one browser context; sources never become ready. */
async function mockPlayback(ctx: BrowserContext, log: Log, shared: { mediaId: string }) {

  await ctx.route(/\/api\/v1\/media\/[^/]+\/releases/, async (route: Route) => {
    shared.mediaId = new URL(route.request().url()).pathname.split("/")[4]!;
    await route.fulfill({ json: { items: RELEASES, searched_at: new Date().toISOString(), cached: false, indexer_errors: [] } });
  });
  await ctx.route(/\/api\/v1\/media\/[^/]+\/online/, (route) => route.fulfill({ json: { items: [], providers: [] } }));
  await ctx.route(/\/api\/v1\/playback\/sources(\/[^/?]+)?(\?.*)?$/, async (route: Route) => {
    const req = route.request();
    if (req.method() === "POST") {
      const body = req.postDataJSON() as { media_id: string; release_id: Rel };
      shared.mediaId = body.media_id;
      log.created.push(body.release_id);
      return route.fulfill({ status: 201, json: source(shared.mediaId, body.release_id) });
    }
    const id = new URL(req.url()).pathname.split("/").pop()!;
    const rel = (Object.keys(SRC) as Rel[]).find((k) => SRC[k] === id) ?? "rel-1080";
    if (req.method() === "DELETE") {
      log.cancelled.push(id);
      return route.fulfill({ status: 204, body: "" });
    }
    log.fetched.add(id);
    return route.fulfill({ json: source(shared.mediaId, rel) });
  });
  // Don't touch the profile's real watch state.
  const ok = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body });
  await ctx.route(/\/api\/v1\/playback\/sessions(\?.*)?$/, (route) => ok(route, { id: "5e550000-0000-4000-8000-00000000ffff", resume_position_seconds: null, progress: null, report_token: "x" }, 201));
  await ctx.route(/\/api\/v1\/playback\/sessions\/[^/]+\/progress/, (route) => ok(route, { accepted: true, progress: null }));
}

/** Opens the release sheet (the title's «Releases», or the toast's «Try another release») and sends `rel`. */
async function pickRelease(phone: Page, rel: Rel, deviceName: string, open = phone.getByTestId("choose-release")) {
  await open.click();
  const sheet = phone.getByTestId("release-sheet");
  await expect(sheet.getByTestId("release-row")).toHaveCount(2, { timeout: 20_000 });
  // Each row says how it fits that TV (its reported codecs / screen, mocked: a 720p H.264/AAC box).
  const fit = sheet.locator(`[data-release-id="${rel}"] [data-testid=fit-chips]`);
  await expect(fit).toHaveAttribute("data-verdict", "ok");
  await expect(fit.locator('[data-fit="plays"]')).toHaveText(`✓ Will play on ${deviceName}`);
  if (rel === "rel-1080") await expect(fit.locator('[data-fit="screen"]')).toHaveText("1080p: 720p screen");
  await sheet.locator(`[data-release-id="${rel}"] [data-testid=release-pick]`).click();
  const tvPicker = phone.getByTestId("tv-picker");
  const playerPicker = phone.getByTestId("player-picker");
  const progress = phone.getByTestId("play-progress");
  const busy = phone.getByTestId("busy-dialog");
  await expect(tvPicker.or(playerPicker).or(progress).or(busy)).toBeVisible({ timeout: 20_000 });
  if (await tvPicker.isVisible()) await tvPicker.getByRole("button", { name: new RegExp(deviceName) }).click();
  await expect(playerPicker.or(progress).or(busy)).toBeVisible({ timeout: 20_000 });
  if (await playerPicker.isVisible()) await playerPicker.locator('[data-player="builtin"]').click();
}

/**
 * The TV is still preparing release A (torrent loading screen); the phone
 * sends release B: no «прервать воспроизведение?» question (nothing plays
 * yet), the TV drops A (cancels its loading on the server) and prepares B.
 */
test("phone switches the release while the TV is still preparing", async ({ browser }) => {
  test.setTimeout(120_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US" });
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
  await quietHome(tvCtx);
  const phone = await phoneCtx.newPage();
  const tv = await tvCtx.newPage();
  const phoneLog: Log = { created: [], fetched: new Set(), cancelled: [] };
  const tvLog: Log = { created: [], fetched: new Set(), cancelled: [] };
  const shared = { mediaId: "" };
  await mockPlayback(phoneCtx, phoneLog, shared);
  // What the TV reported about itself (GET /devices/{id}/playback-prefs), as the phone sees it.
  await phoneCtx.route(/\/api\/v1\/devices\/[^/]+\/playback-prefs$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const body = res.ok() ? await res.json() : { manual: {}, effective: {}, constraints: [], updated_at: null };
    body.auto = { video: ["h264"], audio: ["aac"], containers: ["mkv", "mp4"], hls: true, compat: true, screen_width: 1280, screen_height: 720 };
    return route.fulfill({ json: body });
  });
  await mockPlayback(tvCtx, tvLog, shared);

  await phone.goto("/login");
  await phone.getByLabel(/username/i).fill(USER);
  await phone.getByLabel(/password/i).fill(PASS);
  await phone.getByRole("button", { name: /sign in/i }).click();
  await expect(phone.getByRole("heading", { name: /welcome/i })).toBeVisible();

  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Switch TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  try {
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await tv.keyboard.press("Enter");
    await expect(tv.getByText("Trending this week").first()).toBeVisible({ timeout: 30_000 });

    const devices = (await (await phoneCtx.request.get("/api/v1/devices")).json()).items as { id: string; name: string }[];
    const deviceId = devices.find((d) => d.name === deviceName)!.id;
    await phone.goto(`/remote/${deviceId}`);
    await expect(phone.getByTestId("remote-status")).toContainText(/online/i);

    await phone.goto(`/search?q=${encodeURIComponent("Dune Part Two")}`);
    await phone.getByTestId("poster-card").first().click();
    await expect(phone).toHaveURL(/\/title\/[0-9a-f-]{36}/);

    // A: sent, the TV prepares it (and keeps preparing: the mock never gets ready).
    await pickRelease(phone, "rel-1080", deviceName);
    const progress = phone.getByTestId("play-progress");
    await expect(progress).toHaveAttribute("data-step", "done", { timeout: 30_000 });
    await expect(progress).toHaveAttribute("data-outcome", "sent");
    await expect.poll(() => tvLog.fetched.has(SRC["rel-1080"]), { timeout: 20_000 }).toBe(true);
    const tvState = async () => (await (await phoneCtx.request.get(`/api/v1/devices/${deviceId}/state`)).json()).state;
    // The TV shows its loading screen for A (preparing: a playback without a picture yet).
    await expect.poll(async () => (await tvState())?.playback?.source_id, { timeout: 20_000 }).toBe(SRC["rel-1080"]);
    expect((await tvState()).screen).toBe("player");

    // B while A is still preparing («Другая раздача» in the toast): no busy question, sent right away.
    // The toast follows the TV's loading screen (A, no picture yet) and offers another release.
    await expect(progress.getByTestId("play-progress-line")).toHaveText(/loading on|opening on/i);
    await expect(progress).toHaveAttribute("data-tv", "loading", { timeout: 20_000 });
    // The TV's live torrent numbers reach the phone.
    await expect(progress.getByTestId("play-progress-stats")).toContainText("Peers: 3 · seeders: 2", { timeout: 20_000 });
    await expect(progress.getByTestId("play-another")).toBeVisible();
    await pickRelease(phone, "rel-720", deviceName, progress.getByTestId("play-another"));
    await expect(progress.or(phone.getByTestId("busy-dialog"))).toBeVisible();
    await expect(phone.getByTestId("busy-dialog")).toHaveCount(0);
    await expect(progress).toHaveAttribute("data-step", "done", { timeout: 30_000 });
    await expect(progress).toHaveAttribute("data-outcome", "sent");
    // The phone only sends release ids: the TV creates both sources itself.
    expect(phoneLog.created).toEqual([]);
    await expect.poll(() => tvLog.created, { timeout: 20_000 }).toEqual(["rel-1080", "rel-720"]);
    // The TV switched: prepares B, and told the server to stop loading A.
    await expect.poll(() => tvLog.fetched.has(SRC["rel-720"]), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => tvLog.cancelled, { timeout: 20_000 }).toContain(SRC["rel-1080"]);
    expect(tvLog.cancelled).not.toContain(SRC["rel-720"]);
    await expect
      .poll(async () => (await (await phoneCtx.request.get(`/api/v1/devices/${deviceId}/state`)).json()).state?.playback?.source_id, { timeout: 20_000 })
      .toBe(SRC["rel-720"]);
  } finally {
    await phone.goto("/devices");
    const card = phone.locator("section", { hasText: deviceName });
    phone.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: /unpair/i }).click();
    await expect(card).toHaveCount(0);
  }
});
