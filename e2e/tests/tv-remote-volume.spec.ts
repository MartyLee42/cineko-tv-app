import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

/** A 40 s VP8/Opus WebM (Playwright's Chromium has no H.264). */
const CLIP = readFileSync(new URL("../fixtures/clip.webm", import.meta.url));
const SOURCE_ID = "5e1f0000-0000-4000-8000-0000000000a1";

interface Ack {
  id: string;
  ok: boolean;
  error?: string;
  result?: Record<string, unknown>;
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** No watch state / first-run guide / messages on the real profile. */
async function isolateWatch(ctx: BrowserContext) {
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch().catch(() => null);
    const body = res && res.ok() ? await res.json() : {};
    return json(route, { ...body, onboarding_completed: true });
  });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, (route) => json(route, { items: [] }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/progress/, (route) => json(route, { media_id: "x", kind: "movie", movie: null, episodes: [], seasons: [], next_up: null }));
  await ctx.route(/\/api\/v1\/playback\/sessions(\?.*)?$/, (route) =>
    json(route, { id: "5e550000-0000-4000-8000-00000000fffe", resume_position_seconds: null, progress: null, report_token: "x" }, 201),
  );
  await ctx.route(/\/api\/v1\/playback\/sessions\/[^/]+\/progress/, (route) => json(route, { accepted: true, progress: null }));
  await ctx.route(/\/api\/v1\/messages(\?.*)?$/, (route) => json(route, { items: [], unread: 0 }));
}

/** One ready source with the mocked clip (never touches TorrServer). */
async function mockSource(ctx: BrowserContext, mediaId: () => string) {
  const source = () => ({
    id: SOURCE_ID,
    media_id: mediaId(),
    episode_id: null,
    release: {
      id: "rel-volume",
      title: "Mock.Release.Volume",
      indexer: "MockTracker",
      size_bytes: 2_400_000_000,
      seeders: 85,
      leechers: 4,
      published_at: null,
      info_hash: null,
      resolution: "1080p",
      video_codec: "h264",
      hdr: null,
      audio_codecs: ["aac"],
      languages: ["en"],
      release_group: "MOCK",
      source_quality: "web-dl",
      year: 1999,
      seasons: [],
      episodes: [],
      is_season_pack: false,
      confidence: 0.97,
      score: 10,
      reasons: ["title_exact"],
      warnings: [],
    },
    status: "ready",
    error: null,
    file: { index: 0, path: "Movie/clip.webm", size_bytes: CLIP.length, is_video: true, season: null, episode: null },
    stream_url: "/api/v1/stream/tok-volume",
    stream_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    mime_type: "video/webm",
    media_info: {
      container: "matroska,webm",
      video_codec: "vp8",
      width: 320,
      height: 180,
      duration_seconds: 40,
      audio: [{ index: 1, codec: "opus", language: "en", title: null, channels: 1, default: true }],
      subtitles: [],
    },
    torrent: { peers: 10, seeders: 9, download_speed_bps: 3_200_000, preloaded_bytes: 18_000_000 },
    created_at: new Date().toISOString(),
  });
  await ctx.route(/\/api\/v1\/media\/[^/]+\/online/, (route) => json(route, { items: [], providers: [], searched_at: new Date().toISOString(), cached: true }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) => json(route, { items: [], searched_at: new Date().toISOString(), cached: true, indexer_errors: [] }));
  await ctx.route(/\/api\/v1\/playback\/sources(\/[^/?]+)?(\?.*)?$/, (route) =>
    route.request().method() === "DELETE" ? route.fulfill({ status: 204 }) : json(route, source(), route.request().method() === "POST" ? 201 : 200),
  );
  await ctx.route(/\/api\/v1\/stream\//, (route) => {
    const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers()["range"] ?? "");
    if (!m) return route.fulfill({ status: 200, headers: { "Content-Type": "video/webm", "Accept-Ranges": "bytes" }, body: CLIP });
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), CLIP.length - 1) : CLIP.length - 1;
    return route.fulfill({
      status: 206,
      headers: { "Content-Type": "video/webm", "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${CLIP.length}` },
      body: CLIP.subarray(start, end + 1),
    });
  });
}

/** POST /devices/{id}/commands from the phone; HTTP status + body (no throw). */
async function postCommand(phone: Page, deviceId: string, body: { type: string; payload?: unknown }): Promise<{ status: number; ack: Ack }> {
  return phone.evaluate(
    async ({ deviceId, body }) => {
      const session = await (await fetch("/api/v1/auth/session")).json();
      const r = await fetch(`/api/v1/devices/${deviceId}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrf_token },
        body: JSON.stringify(body),
      });
      return { status: r.status, ack: await r.json() };
    },
    { deviceId, body },
  );
}

const video = (tv: Page) => tv.locator("[data-testid=player] video");
const media = (tv: Page) => video(tv).evaluate((v: HTMLVideoElement) => ({ volume: Math.round(v.volume * 100) / 100, muted: v.muted, paused: v.paused }));

/**
 * Remote volume: playback.set_volume from the phone changes the TV player's
 * level / mute (Cineko's own volume in a browser without Tizen's audio API),
 * persists it for the next film, shows the TV's indicator, and the phone's
 * bar follows the TV's reported state. Then with a fake `tizen.tvaudiocontrol`
 * the same command drives the "system" volume.
 */
test("TV remote volume: Тише / Громче / Без звука, bar, play/pause, system volume", async ({ browser }) => {
  test.setTimeout(150_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
  await isolateWatch(tvCtx);
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
  const search = await (await phoneCtx.request.get(`/api/v1/catalog/search?q=${encodeURIComponent("The Matrix")}&kind=movie&lang=en`)).json();
  const movieId = search.items[0].id as string;
  await mockSource(tvCtx, () => movieId);

  // Pair the TV.
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Volume TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  try {
    const devices = await (await phoneCtx.request.get("/api/v1/devices")).json();
    const deviceId = devices.items.find((d: { name: string }) => d.name === deviceName).id as string;
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await tv.keyboard.press("Enter");
    const serverState = async () => (await (await phoneCtx.request.get(`/api/v1/devices/${deviceId}/state`)).json()).state;
    await expect.poll(serverState, { timeout: 30_000 }).toMatchObject({ screen: "home", volume: 1, muted: false, volume_source: "app", system_volume: "absent" });

    // --- Validation: a bad level is a 422 on HTTP; nothing reaches the TV.
    expect((await postCommand(phone, deviceId, { type: "playback.set_volume", payload: { volume: 1.5 } })).status).toBe(422);
    expect((await postCommand(phone, deviceId, { type: "playback.set_volume", payload: {} })).status).toBe(422);

    // --- Nothing playing: the level is stored anyway (and acked with the new state).
    const set = await postCommand(phone, deviceId, { type: "playback.set_volume", payload: { volume: 0.5 } });
    expect(set.status).toBe(200);
    expect(set.ack).toMatchObject({ ok: true, result: { volume: 0.5, muted: false } });
    const osd = tv.getByTestId("tv-volume-osd");
    await expect(osd).toHaveAttribute("data-visible", "1");
    await expect(osd).toContainText("50 %");
    await expect(osd).toHaveAttribute("data-visible", "0", { timeout: 6_000 });

    // --- A film starts at the stored level.
    const play = await postCommand(phone, deviceId, { type: "media.play", payload: { media_id: movieId, source_id: SOURCE_ID } });
    expect(play.ack.ok, JSON.stringify(play.ack)).toBe(true);
    await expect.poll(() => video(tv).evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20_000 }).toBeGreaterThan(1);
    expect(await media(tv)).toMatchObject({ volume: 0.5, muted: false });

    // --- The phone remote.
    await phone.goto(`/remote/${deviceId}`);
    const row = phone.getByTestId("remote-volume");
    await expect(row).toHaveAttribute("data-volume", "50");
    await expect(row).toHaveAttribute("data-source", "app");
    const down = phone.getByRole("button", { name: /^(quieter|тише)$/i });
    const up = phone.getByRole("button", { name: /^(louder|громче)$/i });
    const mute = phone.getByTestId("remote-volume-mute");
    await expect(down).toBeVisible();

    await down.click();
    await expect.poll(() => media(tv)).toMatchObject({ volume: 0.4, muted: false });
    await expect(osd).toHaveAttribute("data-visible", "1");
    await expect(osd).toContainText("40 %");
    await expect(row).toHaveAttribute("data-volume", "40");

    await up.click();
    await expect(row).toHaveAttribute("data-volume", "50");
    await up.click();
    await expect.poll(() => media(tv)).toMatchObject({ volume: 0.6 });
    await expect(row).toHaveAttribute("data-volume", "60");
    await expect(phone.getByTestId("remote-volume-value")).toHaveText("60 %");
    await expect.poll(serverState).toMatchObject({ volume: 0.6, muted: false });

    // «Без звука» → muted on the TV, the indicator says so, the phone's toggle is pressed.
    await mute.click();
    await expect.poll(() => media(tv)).toMatchObject({ volume: 0.6, muted: true });
    await expect(osd).toContainText(/sound off|звук выключен/i);
    await expect(osd).toHaveAttribute("data-muted", "1");
    await expect(row).toHaveAttribute("data-muted", "1");
    await expect(mute).toHaveAttribute("aria-pressed", "true");
    await mute.click();
    await expect.poll(() => media(tv)).toMatchObject({ muted: false });
    await expect(mute).toHaveAttribute("aria-pressed", "false");

    // The bar sets an absolute level.
    await phone.getByTestId("remote-volume-bar").fill("80");
    await expect.poll(() => media(tv)).toMatchObject({ volume: 0.8, muted: false });
    await expect(row).toHaveAttribute("data-volume", "80");

    // The «Сейчас на ТВ» mini-bar elsewhere in the app: play/pause, «Тише» / «Громче».
    await phone.goto("/");
    await expect(phone.getByTestId("now-on-tv-bar")).toBeVisible({ timeout: 15_000 });
    await expect(phone.getByTestId("bar-playpause")).toBeVisible();
    await phone.getByTestId("bar-volume-down").click();
    await expect.poll(() => media(tv)).toMatchObject({ volume: 0.7 });
    await phone.getByTestId("bar-volume-up").click();
    await expect.poll(() => media(tv)).toMatchObject({ volume: 0.8 });
    await phone.goto(`/remote/${deviceId}`);
    await expect(row).toHaveAttribute("data-volume", "80");

    // Play / pause stays prominent and works.
    await phone.getByRole("button", { name: /^(pause|пауза)$/i }).click();
    await expect.poll(() => media(tv)).toMatchObject({ paused: true });
    await phone.getByRole("button", { name: /^(play|продолжить)$/i }).click();
    await expect.poll(() => media(tv)).toMatchObject({ paused: false });

    // The level is kept per TV.
    expect(JSON.parse((await tv.evaluate(() => localStorage.getItem("martytv.volume")))!)).toEqual({ volume: 0.8, muted: false });
    expect((await postCommand(phone, deviceId, { type: "media.stop" })).ack.ok).toBe(true);
    await expect(tv.getByTestId("player")).toHaveCount(0);

    // --- Samsung's system volume (a fake tizen.tvaudiocontrol): the TV's own level changes, our player stays at 100 %.
    await tvCtx.addInitScript(() => {
      const w = window as unknown as { tizen?: unknown; __vol?: { vol: number; mute: boolean } };
      const s = { vol: 25, mute: false };
      w.__vol = s;
      w.tizen = {
        tvaudiocontrol: {
          getVolume: () => s.vol,
          setVolume: (v: number) => void (s.vol = v),
          setMute: (m: boolean) => void (s.mute = m),
          isMute: () => s.mute,
          setVolumeChangeListener: () => undefined,
          unsetVolumeChangeListener: () => undefined,
        },
      };
    });
    await tv.reload();
    await expect.poll(serverState, { timeout: 30_000 }).toMatchObject({ volume: 0.25, muted: false, volume_source: "system", system_volume: "ok" });
    await expect(phone.getByTestId("remote-volume")).toHaveAttribute("data-source", "system");
    await expect(phone.getByTestId("remote-volume")).toContainText(/tv volume|громкость тв/i);
    await up.click();
    await expect.poll(() => tv.evaluate(() => (window as unknown as { __vol: { vol: number } }).__vol.vol)).toBe(30);
    await expect(phone.getByTestId("remote-volume")).toHaveAttribute("data-volume", "30");
    await mute.click();
    await expect.poll(() => tv.evaluate(() => (window as unknown as { __vol: { mute: boolean } }).__vol.mute)).toBe(true);
    await expect(tv.getByTestId("tv-volume-osd")).toHaveAttribute("data-muted", "1");
  } finally {
    await phone.goto("/devices");
    const card = phone.locator("section", { hasText: deviceName });
    phone.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: /unpair/i }).click();
    await expect(card).toHaveCount(0);
  }
});
