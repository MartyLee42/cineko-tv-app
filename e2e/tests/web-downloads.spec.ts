import { mkdirSync, readFileSync } from "node:fs";
import { expect, test, type Page, type Route, type WebSocketRoute } from "@playwright/test";

/**
 * Server downloads («Скачать на сервер»): every /downloads, /admin/storage and
 * TorrServer route is mocked (the backend may not have them yet); login, the
 * catalog and the realtime socket are real (the socket is wrapped so tests can
 * push `download.updated`).
 */

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
const SHOTS = process.env.SHOTS_DIR ?? "/tmp/pw-dl/shots";
const CLIP = readFileSync(new URL("../fixtures/clip.webm", import.meta.url));
const SRC_ID = "5e1ec7ed-0000-4000-8000-0000000dl001";
const HASH = "0123456789abcdef0123456789abcdef01234567";

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function release(id: string, o: Record<string, unknown> = {}) {
  return {
    id,
    title: `Movie (2010) BDRip 1080p ${id}`,
    indexer: "RuTracker",
    size_bytes: 4_500_000_000,
    seeders: 2,
    leechers: 9,
    published_at: "2026-10-20T10:00:00Z",
    info_hash: HASH,
    resolution: "1080p",
    video_codec: "h264",
    hdr: null,
    audio_codecs: ["aac"],
    languages: ["ru", "en"],
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
    warnings: [],
    ...o,
  };
}

type Movie = { id: string; title: string; poster_path: string | null };

interface Mock {
  downloads: Record<string, unknown>[];
  created: Record<string, unknown>[];
  deleted: string[];
  patched: Record<string, unknown>[];
  removedTorrents: string[];
  socket: () => WebSocketRoute | null;
}

function download(movie: Movie, o: Record<string, unknown> = {}) {
  return {
    id: "d0000000-0000-4000-8000-000000000001",
    status: "downloading",
    error: null,
    progress: 0.42,
    bytes_done: 1_890_000_000,
    size: 4_500_000_000,
    rate_bps: 1.2 * 1024 * 1024,
    eta_seconds: 35 * 60,
    pinned: false,
    mine: true,
    info_hash: HASH,
    file_index: 1,
    file_name: "Movie.2010.BDRip.1080p.mkv",
    release_title: "Movie (2010) BDRip 1080p",
    media_id: movie.id,
    episode_id: null,
    season: null,
    episode: null,
    media: { ...movie, kind: "movie", tmdb_id: 1, original_title: movie.title, year: 2010, release_date: null, overview: "", backdrop_path: null, rating: null, vote_count: 0, genre_ids: [] },
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: null,
    last_watched_at: null,
    keep_until: null,
    space_needed_bytes: null,
    ...o,
  };
}

async function login(page: Page) {
  await page.goto("/login");
  // The dev server may be recompiling: let the form hydrate before typing.
  await page.waitForLoadState("networkidle");
  await page.getByLabel(/username|имя пользователя|логин/i).fill(USER);
  await page.getByLabel(/password|пароль/i).fill(PASS);
  await page.getByRole("button", { name: /sign in|войти/i }).click();
  await expect(page.getByRole("heading", { name: /welcome|привет/i })).toBeVisible({ timeout: 15_000 });
  const req = page.context().request;
  const session = await (await req.get("/api/v1/auth/session")).json();
  const headers = { "X-CSRF-Token": session.csrf_token as string, Origin: new URL(page.url()).origin };
  let profiles = (await (await req.get("/api/v1/profiles")).json()).items as { id: string }[];
  if (!profiles.length) {
    expect((await req.post("/api/v1/profiles", { data: { name: "E2E", color: "#6366f1" }, headers })).ok()).toBeTruthy();
    profiles = (await (await req.get("/api/v1/profiles")).json()).items;
  }
  await req.put(`/api/v1/profiles/${profiles[0]!.id}/settings`, { data: { onboarding_completed: true }, headers });
  await page.evaluate(([u, p]) => localStorage.setItem(`martytv.active_profile.${u}`, p), [session.user.id as string, profiles[0]!.id]);
  const search = await (await req.get("/api/v1/catalog/search?q=Inception&kind=movie")).json();
  const movie = search.items[0] as Movie;
  expect(movie).toBeTruthy();
  return { movie, user: session.user as { id: string; username: string; display_name: string } };
}

async function mockAll(page: Page, movie: Movie, opts: { initial?: Record<string, unknown>[] } = {}): Promise<Mock> {
  const m: Mock = { downloads: [...(opts.initial ?? [])], created: [], deleted: [], patched: [], removedTorrents: [], socket: () => null };
  let socket: WebSocketRoute | null = null;
  m.socket = () => socket;
  await page.routeWebSocket(/\/api\/v1\/ws/, (ws) => {
    ws.connectToServer();
    socket = ws;
  });

  await page.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) =>
    json(route, { items: [release("rel-slow"), release("rel-fast", { seeders: 80, resolution: "720p", size_bytes: 1_400_000_000 })], searched_at: new Date().toISOString(), cached: false, indexer_errors: [] }),
  );

  let polls = 0;
  const source = () => {
    const ready = polls >= 1;
    const dl = m.downloads.find((d) => d.info_hash === HASH);
    return {
      id: SRC_ID,
      media_id: movie.id,
      episode_id: null,
      release: release("rel-slow"),
      status: ready ? "ready" : "preparing",
      error: null,
      file: ready ? { index: 1, path: "Movie/movie.webm", size_bytes: CLIP.length, is_video: true, season: null, episode: null } : null,
      stream_url: ready ? `/api/v1/stream/tok-dl-${polls}` : null,
      stream_expires_at: ready ? new Date(Date.now() + 3600_000).toISOString() : null,
      mime_type: "video/webm",
      media_info: ready
        ? { container: "matroska,webm", video_codec: "vp8", width: 320, height: 180, duration_seconds: 40, audio: [{ index: 1, codec: "opus", language: "en", title: null, channels: 1, default: true }], subtitles: [] }
        : null,
      torrent: { peers: 3, seeders: 2, download_speed_bps: 200_000, preloaded_bytes: 0 },
      created_at: new Date().toISOString(),
      kind: "torrent",
      compat_url: null,
      download: dl
        ? { id: dl.id, status: dl.status, progress: dl.progress, bytes_done: dl.bytes_done, size: dl.size, rate_bps: dl.rate_bps, eta_seconds: dl.eta_seconds, completed_at: dl.completed_at, keep_until: dl.keep_until, pinned: dl.pinned, mine: true }
        : null,
    };
  };
  await page.route(/\/api\/v1\/playback\/sources(\/[^/?]+)?(\?.*)?$/, (route) => {
    if (route.request().method() === "POST") return json(route, source(), 201);
    polls++;
    return json(route, source());
  });
  await page.route(/\/api\/v1\/stream\//, (route) => {
    const r = /bytes=(\d+)-(\d*)/.exec(route.request().headers()["range"] ?? "");
    if (!r) return route.fulfill({ status: 200, headers: { "Content-Type": "video/webm", "Accept-Ranges": "bytes" }, body: CLIP });
    const start = Number(r[1]);
    const end = r[2] ? Math.min(Number(r[2]), CLIP.length - 1) : CLIP.length - 1;
    return route.fulfill({ status: 206, headers: { "Content-Type": "video/webm", "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${CLIP.length}` }, body: CLIP.subarray(start, end + 1) });
  });
  await page.route(/\/api\/v1\/playback\/sessions(\?.*)?$/, (route) => json(route, { id: "5e550000-0000-4000-8000-0000000dl0a0", resume_position_seconds: null, progress: null, report_token: "t" }, 201));
  await page.route(/\/api\/v1\/playback\/sessions\/[^/]+\/progress/, (route) => json(route, { accepted: true, progress: null }));

  await page.route(/\/api\/v1\/downloads(\/[^/?]+)?(\?.*)?$/, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const id = url.pathname.split("/downloads/")[1];
    if (req.method() === "POST") {
      const body = req.postDataJSON() as Record<string, unknown>;
      m.created.push(body);
      const d = download(movie);
      m.downloads = [d, ...m.downloads.filter((x) => x.id !== d.id)];
      return json(route, { items: [d] }, 201);
    }
    if (id && req.method() === "DELETE") {
      m.deleted.push(id);
      m.downloads = m.downloads.filter((x) => x.id !== id);
      return route.fulfill({ status: 204 });
    }
    if (id && req.method() === "PATCH") {
      const body = req.postDataJSON() as Record<string, unknown>;
      m.patched.push(body);
      const d = m.downloads.find((x) => x.id === id)!;
      if (body.pinned != null) d.pinned = body.pinned;
      if (body.paused != null) d.status = body.paused ? "paused" : "queued";
      return json(route, d);
    }
    const mediaId = url.searchParams.get("media_id");
    const all = url.searchParams.get("all") === "true";
    const items = m.downloads
      .filter((d) => !mediaId || d.media_id === mediaId)
      .map((d) => (all ? { ...d, users: [{ id: "u1", username: "marty", display_name: "Cineko" }] } : d));
    return json(route, { items });
  });

  await page.route(/\/api\/v1\/admin\/storage(\?.*)?$/, (route) =>
    json(route, {
      ok: true,
      disk_total_bytes: 1_000_000_000_000,
      disk_free_bytes: 420_000_000_000,
      library_used_bytes: 230_000_000_000,
      reserve_bytes: 16_106_127_360,
      available_bytes: 380_000_000_000,
      settings: { reserve_gb: 15, max_library_gb: null, keep_days: 30 },
      counts: { queued: 1, downloading: 1, paused: 0, done: 4, failed: 0, waiting_space: 0 },
      max_jobs: 2,
    }),
  );
  let torrents = [
    { hash: HASH, title: "Movie (2010) BDRip 1080p", size_bytes: 4_500_000_000, stat: 3, stat_string: "Torrent working", idle: false, added_at: new Date(Date.now() - 3600_000).toISOString(), peers: 3, download_speed_bps: 1_200_000, martytv: { sources: 1, streaming: true, download: { id: "d1", status: "downloading" }, in_use: true } },
    { hash: "a".repeat(40), title: "Old.Show.S01.1080p.WEB-DL", size_bytes: 22_000_000_000, stat: 5, stat_string: "Torrent in db", idle: true, added_at: "2026-09-01T10:00:00Z", peers: 0, download_speed_bps: 0, martytv: { sources: 0, streaming: false, download: null, in_use: false } },
    { hash: "b".repeat(40), title: "Lampa.Film.2019.2160p.HDR", size_bytes: 61_000_000_000, stat: 4, stat_string: "Torrent closed", idle: true, added_at: "2026-10-10T10:00:00Z", peers: 0, download_speed_bps: 0, martytv: { sources: 0, streaming: false, download: null, in_use: false } },
  ];
  await page.route(/\/api\/v1\/admin\/torrserver\/torrents(\/[0-9a-f]+)?(\?.*)?$/, (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === "DELETE") {
      const hash = url.pathname.split("/").pop()!;
      const t = torrents.find((x) => x.hash === hash);
      if (t?.martytv.in_use && url.searchParams.get("force") !== "true")
        return json(route, { error: { code: "torrent_in_use", message: "in use" } }, 409);
      m.removedTorrents.push(hash);
      torrents = torrents.filter((x) => x.hash !== hash);
      return route.fulfill({ status: 204 });
    }
    return json(route, { items: torrents });
  });
  return m;
}

const pushUpdate = (m: Mock, d: Record<string, unknown>) => m.socket()!.send(JSON.stringify({ type: "download.updated", payload: { ...d, media: null } }));

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400); // let fades / sheets settle
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

test.describe("desktop", () => {
  test.use({ locale: "en-US" });

  test("download from the release list, live chip, Downloads page, delete", async ({ page }) => {
    const { movie } = await login(page);
    const m = await mockAll(page, movie);

    await page.goto(`/title/${movie.id}`);
    await page.getByTestId("play-more").click(); // «Где и как смотреть» menu
    await page.getByTestId("choose-release").click();
    const sheet = page.getByTestId("release-sheet");
    const row = sheet.locator('[data-release-id="rel-slow"]');
    await expect(row.getByTestId("release-download")).toContainText(/download to server/i);
    await row.getByTestId("release-download").click();

    // Source is prepared like «Watch here», then POST /downloads.
    const dlSheet = page.getByTestId("download-sheet");
    await expect(dlSheet.getByTestId("download-started")).toBeVisible({ timeout: 15_000 });
    expect(m.created).toEqual([{ source_id: SRC_ID }]);
    await dlSheet.getByRole("button", { name: /close/i }).first().click();

    // Chip on the title page, then live over realtime.
    const chip = page.getByTestId("download-chip");
    await expect(chip).toContainText("Downloading 42% · 1.2 MB/s · ~35 min");
    await expect.poll(() => m.socket() != null).toBe(true);
    pushUpdate(m, { ...m.downloads[0]!, progress: 0.6, eta_seconds: 20 * 60 });
    await expect(chip).toContainText("Downloading 60%");
    await expect(chip).toContainText("~20 min");
    pushUpdate(m, { ...m.downloads[0]!, status: "done", progress: 1, rate_bps: null, eta_seconds: null, completed_at: "2026-10-29T10:00:00Z", keep_until: "2026-11-28T10:00:00Z" });
    await expect(chip).toContainText("On server ✓ · kept until Nov 28");

    // The Downloads page lists it; pin; delete with a confirm.
    await chip.click();
    await expect(page).toHaveURL(/\/downloads$/);
    const item = page.getByTestId("download-row");
    await expect(item).toHaveCount(1);
    await expect(item).toContainText(movie.title);
    await expect(item).toContainText("Movie.2010.BDRip.1080p.mkv");
    await expect(page.getByTestId("downloads-rules")).toContainText("30 days");
    await item.getByTestId("download-pin").click();
    await expect(item.getByTestId("download-pin")).toHaveAttribute("aria-pressed", "true");
    expect(m.patched).toEqual([{ pinned: true }]);
    await item.getByTestId("download-delete").click();
    await page.getByTestId("download-delete-confirm").getByTestId("confirm-yes").click();
    await expect(page.getByTestId("downloads-empty")).toBeVisible();
    expect(m.deleted).toEqual(["d0000000-0000-4000-8000-000000000001"]);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, locale: "ru-RU", isMobile: true, hasTouch: true });

  test("phone: release sheet action, chip, Загрузки from Settings and the avatar menu, player menu, admin storage", async ({ page }) => {
    test.setTimeout(120_000);
    const { movie } = await login(page);
    await page.evaluate(() => localStorage.setItem("martytv.locale", "ru"));
    const m = await mockAll(page, movie);

    // Release sheet → «Скачать на сервер».
    await page.goto(`/title/${movie.id}`);
    await page.getByTestId("play-more").click(); // «Где и как смотреть» menu
    await page.getByTestId("choose-release").click();
    const row = page.getByTestId("release-sheet").locator('[data-release-id="rel-slow"]');
    await expect(row.getByTestId("release-download")).toContainText("Скачать на сервер");
    await row.getByTestId("release-download").scrollIntoViewIfNeeded();
    await shot(page, "phone-release-sheet");
    await row.getByTestId("release-download").click();
    await expect(page.getByTestId("download-started")).toBeVisible({ timeout: 15_000 });
    await shot(page, "phone-download-sheet");
    await page.getByTestId("download-open-list").click();

    // «Загрузки»: listed with progress.
    await expect(page).toHaveURL(/\/downloads$/);
    await expect(page.getByTestId("download-row").getByTestId("download-chip")).toHaveText("Загружается 42%");
    await expect(page.getByTestId("download-size")).toHaveText("1,8 ГБ из 4,2 ГБ · 1,2 МБ/с · ~35 мин");
    await expect(page.locator("nav.fixed a[href='/settings']")).toHaveClass(/text-accent/);
    await shot(page, "phone-downloads");

    // Title page chip.
    await page.goto(`/title/${movie.id}`);
    const chip = page.getByTestId("download-chip");
    await expect(chip).toContainText("Загружается 42%");
    await chip.scrollIntoViewIfNeeded();
    await shot(page, "phone-title-chip");

    // Reach «Загрузки» from Settings (bottom bar) and from the avatar menu.
    await page.locator("nav.fixed a[href='/settings']").click();
    await page.locator("main a[href='/downloads']").click();
    await expect(page.getByTestId("downloads-page")).toBeVisible();
    await page.goto("/");
    await page.getByTestId("profile-menu-button").click();
    await page.getByTestId("menu-downloads").click();
    await expect(page.getByTestId("downloads-page")).toBeVisible();

    // Player menu: the download's state (already requested).
    await page.goto(`/watch/${SRC_ID}?media=${movie.id}`);
    await expect(page.getByTestId("player-loader")).toHaveCount(0, { timeout: 20_000 });
    await page.mouse.click(195, 300);
    await page.getByTestId("player-download").click();
    await expect(page.getByTestId("player-download-state")).toContainText("Загружается 42%");
    await shot(page, "phone-player-menu");

    // Delete from the page.
    await page.goto("/downloads");
    await page.getByTestId("download-delete").click();
    await expect(page.getByTestId("download-delete-confirm")).toBeVisible();
    await page.getByTestId("confirm-yes").click();
    await expect(page.getByTestId("downloads-empty")).toBeVisible();

    // Player without a download: start it from the menu.
    await page.goto(`/watch/${SRC_ID}?media=${movie.id}`);
    await expect(page.getByTestId("player-loader")).toHaveCount(0, { timeout: 20_000 });
    await page.mouse.click(195, 300);
    await page.getByTestId("player-download").click();
    await shot(page, "phone-player-menu-start");
    await page.getByTestId("player-download-start").click();
    await expect(page.getByTestId("player-download-state")).toBeVisible();
    expect(m.created.at(-1)).toEqual({ source_id: SRC_ID });

    // Admin → Хранилище.
    await page.goto("/admin?tab=storage");
    const tab = page.getByTestId("storage-tab");
    await expect(tab.getByTestId("disk-bar")).toBeVisible();
    await expect(tab.getByTestId("admin-download-row")).toHaveCount(1);
    await expect(tab.getByTestId("admin-download-row")).toContainText("Запросили: Cineko");
    await shot(page, "phone-admin-storage");
    await tab.getByTestId("torrents").scrollIntoViewIfNeeded();
    await shot(page, "phone-admin-torrents");

    // Removing a torrent in use: confirm (mentions Lampa) → 409 → «Удалить всё равно».
    await tab.locator(`[data-hash="${HASH}"]`).getByTestId("torrent-remove").click();
    await expect(page.getByTestId("torrent-remove-confirm")).toContainText("Lampa");
    await page.getByTestId("confirm-yes").click();
    await expect(page.getByTestId("torrent-in-use")).toContainText("Удалить всё равно");
    await page.getByTestId("confirm-yes").click();
    await expect(tab.locator(`[data-hash="${HASH}"]`)).toHaveCount(0);
    expect(m.removedTorrents).toEqual([HASH]);

    // Bulk «Удалить неактивные».
    await tab.getByTestId("torrents-remove-inactive").click();
    await expect(page.getByTestId("torrent-remove-confirm")).toContainText("Lampa");
    await page.getByTestId("confirm-yes").click();
    await expect(tab.getByTestId("torrents-result")).toContainText("Удалено: 2");
    expect(m.removedTorrents.length).toBe(3);

    // Multi-select delete in the downloads table.
    await tab.getByTestId("downloads-select-all").check();
    await tab.getByTestId("downloads-delete-selected").click();
    await page.getByTestId("admin-delete-confirm").getByTestId("confirm-yes").click();
    await expect(tab.getByTestId("admin-download-row")).toHaveCount(0);
  });
});
