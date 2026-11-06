import { mkdirSync, readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

/** A 16 s VP9/Opus fMP4 HLS (Playwright's Chromium has no H.264). */
const HLS = (name: string) => readFileSync(new URL(`../fixtures/hls/${name}`, import.meta.url));
const SHOTS = "test-results/online-shots";
mkdirSync(SHOTS, { recursive: true });

type Design = "kinozal" | "terminal" | "projector";
const SOURCE_ID = "5e1f0000-0000-4000-8000-00000000c002";
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

const CVH = { id: "cdnvideohub", name: "CDNVideoHub", kind: "online" };
const COLLAPS = { id: "collaps", name: "Collaps", kind: "online" };
const ANIME = { id: "anilibria", name: "AniLiberty", kind: "anime" };

const variant = (id: string, provider: typeof CVH, voice: string, o: Record<string, unknown> = {}) => ({
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
});

/** Online list per title: `withOnline` gets CDNVideoHub + Collaps (+ an anime row); others only anime. */
const onlineFor = (withOnline: boolean) => ({
  items: withOnline
    ? [
        variant("o-col-dub", COLLAPS, "Дубляж", { voiceover: { kind: "dub", studio: null, language: "ru" }, format: "hls", max_quality: 720, qualities: [720], preferred: true, score: 0.9 }),
        variant("o-cvh-dub", CVH, "Дубляж", { voiceover: { kind: "dub", studio: null, language: "ru" }, score: 0.88 }),
        variant("o-cvh-sdi", CVH, "SDI Media", { score: 0.6 }),
        variant("o-col-ntv", COLLAPS, "НТВ", { format: "hls", max_quality: 720, qualities: [720], score: 0.5 }),
        variant("o-ani", ANIME, "AniLibria", { format: "hls", score: 0.1 }),
      ]
    : [variant("o-ani", ANIME, "AniLibria", { format: "hls", preferred: true })],
  providers: [
    { id: "cdnvideohub", name: "CDNVideoHub", kind: "online", status: withOnline ? "ok" : "empty", count: withOnline ? 2 : 0, error: null, cached: false },
    { id: "collaps", name: "Collaps", kind: "online", status: withOnline ? "ok" : "empty", count: withOnline ? 2 : 0, error: null, cached: false },
    { id: "anilibria", name: "AniLiberty", kind: "anime", status: "ok", count: 1, error: null, cached: false },
  ],
  searched_at: new Date().toISOString(),
  cached: false,
});

/** Settings (design switchable), releases, /online per title, the online source and its HLS. */
async function mockTv(ctx: BrowserContext, s: { design: Design; onlineId: () => string }) {
  const log = { created: [] as Record<string, unknown>[], online: [] as string[] };
  let current: Record<string, unknown> | null = null;
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
    if (route.request().method() === "GET" && !current) {
      const res = await route.fetch().catch(() => null);
      current = res && res.ok() ? await res.json() : {};
    }
    return json(route, { ...(current ?? {}), design: s.design, theme: "dark", onboarding_completed: true });
  });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, (route) => json(route, { items: [] }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/progress/, (route) => json(route, { media_id: "x", kind: "movie", movie: null, episodes: [], seasons: [], next_up: null }));
  await ctx.route(/\/api\/v1\/playback\/sessions(\?.*)?$/, (route) => json(route, { id: "5e550000-0000-4000-8000-00000000cccd", resume_position_seconds: null, progress: null, report_token: "x" }, 201));
  await ctx.route(/\/api\/v1\/playback\/sessions\/[^/]+\/progress/, (route) => json(route, { accepted: true, progress: null }));
  await ctx.route(/\/api\/v1\/messages(\?.*)?$/, (route) => json(route, { items: [], unread: 0 }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) => json(route, { items: [], searched_at: new Date().toISOString(), cached: false, indexer_errors: [] }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/online/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2)!;
    log.online.push(id);
    return json(route, onlineFor(id === s.onlineId()));
  });
  await ctx.route(/\/api\/v1\/playback\/sources(\/[^/?]+)?(\?.*)?$/, (route) => {
    const req = route.request();
    if (req.method() === "POST") log.created.push(req.postDataJSON() as Record<string, unknown>);
    return json(
      route,
      {
        id: SOURCE_ID,
        media_id: s.onlineId(),
        episode_id: null,
        release: {
          id: "o-cvh-sdi", provider: CVH, title: "CDNVideoHub", indexer: "CDNVideoHub", size_bytes: 0, seeders: 0, leechers: null, published_at: null, info_hash: null,
          resolution: "720p", video_codec: null, hdr: null, audio_codecs: [], languages: ["ru"], voiceovers: [{ kind: null, studio: "SDI Media", language: "ru" }],
          release_group: null, source_quality: null, year: null, seasons: [], episodes: [], is_season_pack: false, confidence: 1, score: 1, reasons: [], warnings: [],
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
        qualities: [1080, 720, 480],
        subtitles: [],
        duration_seconds: 16,
      },
      req.method() === "POST" ? 201 : 200,
    );
  });
  await ctx.route(/\/api\/v1\/stream\//, (route) => {
    const file = new URL(route.request().url()).pathname.split("/").at(-1)!;
    return route.fulfill({ status: 200, headers: { "Content-Type": file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4" }, body: HLS(file) });
  });
  return log;
}

const video = (tv: Page) => tv.locator("[data-testid=player] video");

/**
 * TV Details: «Смотреть онлайн» appears right after Play when /online has
 * online (non-anime) variants, in every design; it opens the compact picker
 * (sources with voice chips, quality, Play), which starts the chosen voice and
 * quality without a torrent. The combined release picker lists the «Онлайн»
 * group too. Only anime / nothing → no button.
 */
test("TV: «Смотреть онлайн» button and online picker in all designs", async ({ browser }) => {
  test.setTimeout(180_000);
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
  const find = async (q: string) => (await (await phoneCtx.request.get(`/api/v1/catalog/search?q=${encodeURIComponent(q)}&kind=movie&lang=ru`)).json()).items[0].id as string;
  const movieId = await find("Spirited Away");
  const otherId = await find("My Neighbor Totoro");
  const s = { design: "kinozal" as Design, onlineId: () => movieId };
  const log = await mockTv(tvCtx, s);

  await tv.goto("/tv/");
  await tv.evaluate(() => localStorage.setItem("martytv.locale", "ru"));
  await tv.reload();
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Online TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });
  const devices = await (await phoneCtx.request.get("/api/v1/devices")).json();
  const deviceId = devices.items.find((d: { name: string }) => d.name === deviceName).id as string;

  const chooseProfile = async () => {
    if (await tv.getByRole("heading", { name: /кто смотрит|who's watching/i }).isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");
  };
  const openDetails = async (id: string) => {
    // After a reload the TV reconnects to the server first (the phone would show it offline meanwhile).
    await expect
      .poll(async () => (await (await phoneCtx.request.get("/api/v1/devices")).json()).items.find((d: { id: string; online: boolean }) => d.id === deviceId)?.online, { timeout: 20_000 })
      .toBe(true);
    expect((await sendCommand(phone, deviceId, { type: "media.open", payload: { media_id: id } })).ok).toBe(true);
    await expect(tv.locator(`[data-media-id="${id}"] h1`)).not.toBeEmpty({ timeout: 30_000 });
    await expect(tv.locator("[data-media-id] .is-focused")).toBeVisible();
  };
  const onlineBtn = tv.locator("[data-media-id] [role=button]", { hasText: "Смотреть онлайн" });
  const picker = tv.getByTestId("online-picker");

  try {
    await chooseProfile();
    for (const design of ["kinozal", "terminal", "projector"] as Design[]) {
      s.design = design;
      if (design !== "kinozal") {
        await tv.reload();
        await chooseProfile();
      }
      await openDetails(movieId);
      await expect(tv.locator(`[data-design="${design}"]`)).toBeVisible();

      // Fetched lazily after Details opened; right after Play.
      await expect(onlineBtn).toBeVisible({ timeout: 15_000 });
      await press(tv, "ArrowRight");
      await expect(onlineBtn).toHaveClass(/is-focused/);
      await tv.screenshot({ path: `${SHOTS}/tv-details-${design}.png` });
      await press(tv, "Enter");
      await expect(picker).toBeVisible();

      // Sources with voice chips (Collaps first: it has the preferred voice); no anime.
      await expect(picker.getByTestId("online-voices-collaps").locator("[data-variant-id]")).toHaveText([/★ Дубляж/, /НТВ/]);
      await expect(picker.getByTestId("online-voices-cdnvideohub").locator("[data-variant-id]")).toHaveText([/Дубляж/, /SDI Media/]);
      await expect(picker.locator('[data-variant-id="o-ani"]')).toHaveCount(0);
      // Native HLS: the server's pick; otherwise the MP4 of the same voice. Play is focused.
      const nativeHls = await tv.evaluate(() => !!document.createElement("video").canPlayType("application/vnd.apple.mpegurl"));
      await expect(picker.locator("[data-selected='1'][data-variant-id]")).toHaveAttribute("data-variant-id", nativeHls ? "o-col-dub" : "o-cvh-dub");
      await expect(picker.getByTestId("online-quality")).toHaveCount(nativeHls ? 0 : 1);
      await expect(picker.getByTestId("online-play")).toHaveClass(/is-focused/);
      await tv.screenshot({ path: `${SHOTS}/tv-online-picker-${design}.png` });

      if (design !== "kinozal") {
        await press(tv, "Escape");
        await expect(picker).toHaveCount(0);
        await expect(onlineBtn).toHaveClass(/is-focused/);
        await press(tv, "Escape");
        continue;
      }

      // Voice SDI Media (▲ to the CDNVideoHub row, ▶, OK → back on Play), then quality 720p (▲, ▶▶, OK).
      await press(tv, "ArrowUp", nativeHls ? 1 : 2);
      await press(tv, "ArrowRight");
      await expect(picker.locator('[data-variant-id="o-cvh-sdi"]')).toHaveClass(/is-focused/);
      await press(tv, "Enter");
      await expect(picker.locator('[data-variant-id="o-cvh-sdi"]')).toHaveAttribute("data-selected", "1");
      await expect(picker.getByTestId("online-play")).toHaveClass(/is-focused/);
      await expect(picker.getByTestId("online-quality").locator("[data-quality]")).toHaveText(["Авто", "1080p", "720p", "480p"]);
      await press(tv, "ArrowUp");
      await press(tv, "ArrowRight", 2);
      await expect(picker.locator('[data-quality="720"]')).toHaveClass(/is-focused/);
      await press(tv, "Enter");
      await expect(picker.getByTestId("online-play")).toHaveClass(/is-focused/);
      await expect(picker.getByTestId("online-selection")).toContainText("CDNVideoHub · SDI Media · 720p · MP4");

      // Play: no torrent, the chosen variant and quality.
      await press(tv, "Enter");
      await expect.poll(() => log.created).toEqual([expect.objectContaining({ media_id: movieId, release_id: "o-cvh-sdi", quality: 720 })]);
      await expect(tv.getByTestId("player")).toBeVisible();
      await expect.poll(() => video(tv).evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20_000 }).toBeGreaterThan(0.5);
      await press(tv, "Escape");
      await press(tv, "Escape");
      await expect(tv.getByTestId("player")).toHaveCount(0, { timeout: 10_000 });

      // The combined release picker (☰) lists the online group too.
      await expect(tv.locator("[data-media-id]")).toBeVisible();
      await expect(onlineBtn).toBeVisible();
      await expect(tv.locator("[data-media-id] .is-focused")).toContainText(/Смотреть|Продолжить/);
      await press(tv, "ArrowRight", 2);
      await press(tv, "Enter");
      const rp = tv.getByTestId("release-picker");
      await expect(rp).toBeVisible();
      await expect(rp.getByTestId("picker-online")).toContainText("Онлайн · Аниме");
      await expect(rp.locator("[data-variant-id]")).toHaveCount(5);
      await press(tv, "Escape");
      await expect(rp).toHaveCount(0);
      await press(tv, "Escape");
    }

    // Only anime (or nothing) online: no button.
    await openDetails(otherId);
    await expect.poll(() => log.online.includes(otherId), { timeout: 15_000 }).toBe(true);
    await tv.waitForTimeout(800);
    await expect(onlineBtn).toHaveCount(0);
  } finally {
    await phoneCtx.request.delete(`/api/v1/devices/${deviceId}`, { headers: { "X-CSRF-Token": session.csrf_token, Origin: origin } }).catch(() => undefined);
    await phoneCtx.close();
    await tvCtx.close();
  }
});
