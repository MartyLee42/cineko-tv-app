import { mkdirSync, readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

/** A 16 s VP9/Opus fMP4 HLS (Playwright's Chromium has no H.264). */
const HLS = (name: string) => readFileSync(new URL(`../fixtures/hls/${name}`, import.meta.url));
const SHOTS = "test-results/sources-shots";
mkdirSync(SHOTS, { recursive: true });

const SOURCE_ID = "5e1f0000-0000-4000-8000-00000000c001";
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function press(tv: Page, key: string, times = 1) {
  for (let i = 0; i < times; i++) {
    await tv.keyboard.press(key);
    await tv.waitForTimeout(160);
  }
}

async function sendCommand(phone: Page, deviceId: string, body: { type: string; payload?: unknown }) {
  return phone.evaluate(
    async ({ deviceId, body }) => {
      const session = await (await fetch("/api/v1/auth/session")).json();
      const r = await fetch(`/api/v1/devices/${deviceId}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrf_token },
        body: JSON.stringify(body),
      });
      return (await r.json()) as { ok: boolean };
    },
    { deviceId, body },
  );
}

function release(id: string, provider: "prowlarr" | "jacred", p: Record<string, unknown> = {}) {
  return {
    id,
    provider: { id: provider, name: provider === "prowlarr" ? "Prowlarr" : "Jacred", kind: "torrent" },
    title: `Mock.Release.${id}.1080p.WEB-DL`,
    indexer: provider === "prowlarr" ? "RuTracker" : "Kinozal",
    size_bytes: 2_400_000_000,
    seeders: 85,
    leechers: 4,
    published_at: null,
    info_hash: null,
    resolution: "1080p",
    video_codec: "h264",
    hdr: null,
    audio_codecs: ["aac"],
    languages: ["ru"],
    voiceovers: [],
    release_group: "MOCK",
    source_quality: "web-dl",
    year: 2001,
    seasons: [],
    episodes: [],
    is_season_pack: false,
    confidence: 0.97,
    score: 10,
    reasons: ["title_exact"],
    warnings: [],
    ...p,
  };
}

const variant = (id: string, o: Record<string, unknown> = {}) => ({
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
});

/** Settings (onboarding done; PUTs captured, never stored), sources, releases, /online, the online source and its HLS. */
async function mockTv(ctx: BrowserContext, mediaId: () => string) {
  const log = { created: [] as Record<string, unknown>[], patched: [] as Record<string, unknown>[], streams: {} as Record<string, number>, puts: [] as Record<string, unknown>[] };
  let enabled: "all" | string[] = "all";
  let quality = 1080;
  const on = (id: string) => enabled === "all" || enabled.includes(id);

  // Real settings are read once and never written: PUTs only update this copy.
  let current: Record<string, unknown> | null = null;
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { sources?: { enabled: "all" | string[] } };
      log.puts.push(body);
      if (body.sources) enabled = body.sources.enabled;
      current = { ...(current ?? {}), ...body };
    } else if (!current) {
      const res = await route.fetch().catch(() => null);
      current = res && res.ok() ? await res.json() : {};
    }
    return json(route, { ...current, onboarding_completed: true, sources: { enabled } });
  });
  await ctx.route(/\/api\/v1\/sources(\?.*)?$/, (route) =>
    json(route, {
      enabled,
      items: [
        { id: "prowlarr", kind: "torrent", name: "Prowlarr", needs_credentials: true, configured: true, enabled_by_admin: true, healthy: true },
        { id: "jacred", kind: "torrent", name: "Jacred", needs_credentials: false, configured: true, enabled_by_admin: true, healthy: true },
        { id: "anilibria", kind: "anime", name: "AniLiberty", needs_credentials: false, configured: true, enabled_by_admin: true, healthy: null },
      ].map((s) => ({ ...s, enabled: on(s.id), available: true })),
    }),
  );
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, (route) => json(route, { items: [] }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/progress/, (route) => json(route, { media_id: "x", kind: "movie", movie: null, episodes: [], seasons: [], next_up: null }));
  await ctx.route(/\/api\/v1\/playback\/sessions(\?.*)?$/, (route) => json(route, { id: "5e550000-0000-4000-8000-00000000cccc", resume_position_seconds: null, progress: null, report_token: "x" }, 201));
  await ctx.route(/\/api\/v1\/playback\/sessions\/[^/]+\/progress/, (route) => json(route, { accepted: true, progress: null }));
  await ctx.route(/\/api\/v1\/messages(\?.*)?$/, (route) => json(route, { items: [], unread: 0 }));

  await ctx.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) =>
    json(route, {
      items: [release("rel-p", "prowlarr"), release("rel-j", "jacred", { resolution: "720p", seeders: 20 })].filter((r) => on(r.provider.id)),
      searched_at: new Date().toISOString(),
      cached: false,
      indexer_errors: [],
    }),
  );
  await ctx.route(/\/api\/v1\/media\/[^/]+\/online/, (route) =>
    json(route, {
      items: [variant("o-pref", { preferred: true, score: 0.93 }), variant("o-alt", { voice: "AniLibria (2-я версия)", max_quality: 720, qualities: [720, 480] })],
      providers: [{ id: "anilibria", name: "AniLiberty", kind: "anime", status: "ok", count: 2, error: null, cached: false }],
      searched_at: new Date().toISOString(),
      cached: false,
    }),
  );
  const source = () => ({
    id: SOURCE_ID,
    media_id: mediaId(),
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
    subtitles: [],
    markers: [{ kind: "opening", start_seconds: 0, end_seconds: 9 }],
    duration_seconds: 16,
  });
  await ctx.route(/\/api\/v1\/playback\/sources(\/[^/?]+)?(\?.*)?$/, (route) => {
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
  await ctx.route(/\/api\/v1\/stream\//, (route) => {
    const parts = new URL(route.request().url()).pathname.split("/");
    const tok = parts.at(-2)!;
    const file = parts.at(-1)!;
    log.streams[tok] = (log.streams[tok] ?? 0) + 1;
    return route.fulfill({ status: 200, headers: { "Content-Type": file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4" }, body: HLS(file) });
  });
  return log;
}

const video = (tv: Page) => tv.locator("[data-testid=player] video");
const currentTime = (tv: Page) => video(tv).evaluate((v: HTMLVideoElement) => v.currentTime);

/**
 * TV: the release picker shows provider chips and the «Аниме · AniLiberty»
 * group (preferred variant focused); OK plays it at once over HLS; OK during
 * the opening skips it; the tracks panel switches quality keeping the
 * position. Settings has a «Источники» section with on/off rows.
 */
test("TV: anime group in the picker, HLS playback, skip opening, quality, settings", async ({ browser }) => {
  test.setTimeout(150_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: "ru-RU" });
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
  const search = await (await phoneCtx.request.get(`/api/v1/catalog/search?q=${encodeURIComponent("Spirited Away")}&kind=movie&lang=ru`)).json();
  const movieId = search.items[0].id as string;
  const log = await mockTv(tvCtx, () => movieId);

  await tv.goto("/tv/");
  await tv.evaluate(() => localStorage.setItem("martytv.locale", "ru"));
  await tv.reload();
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Sources TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  const devices = await (await phoneCtx.request.get("/api/v1/devices")).json();
  const deviceId = devices.items.find((d: { name: string }) => d.name === deviceName).id as string;
  try {
    if (await tv.getByRole("heading", { name: /кто смотрит|who's watching/i }).isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");

    // --- Details → ☰ → release picker.
    expect((await sendCommand(phone, deviceId, { type: "media.open", payload: { media_id: movieId } })).ok).toBe(true);
    await expect(tv.locator("[data-media-id] h1")).not.toBeEmpty({ timeout: 30_000 });
    await expect(tv.locator("[data-media-id] .is-focused")).toBeVisible();
    await press(tv, "ArrowRight");
    await press(tv, "Enter");
    const picker = tv.getByTestId("release-picker");
    await expect(picker).toBeVisible();
    const group = picker.getByTestId("picker-online");
    await expect(group).toContainText("Аниме");
    await expect(group).toContainText("AniLiberty");
    const variants = picker.locator("[data-variant-id]");
    await expect(variants).toHaveCount(2);
    await expect(variants.nth(0)).toHaveAttribute("data-preferred", "1");
    await expect(variants.nth(0)).toContainText("AniLibria");
    await expect(variants.nth(0)).toContainText("1080p · 720p · 480p");
    // Torrents keep their rows, with provider chips; the preferred variant is focused.
    await expect(picker.locator("[data-release-id]")).toHaveCount(2);
    await expect(picker.locator("[data-provider]")).toHaveText(["Prowlarr", "Jacred"]);
    await expect(variants.nth(0)).toHaveClass(/is-focused/);
    await tv.screenshot({ path: `${SHOTS}/tv-picker.png` });
    // Down moves from the variants to the torrents.
    await press(tv, "ArrowDown", 2);
    await expect(picker.locator("[data-release-id]").nth(0)).toHaveClass(/is-focused/);
    await press(tv, "ArrowUp", 2);
    await expect(variants.nth(0)).toHaveClass(/is-focused/);

    // --- OK plays the variant at once (HLS).
    await press(tv, "Enter");
    await expect.poll(() => log.created).toEqual([expect.objectContaining({ media_id: movieId, release_id: "o-pref" })]);
    await expect(tv.getByTestId("player")).toBeVisible();
    await expect.poll(() => currentTime(tv), { timeout: 20_000 }).toBeGreaterThan(0.5);
    expect(log.streams["tok-q1080"]).toBeGreaterThan(1);

    // --- During the opening, OK skips it.
    await expect(tv.getByTestId("skip-opening")).toBeVisible();
    await tv.screenshot({ path: `${SHOTS}/tv-player-skip.png` });
    await press(tv, "Enter");
    await expect.poll(() => currentTime(tv)).toBeGreaterThanOrEqual(8.9);
    await expect(tv.getByTestId("skip-opening")).toHaveCount(0);

    // --- Pause, then quality in the tracks panel (Down): 480p keeps the position.
    await press(tv, "Enter");
    await expect.poll(() => video(tv).evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
    const at = await currentTime(tv);
    await press(tv, "ArrowDown");
    const panel = tv.getByTestId("player-tracks");
    await expect(panel).toContainText("Качество");
    await expect(panel).toContainText("480p");
    await tv.screenshot({ path: `${SHOTS}/tv-player-quality.png` });
    // Items: subtitles off, 1080p, 720p, 480p.
    await press(tv, "ArrowDown", 3);
    await press(tv, "Enter");
    await expect.poll(() => log.patched).toEqual([{ quality: 480 }]);
    await expect.poll(() => log.streams["tok-q480"] ?? 0, { timeout: 10_000 }).toBeGreaterThan(1);
    await expect.poll(() => currentTime(tv), { timeout: 10_000 }).toBeGreaterThan(at - 0.6);
    expect(await currentTime(tv)).toBeLessThan(at + 0.6);
    await press(tv, "Escape");
    await press(tv, "Escape");
    await expect(tv.getByTestId("player")).toHaveCount(0, { timeout: 10_000 });

    // --- Settings → Источники: Jacred off → saved as an explicit list.
    await press(tv, "Escape");
    await press(tv, "ArrowLeft");
    // (The rail marks focus as data-focused or, in the newer shell, data-nav-focused.)
    const settingsItem = tv.locator("[data-menu=settings]").first();
    const railFocused = async () => (await settingsItem.getAttribute("data-focused")) === "1" || (await settingsItem.getAttribute("data-nav-focused")) === "1";
    // Walk until it's focused (the menu grows with new tabs); the cap only stops a stuck walk.
    for (let i = 0; i < 40 && !(await railFocused()); i++) await press(tv, "ArrowDown");
    await press(tv, "Enter");
    const settings = tv.getByTestId("tv-settings");
    await expect(settings).toBeVisible();
    const jacred = settings.locator('[data-setting="source:jacred"]');
    await expect(jacred).toHaveAttribute("data-value", "true");
    for (let i = 0; i < 60 && !/is-focused/.test((await jacred.getAttribute("class")) ?? ""); i++) await press(tv, "ArrowDown");
    await expect(jacred).toHaveClass(/is-focused/);
    await tv.screenshot({ path: `${SHOTS}/tv-settings.png` });
    await press(tv, "ArrowRight");
    await expect.poll(() => log.puts.map((p) => p.sources)).toContainEqual({ enabled: ["prowlarr", "anilibria"] });
    await expect(jacred).toHaveAttribute("data-value", "false");
    await press(tv, "ArrowRight");
    await expect.poll(() => log.puts.at(-1)?.sources).toEqual({ enabled: "all" });
  } finally {
    await phoneCtx.request.delete(`/api/v1/devices/${deviceId}`, { headers: { "X-CSRF-Token": session.csrf_token, Origin: origin } }).catch(() => undefined);
    await phoneCtx.close();
    await tvCtx.close();
  }
});
