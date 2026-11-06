// Per-device playback profiles on the PWA: Settings → «This device» (this
// browser's record), the per-TV «Playback settings» sheet on the Devices page,
// and the release list ranked for that TV. The playback-prefs API is mocked
// (page.route), so this runs against a dev API with or without it.
import { expect, test, type Page, type Route } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
const GB = 1024 ** 3;
const DEV = "de7fde7f-0000-4000-8000-00000000d001";

test.use({ viewport: { width: 390, height: 844 }, locale: "en-US" });

type Manual = Record<string, unknown>;
type Auto = Record<string, unknown>;

function prefs(auto: Auto, manual: Manual) {
  const constraints = manual.max_resolution && manual.max_resolution !== "2160p" ? [{ code: "max_resolution", value: manual.max_resolution }] : [];
  return {
    auto,
    manual,
    effective: {
      max_resolution: manual.max_resolution ?? null,
      max_bitrate_bps: null,
      max_size_gb: null,
      video_codec: null,
      avoid_hdr: false,
      audio: null,
      prefer_smaller: false,
      video: null,
      audio_codecs: null,
      compat: false,
      default_player: null,
    },
    constraints,
    updated_at: new Date().toISOString(),
  };
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(USER);
  await page.getByLabel(/password/i).fill(PASS);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
}

/** /me/playback-clients mock: one record per client id, PATCH replaces the given parts. */
async function mockClients(page: Page) {
  const store = new Map<string, { auto: Auto; manual: Manual; name: string; platform: string }>();
  const patches: { id: string; body: Record<string, unknown> }[] = [];
  const out = (id: string) => {
    const r = store.get(id)!;
    return { client_id: id, name: r.name, platform: r.platform, ...prefs(r.auto, r.manual) };
  };
  await page.route(/\/api\/v1\/me\/playback-clients(\/[^/?]+)?(\?.*)?$/, async (route: Route) => {
    const req = route.request();
    const id = new URL(req.url()).pathname.split("/playback-clients/")[1];
    if (!id) return route.fulfill({ json: { items: [...store.keys()].map(out) } });
    if (req.method() === "PATCH") {
      const body = req.postDataJSON() as Record<string, unknown>;
      patches.push({ id, body });
      const cur = store.get(id) ?? { auto: {}, manual: {}, name: "", platform: "" };
      store.set(id, {
        auto: (body.auto as Auto) ?? cur.auto,
        manual: (body.manual as Manual) ?? cur.manual,
        name: (body.name as string) ?? cur.name,
        platform: (body.platform as string) ?? cur.platform,
      });
      return route.fulfill({ json: out(id) });
    }
    if (req.method() === "DELETE") {
      store.delete(id);
      return route.fulfill({ status: 204 });
    }
    return store.has(id) ? route.fulfill({ json: out(id) }) : route.fulfill({ status: 404, json: { error: { code: "not_found", message: "not found" } } });
  });
  return { store, patches };
}

test("this browser: reports itself, suggests a preset, saves manual values", async ({ page }) => {
  // A small screen without HEVC looks weak: the first-run suggestion appears.
  await page.addInitScript(() => {
    if (sessionStorage.getItem("devprefs-e2e")) return;
    sessionStorage.setItem("devprefs-e2e", "1");
    localStorage.removeItem("martytv.devprefs.suggest_dismissed");
    for (const k of Object.keys(localStorage)) if (k.startsWith("martytv.client_sync.")) localStorage.removeItem(k);
  });
  const log = await mockClients(page);
  await login(page);

  // Auto report on app start: probe results, model, stable client id.
  await expect.poll(() => log.patches.filter((p) => p.body.auto).length).toBeGreaterThan(0);
  const first = log.patches.find((p) => p.body.auto)!;
  const clientId = await page.evaluate(() => localStorage.getItem("martytv.client_id"));
  expect(first.id).toBe(clientId);
  expect(clientId).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  const auto = first.body.auto as Auto;
  expect(auto.video).toContain("h264");
  expect(auto.screen_width).toBeGreaterThan(0);
  expect(auto.model).toMatch(/Chrome \d+/);
  expect(first.body.manual).toBeUndefined();

  // The suggestion is inline in Settings → «Это устройство» (never an overlay).
  await page.goto("/settings");
  const suggest = page.getByTestId("devprefs-suggest");
  await expect(suggest).toBeVisible();
  await suggest.getByTestId("devprefs-suggest-later").click();
  await expect(suggest).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("martytv.devprefs.suggest_dismissed"))).toBe("1");

  await page.reload();
  const card = page.getByTestId("this-device-prefs");
  await expect(card.getByTestId("prefs-detected")).toContainText(/Chrome/);
  await expect(page.getByTestId("devprefs-suggest")).toBeHidden();
  // No default-player row for a browser.
  await expect(card.getByTestId("prefs-row-default_player")).toHaveCount(0);

  // A manual row.
  let patch = page.waitForRequest((r) => r.url().includes(`/playback-clients/${clientId}`) && r.method() === "PATCH");
  await card.getByTestId("prefs-row-max_resolution").selectOption("720p");
  expect((await patch).postDataJSON()).toEqual({ manual: { max_resolution: "720p" } });
  await expect(card.getByTestId("prefs-saved")).toContainText(/saved/i);
  await expect(card.getByTestId("prefs-applied")).toContainText(/up to 720p/i);

  // A preset, then a tweak on top.
  patch = page.waitForRequest((r) => r.url().includes(`/playback-clients/${clientId}`) && r.method() === "PATCH");
  await card.locator('[data-preset="normal"]').click();
  expect((await patch).postDataJSON().manual).toMatchObject({ preset: "normal", max_resolution: "1080p", max_bitrate_mbps: 15 });
  await expect(card.locator('[data-preset="normal"]')).toHaveAttribute("aria-pressed", "true");
  patch = page.waitForRequest((r) => r.url().includes(`/playback-clients/${clientId}`) && r.method() === "PATCH");
  await card.getByTestId("prefs-row-max_bitrate_mbps").selectOption("25");
  expect((await patch).postDataJSON().manual).toMatchObject({ preset: "normal", max_bitrate_mbps: 25 });
  patch = page.waitForRequest((r) => r.url().includes(`/playback-clients/${clientId}`) && r.method() === "PATCH");
  await card.getByTestId("prefs-row-prefer_smaller").click();
  expect((await patch).postDataJSON().manual).toMatchObject({ prefer_smaller: true });

  // Persisted (server record) after a reload.
  await page.reload();
  await expect(page.getByTestId("this-device-prefs").getByTestId("prefs-row-max_bitrate_mbps")).toHaveValue("25");

  // Reset to automatic.
  patch = page.waitForRequest((r) => r.url().includes(`/playback-clients/${clientId}`) && r.method() === "PATCH");
  await page.getByTestId("this-device-prefs").getByTestId("prefs-reset").click();
  expect((await patch).postDataJSON()).toEqual({ manual: {} });
  await expect(page.getByTestId("this-device-prefs").getByTestId("prefs-row-max_resolution")).toHaveValue("auto");
});

const release = (id: string, resolution: string, size: number) => ({
  id,
  title: `Inception (2010) BDRip ${resolution}`,
  indexer: "RuTracker",
  size_bytes: Math.round(size * GB),
  seeders: 100,
  leechers: 3,
  published_at: "2026-10-20T10:00:00Z",
  info_hash: null,
  resolution,
  video_codec: "h264",
  hdr: null,
  audio_codecs: ["ac3"],
  languages: ["ru"],
  voiceovers: [],
  release_group: null,
  source_quality: "bdrip",
  year: 2010,
  seasons: [],
  episodes: [],
  is_season_pack: false,
  confidence: 0.95,
  score: 1,
  reasons: ["title_exact"],
  warnings: [] as string[],
  est_bitrate_bps: (size * GB * 8) / 8880,
});

test("phone: a TV's max resolution changes the release order for that TV", async ({ page }) => {
  test.setTimeout(90_000);
  await mockClients(page);
  await page.addInitScript(() => {
    localStorage.setItem("martytv.release_mode", "tv");
    localStorage.setItem("martytv.devprefs.suggest_dismissed", "1");
  });
  await login(page);
  const req = page.context().request;
  const search = await (await req.get("/api/v1/catalog/search?q=Inception&kind=movie")).json();
  const movie = search.items[0] as { id: string };
  expect(movie).toBeTruthy();

  // One owned TV (mocked), online.
  const tvState = { manual: {} as Manual };
  const tvAuto = { model: "Living room box · Android 11", screen_width: 1920, screen_height: 1080, video: ["h264", "hevc"], audio: ["aac", "ac3"], compat: true };
  const device = {
    id: DEV,
    owner_user_id: "00000000-0000-4000-8000-000000000001",
    owner_username: USER,
    name: "Living Room TV",
    platform: "android",
    default_profile_id: null,
    created_at: "2026-10-01T10:00:00Z",
    last_seen_at: new Date().toISOString(),
    access: "owner",
    online: true,
  };
  await page.route(/\/api\/v1\/devices(\?.*)?$/, (route) => route.fulfill({ json: { items: [device] } }));
  await page.route(new RegExp(`/api/v1/devices/${DEV}/state`), (route) => route.fulfill({ json: { online: true, state: null } }));
  await page.route(new RegExp(`/api/v1/devices/${DEV}/permissions`), (route) => route.fulfill({ json: { items: [] } }));
  const prefPatches: Manual[] = [];
  await page.route(new RegExp(`/api/v1/devices/${DEV}/playback-prefs`), async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { manual?: Manual; auto?: Auto };
      expect(body.auto).toBeUndefined();
      tvState.manual = body.manual ?? tvState.manual;
      prefPatches.push(tvState.manual);
    }
    return route.fulfill({ json: prefs(tvAuto, tvState.manual) });
  });

  // Releases: the 720p one ranks first when this TV is limited to 720p (and «Show all» is off).
  const queries: URLSearchParams[] = [];
  await page.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) => {
    const q = new URL(route.request().url()).searchParams;
    queries.push(q);
    const forTv = q.get("device_id") === DEV && q.get("device_prefs") !== "off";
    const limited = forTv && tvState.manual.max_resolution === "720p";
    const hi = release("rel-1080", "1080p", 14.2);
    const lo = release("rel-720", "720p", 3.1);
    if (limited) hi.warnings = ["over_device_resolution"];
    return route.fulfill({
      json: {
        items: limited ? [lo, hi] : [hi, lo],
        searched_at: new Date().toISOString(),
        cached: true,
        indexer_errors: [],
        device: forTv && limited ? { kind: "device", id: DEV, name: device.name, constraints: [{ code: "max_resolution", value: "720p" }] } : null,
      },
    });
  });

  const rows = page.getByTestId("release-sheet").getByTestId("release-row");
  const openReleases = async () => {
    await page.goto(`/title/${movie.id}`);
    await page.getByTestId("choose-release").click();
    await expect(rows).toHaveCount(2, { timeout: 20_000 });
  };

  // Before: 1080p first, ranked for the TV.
  await openReleases();
  await expect(rows.first()).toHaveAttribute("data-release-id", "rel-1080");
  expect(queries.at(-1)!.get("device_id")).toBe(DEV);
  await expect(page.getByTestId("device-fit")).toHaveCount(0);

  // The TV's sheet on the Devices page: detected summary, default player row, 720p.
  await page.goto("/devices");
  await page.getByTestId("device-prefs-open").click();
  const sheet = page.getByTestId("device-prefs-sheet");
  await expect(sheet.getByTestId("prefs-detected")).toContainText("Living room box");
  await expect(sheet.getByTestId("prefs-row-default_player")).toBeVisible();
  await sheet.getByTestId("prefs-row-max_resolution").selectOption("720p");
  await expect.poll(() => prefPatches.at(-1)).toEqual({ max_resolution: "720p" });
  await expect(sheet.getByTestId("prefs-saved")).toContainText(/saved/i);
  await sheet.getByRole("button", { name: /close/i }).click();

  // After: 720p first, with the «Picked for this device» line and the warning chip on the 1080p one.
  await openReleases();
  await expect(rows.first()).toHaveAttribute("data-release-id", "rel-720");
  await expect(page.getByTestId("device-fit")).toContainText(/picked for (this device|Living Room TV): up to 720p/i);
  await expect(rows.nth(1)).toContainText(/above this device's resolution/i);

  // «Show all»: device prefs off, the plain order.
  await page.getByTestId("device-fit-toggle").click();
  await expect(rows.first()).toHaveAttribute("data-release-id", "rel-1080");
  expect(queries.at(-1)!.get("device_prefs")).toBe("off");
  await expect(page.getByTestId("device-fit-toggle")).toHaveText(/fit this device/i);
});
