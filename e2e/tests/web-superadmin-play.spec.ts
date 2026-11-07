import { expect, test, type Page, type Route } from "@playwright/test";
import { quietHome } from "./quietHome";

// «Все устройства»: the super_admin (dev e2e-admin) plays on a TV paired to
// another user. One browser login (the super_admin); the owner never signs in.
const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

const SOURCE_ID = "5e1ec7ed-0000-4000-8000-0000005a91a7";
const GB = 1024 ** 3;

const RELEASE = {
  id: "rel-sap-1080",
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
  audio_codecs: ["ac3"],
  languages: ["ru", "en"],
  source_quality: "bdrip",
  release_group: null,
  year: 2024,
  seasons: [],
  episodes: [],
  is_season_pack: false,
  score: 1,
  confidence: 0.95,
  reasons: ["title_exact", "year_match"],
  warnings: [],
};

function source(mediaId: string, status: "preparing" | "ready") {
  return {
    id: SOURCE_ID,
    media_id: mediaId,
    episode_id: null,
    release: RELEASE,
    status,
    error: null,
    file: { index: 0, path: "Dune.Part.Two.2024.BDRip.1080p.mkv", size_bytes: RELEASE.size_bytes, is_video: true, season: null, episode: null },
    stream_url: status === "ready" ? "/api/v1/stream/e2e-not-a-real-token" : null,
    stream_expires_at: null,
    mime_type: "video/x-matroska",
    media_info: null,
    torrent: { peers: 14, seeders: 9, download_speed_bps: 2_500_000, preloaded_bytes: 0 },
    created_at: new Date().toISOString(),
  };
}

/** Releases + sources mocked (no Prowlarr / TorrServer in e2e). */
async function mockPlayback(page: Page) {
  let mediaId = "";
  let gets = 0;
  await page.route(/\/api\/v1\/media\/[^/]+\/releases/, async (route: Route) => {
    mediaId = new URL(route.request().url()).pathname.split("/")[4]!;
    await route.fulfill({ json: { items: [RELEASE], searched_at: new Date().toISOString(), cached: false, indexer_errors: [] } });
  });
  await page.route(/\/api\/v1\/playback\/sources(\/[^/?]+)?(\?.*)?$/, async (route: Route) => {
    if (route.request().method() === "POST") {
      mediaId = (route.request().postDataJSON() as { media_id: string }).media_id;
      return route.fulfill({ status: 201, json: source(mediaId, "preparing") });
    }
    gets++;
    return route.fulfill({ json: source(mediaId, gets > 1 ? "ready" : "preparing") });
  });
}

test("super admin plays on another user's TV via «All devices»", async ({ browser }) => {
  test.setTimeout(180_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US" });
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
  await quietHome(tvCtx);
  const phone = await phoneCtx.newPage();
  const tv = await tvCtx.newPage();
  await mockPlayback(phone);
  await mockPlayback(tv);
  const tvAskedForSource = tv
    .waitForRequest((r) => r.url().includes(`/playback/sources/${SOURCE_ID}`), { timeout: 60_000 })
    .then(() => true)
    .catch(() => false);

  await phone.goto("/login");
  await phone.getByLabel(/username/i).fill(USER);
  await phone.getByLabel(/password/i).fill(PASS);
  await phone.getByRole("button", { name: /sign in/i }).click();
  await expect(phone.getByRole("heading", { name: /welcome/i })).toBeVisible();
  const origin = new URL(phone.url()).origin;
  const session = await (await phoneCtx.request.get("/api/v1/auth/session")).json();
  expect(session.user.role, "e2e-admin must be super_admin (make e2e sets it)").toBe("super_admin");
  const headers = { "X-CSRF-Token": session.csrf_token as string, Origin: origin };

  // Another user owns the TV.
  const stamp = Date.now();
  const owner = `e2e-sapowner-${stamp}`;
  const created = await phoneCtx.request.post("/api/v1/admin/users", { data: { username: owner, password: "sap-owner-password-1", role: "user" }, headers });
  expect(created.ok()).toBeTruthy();
  const ownerId = (await created.json()).id as string;

  // A real TV page, paired to the owner (approved by the super_admin for them).
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  const reqs = (await (await phoneCtx.request.get("/api/v1/admin/pairing")).json()).items as { id: string; user_code: string }[];
  const pairing = reqs.find((r) => r.user_code === code)!;
  expect(pairing, "pairing request listed").toBeTruthy();
  const tvName = `E2E SA TV ${stamp}`;
  const approved = await phoneCtx.request.post(`/api/v1/admin/pairing/${pairing.id}/approve`, { data: { user_id: ownerId, device_name: tvName }, headers });
  expect(approved.ok()).toBeTruthy();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  let deviceId = "";
  try {
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await tv.keyboard.press("Enter");
    await expect(tv.getByText("Trending this week").first()).toBeVisible({ timeout: 30_000 });

    // Not in the super_admin's own list; in scope=all with its owner and via=admin.
    const mine = (await (await phoneCtx.request.get("/api/v1/devices")).json()).items as { name: string }[];
    expect(mine.some((d) => d.name === tvName)).toBe(false);
    const all = (await (await phoneCtx.request.get("/api/v1/devices?scope=all")).json()).items as {
      id: string; name: string; via?: string; access: string; owner?: { username: string };
    }[];
    const dev = all.find((d) => d.name === tvName)!;
    expect(dev).toMatchObject({ via: "admin", access: "control", owner: { username: owner } });
    deviceId = dev.id;

    // A movie page → «Play on TV» → picker → «All devices» → the owner's TV.
    await phone.goto(`/search?q=${encodeURIComponent("Dune Part Two")}`);
    const card = phone.getByTestId("poster-card").first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.click();
    await expect(phone).toHaveURL(/\/title\/[0-9a-f-]{36}/);
    const mediaId = phone.url().split("/title/")[1]!.split(/[?#]/)[0]!;

    await phone.getByTestId("play-on-tv").click();
    // It asks where: no own TV → «Другой телевизор…» opens the full picker.
    await phone.getByTestId("play-menu").getByTestId("play-other-tv").click();
    const sheet = phone.getByRole("dialog", { name: /choose a tv/i });
    await expect(sheet, "picker opens (e2e-admin has no single online TV of its own)").toBeVisible({ timeout: 20_000 });
    const toggle = sheet.getByTestId("all-devices-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(sheet.getByTestId("all-devices-list")).toHaveCount(0);
    await toggle.click();
    const list = sheet.getByTestId("all-devices-list");
    const group = list.locator("section", { hasText: owner });
    const item = group.locator(`[data-device-id="${deviceId}"]`);
    await expect(item).toContainText(tvName, { timeout: 15_000 });
    await item.getByRole("button").click();

    const playerPicker = phone.getByTestId("player-picker");
    const progress = phone.getByTestId("play-progress");
    await expect(playerPicker.or(progress)).toBeVisible({ timeout: 20_000 });
    if (await playerPicker.isVisible()) await playerPicker.locator('[data-player="builtin"]').click();
    await expect(progress).toHaveAttribute("data-step", "done", { timeout: 30_000 });
    expect(await progress.getAttribute("data-outcome"), "media.play ack").toBe("sent");

    // The TV opened the title: its player fetched our source; the state says so.
    expect(await tvAskedForSource, "TV fetched the mocked source").toBe(true);
    await expect
      .poll(async () => {
        const st = (await (await phoneCtx.request.get(`/api/v1/devices/${deviceId}/state`)).json()).state;
        return st?.playback?.media_id ?? st?.media_id ?? null;
      }, {
        timeout: 20_000,
      })
      .toBe(mediaId);

    // The remote for that TV works and stays live; the toggle is remembered.
    await phone.goto(`/remote/${deviceId}`);
    await expect(phone.getByTestId("remote-status")).toContainText(/online/i);
    await expect(phone.getByTestId("remote-screen")).toHaveText(/play/i, { timeout: 20_000 });
    await expect(phone.getByTestId("all-devices-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect(phone.locator(`[data-testid="all-device"][data-device-id="${deviceId}"] a`)).toHaveAttribute("aria-current", "page");
  } finally {
    await tvCtx.close();
    if (deviceId) await phoneCtx.request.delete(`/api/v1/admin/devices/${deviceId}`, { headers });
    await phoneCtx.request.patch(`/api/v1/admin/users/${ownerId}`, { data: { disabled: true }, headers });
    await phoneCtx.close();
  }
});
