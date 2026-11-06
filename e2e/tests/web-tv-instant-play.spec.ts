import { expect, test, type Page, type Route } from "@playwright/test";
import { quietHome } from "./quietHome";

// «Смотреть на ТВ» is instant: the phone sends media.play right away (no
// release search, no source on the phone); the TV opens its loading screen at
// once and searches / prepares itself, showing peers / seeders / speed. The
// phone's toast follows the TV's device state. Releases and sources are mocked
// on the TV page (no real torrents are ever added).

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
const SOURCE_ID = "5e1ec7ed-0000-4000-8000-00000000beef";
const GB = 1024 ** 3;

const RELEASE = {
  id: "rel-1080",
  title: "Dune: Part Two (2024) BDRip 1080p",
  indexer: "Rutor",
  size_bytes: Math.round(14.2 * GB),
  seeders: 1203,
  leechers: 4,
  published_at: "2026-10-20T10:00:00Z",
  info_hash: null,
  resolution: "1080p",
  video_codec: "h264",
  hdr: null,
  audio_codecs: ["aac"],
  languages: ["ru", "en"],
  source_quality: "bdrip",
  release_group: null,
  year: 2024,
  seasons: [],
  episodes: [],
  is_season_pack: false,
  score: 1,
  confidence: 0.95,
  reasons: [],
  warnings: [],
};

function source(mediaId: string) {
  return {
    id: SOURCE_ID,
    media_id: mediaId,
    episode_id: null,
    release: RELEASE,
    // Stays preparing: the loading screen keeps showing the live numbers.
    status: "preparing",
    error: null,
    file: null,
    stream_url: null,
    stream_expires_at: null,
    mime_type: null,
    media_info: null,
    torrent: { peers: 14, seeders: 9, download_speed_bps: 2_500_000, preloaded_bytes: 12 * 1024 * 1024, total_peers: 80, preload_size: 32 * 1024 * 1024, stage: "preloading" },
    created_at: new Date().toISOString(),
  };
}

/** TV-side mocks; the release search answers only once `release()` is called. */
async function mockTv(tv: Page) {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const log = { searches: 0, created: [] as { media_id: string; release_id: string }[] };
  let mediaId = "";
  await tv.route(/\/api\/v1\/media\/[^/]+\/releases/, async (route: Route) => {
    log.searches++;
    mediaId = new URL(route.request().url()).pathname.split("/")[4]!;
    await gate;
    await route.fulfill({ json: { items: [RELEASE], searched_at: new Date().toISOString(), cached: false, indexer_errors: [] } });
  });
  await tv.route(/\/api\/v1\/playback\/sources(\/[^/?]+)?(\?.*)?$/, async (route: Route) => {
    const req = route.request();
    if (req.method() === "POST") {
      const body = req.postDataJSON() as { media_id: string; release_id: string };
      log.created.push(body);
      mediaId = body.media_id;
      return route.fulfill({ status: 201, json: source(mediaId) });
    }
    if (req.method() === "DELETE") return route.fulfill({ status: 204, body: "" });
    return route.fulfill({ json: source(mediaId) });
  });
  return { log, release: () => open() };
}

test("«На ТВ»: the TV opens its loading screen at once and shows peers / seeders / speed", async ({ browser }) => {
  test.setTimeout(180_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US" });
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
  await quietHome(tvCtx);
  const phone = await phoneCtx.newPage();
  const tv = await tvCtx.newPage();
  const tvMock = await mockTv(tv);
  // The phone must not search or prepare anything itself.
  const phoneLog = { searches: 0, created: 0 };
  await phone.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) => {
    phoneLog.searches++;
    return route.fulfill({ json: { items: [RELEASE], searched_at: new Date().toISOString(), cached: false, indexer_errors: [] } });
  });
  await phone.route(/\/api\/v1\/playback\/sources$/, (route) => {
    if (route.request().method() === "POST") phoneLog.created++;
    return route.fulfill({ status: 500, json: { error: { code: "unexpected", message: "phone must not create sources" } } });
  });

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

  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Instant TV ${Date.now()}`;
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
    const card = phone.getByTestId("poster-card").first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.click();
    await expect(phone).toHaveURL(/\/title\/[0-9a-f-]{36}/);

    // «Play on TV» (best release): the phone sends right away.
    await phone.getByTestId("play-on-tv").first().click();
    const tvPicker = phone.getByTestId("tv-picker");
    const playerPicker = phone.getByTestId("player-picker");
    const progress = phone.getByTestId("play-progress");
    await expect(tvPicker.or(playerPicker).or(progress)).toBeVisible({ timeout: 20_000 });
    if (await tvPicker.isVisible()) await tvPicker.getByRole("button", { name: new RegExp(deviceName) }).click();
    await expect(playerPicker.or(progress)).toBeVisible({ timeout: 20_000 });
    if (await playerPicker.isVisible()) await playerPicker.locator('[data-player="builtin"]').click();

    // The TV is on its loading screen while its release search is still pending.
    const loader = tv.getByTestId("player-preparing");
    await expect(loader).toBeVisible({ timeout: 10_000 });
    await expect(tv.getByTestId("loader-status").first()).toHaveText(/searching releases|getting ready/i);
    expect(tvMock.log.created).toEqual([]);
    await expect(progress).toHaveAttribute("data-step", "done", { timeout: 15_000 });
    await expect(progress).toHaveAttribute("data-outcome", "sent");
    await expect(progress).toHaveAttribute("data-tv", /searching|loading|opening/);

    // The search answers: the TV prepares the release itself and shows the torrent numbers.
    tvMock.release();
    await expect.poll(() => tvMock.log.created.length, { timeout: 20_000 }).toBe(1);
    expect(tvMock.log.created[0]).toMatchObject({ release_id: "rel-1080" });
    const stats = tv.getByTestId("loader-stats").first();
    await expect(stats).toContainText(/Peers: 14 of 80 · seeders: 9/, { timeout: 20_000 });
    await expect(stats).toContainText("↓");
    await expect(tv.getByTestId("loader-status").first()).toContainText(/Buffering 12/);

    // The phone follows: loading x% with the same numbers.
    await expect(progress).toHaveAttribute("data-tv", "loading", { timeout: 20_000 });
    await expect(progress.getByTestId("play-progress-stats")).toContainText(/Peers: 14 · seeders: 9/, { timeout: 20_000 });
    expect(phoneLog).toEqual({ searches: 0, created: 0 });
  } finally {
    await tv.keyboard.press("Escape").catch(() => undefined);
    await phone.goto("/devices");
    const card = phone.locator("section", { hasText: deviceName });
    phone.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: /unpair/i }).click();
    await expect(card).toHaveCount(0);
  }
});
