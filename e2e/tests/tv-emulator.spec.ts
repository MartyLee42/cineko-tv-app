// The TV emulator (tvEmulator.ts): the TV app on a throttled CPU with TV
// video-engine quirks, checked frame by frame for what a viewer sees:
//  1. start-up: the boot screen / intro never flash back once Home showed;
//  2. the loading screen's percentage never goes back, and the bar doesn't
//     bounce between 0 and the resume spot while the start seek lands;
//  3. the internet dropping mid-film never runs the bar to the end.
// Run alone: `make tv-emu` (TV_CPU=4 / 6 / 10 for a faster / slower TV).
import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { quietHome } from "./quietHome";
import { barBounces, emulateTv, flashesAfterHome, loadDrops, takeBlinks, takeLog, timeline, TV_CPU } from "./tvEmulator";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

/** 5 minutes of a VP8 test pattern, no sound (long enough to tell a jump from the credits). */
const FILM = readFileSync(new URL("../fixtures/film-5min.webm", import.meta.url));
const FILM_SECONDS = 300;
const SOURCE_ID = "5e1f0000-0000-4000-8000-0000000000e1";
/** The stream comes in small pieces (like a torrent being fetched), so a dead link really stops it. */
const PIECE = 48 * 1024;

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** One source that prepares over a few polls (the loading screen's stages), then streams FILM. */
async function mockPlayback(ctx: BrowserContext, mediaId: () => string) {
  const net = { offline: false, polls: 0 };
  const release = {
    id: "rel-emu",
    title: "Emu.Film.1080p",
    indexer: "MockTracker",
    size_bytes: 2_400_000_000,
    seeders: 50,
    leechers: 2,
    published_at: null,
    info_hash: null,
    resolution: "1080p",
    video_codec: "vp8",
    hdr: null,
    audio_codecs: [],
    languages: ["en"],
    release_group: "EMU",
    source_quality: "web-dl",
    year: 1999,
    seasons: [],
    episodes: [],
    is_season_pack: false,
    confidence: 0.97,
    score: 10,
    reasons: [],
    warnings: [],
  };
  const source = () => {
    const n = net.polls;
    const ready = n >= 6;
    return {
      id: SOURCE_ID,
      media_id: mediaId(),
      episode_id: null,
      release,
      status: ready ? "ready" : "preparing",
      error: null,
      file: ready ? { index: 0, path: "Film/film.webm", size_bytes: FILM.length, is_video: true, season: null, episode: null } : null,
      stream_url: ready ? `/api/v1/stream/emu-${n}` : null,
      stream_expires_at: ready ? new Date(Date.now() + 3600_000).toISOString() : null,
      mime_type: "video/webm",
      media_info: ready
        ? { container: "matroska,webm", video_codec: "vp8", width: 160, height: 90, duration_seconds: FILM_SECONDS, audio: [], subtitles: [] }
        : null,
      // Preloaded bytes wobble like TorrServer's (they drop when another read position opens).
      torrent: { peers: 10 + n, seeders: 9, download_speed_bps: 3_000_000, preloaded_bytes: Math.max(0, n * 5_000_000 - (n % 2) * 4_000_000) },
      created_at: new Date().toISOString(),
    };
  };
  const dead = (route: Route) => route.abort("internetdisconnected");
  await ctx.route(/\/api\/v1\/media\/[^/]+\/online/, (route) => json(route, { items: [], providers: [], searched_at: new Date().toISOString(), cached: true }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) => json(route, { items: [release], searched_at: new Date().toISOString(), cached: false, indexer_errors: [] }));
  await ctx.route(/\/api\/v1\/playback\/sources(\/[^/?]+)?(\?.*)?$/, (route) => {
    if (net.offline) return dead(route);
    if (route.request().method() === "DELETE") return route.fulfill({ status: 204 });
    net.polls++;
    return json(route, source(), route.request().method() === "POST" ? 201 : 200);
  });
  await ctx.route(/\/api\/v1\/playback\/sessions(\?.*)?$/, (route) =>
    json(route, { id: "5e550000-0000-4000-8000-00000000eeee", resume_position_seconds: null, progress: null, report_token: "x" }, 201),
  );
  await ctx.route(/\/api\/v1\/playback\/sessions\/[^/]+\/progress/, (route) => (net.offline ? dead(route) : json(route, { accepted: true, progress: null })));
  await ctx.route(/\/api\/v1\/stream\//, (route) => {
    if (net.offline) return dead(route);
    const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers()["range"] ?? "");
    const start = m ? Number(m[1]) : 0;
    const end = Math.min(FILM.length - 1, start + PIECE - 1, m?.[2] ? Number(m[2]) : Infinity);
    return route.fulfill({
      status: 206,
      headers: { "Content-Type": "video/webm", "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${FILM.length}` },
      body: FILM.subarray(start, end + 1),
    });
  });
  return net;
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
      return (await r.json()) as { ok: boolean; error?: string };
    },
    { deviceId, body },
  );
}

test(`TV emulator (CPU ×${TV_CPU}): no start-up flash, steady loading, no jump to the end offline`, async ({ browser }, info) => {
  test.setTimeout(300_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
  await quietHome(tvCtx);
  const phone = await phoneCtx.newPage();
  const tv = await tvCtx.newPage();
  await emulateTv(tvCtx, tv, { slowSeekMs: 1500, dropStartSeek: true });
  const report = (name: string, body: string) => info.attach(name, { body, contentType: "text/plain" });

  await phone.goto("/login");
  await phone.getByLabel(/username/i).fill(USER);
  await phone.getByLabel(/password/i).fill(PASS);
  await phone.getByRole("button", { name: /sign in/i }).click();
  await expect(phone.getByRole("heading", { name: /welcome/i })).toBeVisible();
  const origin = new URL(phone.url()).origin;
  const session = await (await phoneCtx.request.get("/api/v1/auth/session")).json();
  const profiles = await (await phoneCtx.request.get("/api/v1/profiles")).json();
  if (profiles.items.length === 0) {
    await phoneCtx.request.post("/api/v1/profiles", { data: { name: "E2E", color: "#6366f1" }, headers: { "X-CSRF-Token": session.csrf_token, Origin: origin } });
  }
  const search = await (await phoneCtx.request.get(`/api/v1/catalog/search?q=${encodeURIComponent("The Matrix")}&kind=movie&lang=en`)).json();
  const movieId = search.items[0].id as string;
  const net = await mockPlayback(tvCtx, () => movieId);

  // Pair.
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/, { timeout: 60_000 });
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Emulator TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 30_000 });
  const devices = await (await phoneCtx.request.get("/api/v1/devices")).json();
  const deviceId = devices.items.find((d: { name: string }) => d.name === deviceName).id as string;

  try {
    // --- 1. Start-up, a few times (the flash came «not every time»), with the intro.
    for (let run = 1; run <= 3; run++) {
      await tv.goto("/tv/?intro=1");
      // The profile pick (when the server has several), then Home — both slow on a slow TV.
      // Not while the intro shows: any key just skips it.
      await expect
        .poll(
          async () => {
            if ((await tv.locator("[data-screen=home]").count()) > 0) return "home";
            const intro = await tv.locator("[data-testid^=startup-intro]").count();
            if (!intro && (await tv.getByRole("heading", { name: /who's watching/i }).isVisible())) await tv.keyboard.press("Enter");
            return "waiting";
          },
          { timeout: 90_000, intervals: [1_500] },
        )
        .toBe("home");
      await expect(tv.locator("[data-screen=home]")).toBeVisible({ timeout: 60_000 });
      // Long enough for a late reload / re-shown intro / boot screen.
      await tv.waitForTimeout(8_000);
      const log = await takeLog(tv);
      await report(`boot-${run}.txt`, timeline(log));
      expect(flashesAfterHome(log), `start-up #${run}:\n${timeline(log)}`).toEqual([]);
    }

    // --- 1b. A Home row: right through it and back — posters already shown never blink.
    await expect(tv.locator("[data-card-id] img").first()).toBeVisible({ timeout: 30_000 });
    await tv.waitForTimeout(3_000);
    await takeBlinks(tv);
    for (const key of ["ArrowRight", "ArrowLeft"]) {
      for (let i = 0; i < 16; i++) {
        await tv.keyboard.press(key);
        await tv.waitForTimeout(250);
      }
      await tv.waitForTimeout(2_000);
    }
    const blinks = await takeBlinks(tv);
    expect(blinks, "posters that came back hidden").toEqual([]);

    // --- 2. Play from 120 s: the loading screen, then the start seek (dropped once, slow to land).
    await takeLog(tv);
    const play = await sendCommand(phone, deviceId, { type: "media.play", payload: { media_id: movieId, source_id: SOURCE_ID, position_seconds: 120 } });
    expect(play.ok, JSON.stringify(play)).toBe(true);
    await expect.poll(() => tv.evaluate(() => (window as unknown as { __playerBar: () => { started: boolean } }).__playerBar().started), { timeout: 90_000 }).toBe(true);
    await tv.waitForTimeout(8_000);
    const start = await takeLog(tv);
    await report("loading.txt", timeline(start));
    expect(loadDrops(start), `loading %:\n${timeline(start)}`).toEqual([]);
    expect(Math.max(...start.map((s) => s.loaderMounts)), `the loading screen remounted:\n${timeline(start)}`).toBeLessThanOrEqual(1);
    expect(barBounces(start, 120), `bar bounced:\n${timeline(start)}`).toEqual([]);
    const playingAt = await tv.evaluate(() => (window as unknown as { __playerBar: () => { pos: number } }).__playerBar().pos);
    expect(playingAt).toBeGreaterThan(115);
    expect(playingAt).toBeLessThan(150);

    // --- 3. The internet goes: the engine leaps to the end of the file / takes the cut for its length.
    for (const mode of ["end", "shrink"] as const) {
      const before = await tv.evaluate(() => (window as unknown as { __playerBar: () => { pos: number } }).__playerBar().pos);
      net.offline = true;
      await tvCtx.setOffline(true);
      await tv.evaluate((m) => (window as unknown as { __tvEngine: { cut(m: string): void } }).__tvEngine.cut(m), mode);
      await tv.waitForTimeout(6_000);
      const cut = await takeLog(tv);
      await report(`offline-${mode}.txt`, timeline(cut));
      const ran = cut.filter((s) => s.pos !== null && (s.pos > before + 30 || (s.dur !== null && s.pos >= s.dur - 5) || (s.dur !== null && s.dur < FILM_SECONDS - 10)));
      expect(ran, `offline (${mode}) from ${before}s:\n${timeline(cut)}`).toEqual([]);
      // Back online: it carries on near where it was (or offers another release), never at the end.
      net.offline = false;
      await tvCtx.setOffline(false);
      await tv.waitForTimeout(10_000);
      const back = await takeLog(tv);
      await report(`online-again-${mode}.txt`, timeline(back));
      const bar = await tv.evaluate(() => (window as unknown as { __playerBar: () => { phase: string; pos: number } }).__playerBar());
      if (bar.phase === "playing") {
        expect(bar.pos).toBeGreaterThan(before - 10);
        expect(bar.pos).toBeLessThan(before + 40);
      } else {
        // Gave up while offline: the failed screen (it keeps the spot for «Другая раздача»).
        await expect(tv.getByTestId("player-failed")).toBeVisible();
        break;
      }
    }
  } finally {
    await phoneCtx.request.delete(`/api/v1/devices/${deviceId}`, { headers: { "X-CSRF-Token": session.csrf_token, Origin: origin } }).catch(() => undefined);
    await phoneCtx.close();
    await tvCtx.close();
  }
});
