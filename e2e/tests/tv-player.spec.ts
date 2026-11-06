import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { quietHome } from "./quietHome";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

/** A 40 s VP8/Opus WebM (Playwright's Chromium has no H.264). */
const CLIP = readFileSync(new URL("../fixtures/clip.webm", import.meta.url));

interface Ack {
  id: string;
  ok: boolean;
  error?: string;
  result?: Record<string, unknown>;
}

/**
 * Phase 5: keep this run independent of the profile's watch state and
 * settings: no first-run guide, no "Continue watching" row, and playback
 * sessions/progress are not recorded on the real profile.
 */
async function isolateWatch(ctx: BrowserContext) {
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch().catch(() => null);
    const body = res && res.ok() ? await res.json() : {};
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...body, onboarding_completed: true }) });
  });
  const ok = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, (route) => ok(route, { items: [] }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/progress/, (route) => ok(route, { media_id: "x", kind: "movie", movie: null, episodes: [], seasons: [], next_up: null }));
  await ctx.route(/\/api\/v1\/playback\/sessions(\?.*)?$/, (route) =>
    ok(route, { id: "5e550000-0000-4000-8000-00000000ffff", resume_position_seconds: null, progress: null, report_token: "x" }, 201),
  );
  await ctx.route(/\/api\/v1\/playback\/sessions\/[^/]+\/progress/, (route) => ok(route, { accepted: true, progress: null }));
  await ctx.route(/\/api\/v1\/messages(\?.*)?$/, (route) => ok(route, { items: [], unread: 0 }));
}

async function press(tv: Page, key: string, times = 1) {
  for (let i = 0; i < times; i++) {
    await tv.keyboard.press(key);
    await tv.waitForTimeout(160);
  }
}

async function sendCommand(phone: Page, deviceId: string, body: { id?: string; type: string; payload?: unknown }): Promise<Ack> {
  return phone.evaluate(
    async ({ deviceId, body }) => {
      const session = await (await fetch("/api/v1/auth/session")).json();
      const r = await fetch(`/api/v1/devices/${deviceId}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrf_token },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`commands: HTTP ${r.status} ${await r.text()}`);
      return r.json();
    },
    { deviceId, body },
  );
}

// ---------------------------------------------------------------- mocked playback backend

const SRC = {
  good: "5e1f0000-0000-4000-8000-000000000001",
  bad: "5e1f0000-0000-4000-8000-000000000002",
};

function release(id: string, p: Record<string, unknown> = {}) {
  return {
    id,
    title: `Mock.Release.${id}`,
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
    languages: ["en", "ru"],
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
    ...p,
  };
}

const RELEASES = [
  release("rel-good"),
  release("rel-bad", { resolution: "2160p", hdr: "hdr10", video_codec: "hevc", audio_codecs: ["dts"], source_quality: "remux", size_bytes: 58_000_000_000, seeders: 12 }),
  release("rel-cam", { resolution: "720p", source_quality: "cam", seeders: 2, warnings: ["cam_quality", "low_seeders"] }),
];

/** Serves releases, sources (preparing → ready) and the streams for one TV. */
async function mockPlayback(ctx: BrowserContext, mediaId: () => string) {
  const polls = new Map<string, number>();
  const calls = { created: [] as Record<string, unknown>[], streams: 0, refreshes: 0, cancelled: [] as string[] };
  const source = (key: keyof typeof SRC) => {
    const id = SRC[key];
    const n = polls.get(id) ?? 0;
    const ready = n >= 2;
    return {
      id,
      media_id: mediaId(),
      episode_id: null,
      release: RELEASES[key === "good" ? 0 : 1],
      status: ready ? "ready" : "preparing",
      error: null,
      file: ready ? { index: 0, path: `Movie/${key}.webm`, size_bytes: CLIP.length, is_video: true, season: null, episode: null } : null,
      stream_url: ready ? `/api/v1/stream/tok-${key}-${n}` : null,
      stream_expires_at: ready ? new Date(Date.now() + 3600_000).toISOString() : null,
      mime_type: key === "good" ? "video/webm" : "video/x-unknown",
      media_info: ready
        ? {
            container: key === "good" ? "matroska,webm" : null,
            video_codec: key === "good" ? "vp8" : null,
            width: 320,
            height: 180,
            duration_seconds: 40,
            audio: key === "good" ? [{ index: 1, codec: "opus", language: "en", title: null, channels: 1, default: true }] : [],
            subtitles: [{ index: 2, codec: "subrip", language: "ru", title: "Forced", channels: null, default: false }],
          }
        : null,
      // Peers change on every fetch, so a test can see the numbers update live.
      torrent: { peers: ready ? 14 + n : 3, seeders: 9, download_speed_bps: 3_200_000, preloaded_bytes: n * 18_000_000 },
      created_at: new Date().toISOString(),
    };
  };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  // Online sources answer live in dev: keep Details hermetic (no «Смотреть онлайн» button).
  await ctx.route(/\/api\/v1\/media\/[^/]+\/online/, (route) => json(route, { items: [], providers: [], searched_at: new Date().toISOString(), cached: true }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) =>
    json(route, { items: RELEASES, searched_at: new Date().toISOString(), cached: false, indexer_errors: [{ indexer: "SlowTracker", message: "timeout" }] }),
  );
  await ctx.route(/\/api\/v1\/playback\/sources(\/[^/?]+)?(\?.*)?$/, async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      const body = req.postDataJSON() as Record<string, unknown>;
      calls.created.push(body);
      const key = body.release_id === "rel-good" ? "good" : "bad";
      polls.set(SRC[key], 0);
      return json(route, source(key), 201);
    }
    const id = new URL(req.url()).pathname.split("/").pop()!;
    if (req.method() === "DELETE") {
      calls.cancelled.push(id);
      return route.fulfill({ status: 204 });
    }
    const key = id === SRC.good ? "good" : id === SRC.bad ? "bad" : null;
    if (!key) return json(route, { error: { code: "not_found", message: "no source" } }, 404);
    const n = (polls.get(id) ?? 1) + 1;
    polls.set(id, n);
    if (key === "bad" && n > 2) calls.refreshes++;
    return json(route, source(key));
  });
  // Server load for the stats panel under Up.
  await ctx.route(/\/api\/v1\/status$/, (route) =>
    json(route, { torrserver: { ok: true, latency_ms: 4 }, prowlarr: { ok: true }, active_streams: 2, server_time: new Date().toISOString(), seasonal_effects: false, cpu_percent: 37.2 }),
  );
  await ctx.route(/\/api\/v1\/stream\//, (route) => {
    calls.streams++;
    const good = route.request().url().includes("tok-good");
    const body = good ? CLIP : Buffer.from("this is not a video file ".repeat(400));
    const type = good ? "video/webm" : "video/x-unknown";
    // Like the real proxy: HTTP Range support (needed for seeking).
    const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers()["range"] ?? "");
    if (!m) return route.fulfill({ status: 200, headers: { "Content-Type": type, "Accept-Ranges": "bytes" }, body });
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
    return route.fulfill({
      status: 206,
      headers: { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${body.length}` },
      body: body.subarray(start, end + 1),
    });
  });
  return calls;
}

const video = (tv: Page) => tv.locator("[data-testid=player] video");
const currentTime = (tv: Page) => video(tv).evaluate((v: HTMLVideoElement) => v.currentTime);
const isPaused = (tv: Page) => video(tv).evaluate((v: HTMLVideoElement) => v.paused);

/**
 * Phase 4 TV acceptance: Details → Play → release picker → preparing →
 * playing; OK pauses, Right seeks, the state reaches the server, Back exits
 * to Details; media.play with a source from the phone plays, a second one is
 * busy_playing; an unplayable file offers another release; MSX hand-off.
 */
test("TV player: picker, preparing, playback, remote commands, unplayable", async ({ browser }) => {
  test.setTimeout(180_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
  await quietHome(tvCtx);
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
    const r = await phoneCtx.request.post("/api/v1/profiles", {
      data: { name: "E2E", color: "#6366f1" },
      headers: { "X-CSRF-Token": session.csrf_token, Origin: origin },
    });
    expect(r.ok()).toBeTruthy();
  }
  const search = await (await phoneCtx.request.get(`/api/v1/catalog/search?q=${encodeURIComponent("The Matrix")}&kind=movie&lang=en`)).json();
  const movieId = search.items[0].id as string;
  const calls = await mockPlayback(tvCtx, () => movieId);

  // Pair the TV.
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Player TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  try {
    const devices = await (await phoneCtx.request.get("/api/v1/devices")).json();
    const deviceId = devices.items.find((d: { name: string }) => d.name === deviceName).id as string;
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");
    await expect(tv.getByText("Trending this week")).toBeVisible({ timeout: 30_000 });
    const serverState = async () => (await (await phoneCtx.request.get(`/api/v1/devices/${deviceId}/state`)).json()).state;

    // --- Details → ☰ (sources, next to Play) → release picker (best match first and focused).
    expect((await sendCommand(phone, deviceId, { type: "media.open", payload: { media_id: movieId } })).ok).toBe(true);
    const details = tv.locator("[data-media-id]");
    await expect(tv.locator("[data-media-id] h1")).not.toBeEmpty({ timeout: 20_000 });
    await expect(tv.locator("[data-media-id] .is-focused")).toContainText(/play/i);
    // The auto-selected source (the best release) is shown under the buttons.
    await expect(tv.getByTestId("source-line")).toHaveAttribute("data-status", "ok", { timeout: 15_000 });
    await expect(tv.locator("[data-testid=source-line] [data-release-id]")).toHaveAttribute("data-release-id", "rel-good");
    await press(tv, "ArrowRight");
    await press(tv, "Enter");
    const rows = tv.locator("[data-testid=release-picker] [data-release-id]");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveClass(/is-focused/);
    await expect(rows.nth(0)).toContainText("Best match");
    await expect(rows.nth(1)).toContainText("4K");
    await expect(rows.nth(2)).toContainText(/camera recording/i);
    await expect(tv.getByTestId("release-picker")).toContainText("SlowTracker");
    // Fit chips for this TV: H.264/AAC plays; DTS (no browser decodes it) can't, or the server converts it.
    await expect(rows.nth(0).locator('[data-fit="plays"]')).toHaveText("✓ Will play");
    await expect(rows.nth(1).locator("[data-fit-verdict]")).toHaveAttribute("data-fit-verdict", /^(bad|convert)$/);

    // --- Back while it prepares cancels it (the server stops loading too); OK again.
    await press(tv, "Enter");
    await expect(tv.getByTestId("player-preparing")).toBeVisible();
    await press(tv, "Escape");
    await expect(tv.getByTestId("release-picker")).toBeVisible();
    await expect.poll(() => calls.cancelled).toEqual([SRC.good]);
    await tv.waitForTimeout(2500);
    await expect(tv.getByTestId("player")).toHaveCount(0);
    calls.created.length = 0;

    // --- OK: preparing (live torrent stats) → playing.
    await press(tv, "Enter");
    await expect(tv.getByTestId("player-preparing")).toBeVisible();
    await expect(tv.getByTestId("player-preparing")).toContainText(/peers/i);
    await expect(tv.getByTestId("player-preparing")).toContainText(/seeders/i);
    // What is loading: the release's quality line (resolution · … · size).
    await expect(tv.getByTestId("loader-quality")).toContainText(/1080p|2160p|720p|4K/);
    await expect(tv.getByTestId("player-preparing")).toHaveCount(0, { timeout: 15_000 });
    expect(calls.created[0]).toMatchObject({ media_id: movieId, release_id: "rel-good" });
    expect(calls.created[0]!.profile_id).toBeTruthy();
    await expect.poll(() => currentTime(tv), { timeout: 15_000 }).toBeGreaterThan(1.5);
    // Playing: Up toggles the controls (shown → hidden → shown).
    const ctl = tv.getByTestId("player-controls");
    if (await ctl.count()) {
      await press(tv, "ArrowUp");
      await expect(ctl).toHaveCount(0);
    }
    await press(tv, "ArrowUp");
    await expect(ctl).toBeVisible();
    await press(tv, "ArrowUp");
    await expect(ctl).toHaveCount(0);
    await press(tv, "ArrowUp");
    await expect(ctl).toBeVisible();
    // Under Up: peers, peer speed, server load and the link to this TV.
    const net = tv.getByTestId("player-netstats");
    await expect(net.locator("[data-stat=peers]")).toContainText(/peers/i);
    await expect(net.locator("[data-stat=from_peers]")).toContainText(/from peers/i);
    await expect(net.locator("[data-stat=server]")).toHaveText("Server: CPU 37% · streams 2");
    // …and the live peers / seeds / speed line, while playing too (not only paused).
    await expect(tv.getByTestId("player-controls").getByTestId("player-stats")).toContainText(/seeders/i);
    // «Show buffer»: off by default; on → stripe + label with the controls, a chip without them.
    await expect(tv.getByTestId("player-buffer")).toHaveCount(0);
    await tv.evaluate(() => localStorage.setItem("martytv.show_prebuffer", "1"));
    await expect(tv.getByTestId("player-buffer")).toContainText(/Buffer \d+ s/);
    await expect(tv.getByTestId("player-buffer-stripe")).toHaveCount(1);
    await press(tv, "ArrowUp");
    await expect(ctl).toHaveCount(0);
    await expect(tv.getByTestId("player-buffer-chip")).toContainText(/Buffer \d+ s/);
    await tv.evaluate(() => localStorage.setItem("martytv.show_prebuffer", "0"));
    await press(tv, "ArrowUp");
    await expect(ctl).toBeVisible();
    await expect(tv.getByTestId("player-buffer")).toHaveCount(0);

    // --- OK pauses; Right seeks forward 30 s (with a preview first).
    await press(tv, "Enter");
    await expect.poll(() => isPaused(tv)).toBe(true);
    await expect(tv.getByTestId("player")).toHaveAttribute("data-paused", "1");
    // Paused: what plays and how it loads, with live peers/seeds/speed on top.
    const stats = tv.getByTestId("player-stats");
    await expect(stats).toContainText(/seeders/i);
    await expect(stats).toContainText(/1080p|2160p|720p|4K/);
    const first = await stats.textContent();
    await expect.poll(async () => stats.textContent(), { timeout: 10_000 }).not.toBe(first);
    // Paused: Up hides the overlay to look at the frame; Up again brings it back.
    await expect(tv.getByTestId("player-controls")).toBeVisible();
    await press(tv, "ArrowUp");
    await expect(tv.getByTestId("player-controls")).toHaveCount(0);
    await expect(tv.getByTestId("player")).toHaveAttribute("data-paused", "1");
    await press(tv, "ArrowUp");
    await expect(tv.getByTestId("player-controls")).toBeVisible();
    const t0 = await currentTime(tv);
    await tv.keyboard.press("ArrowRight");
    await expect(tv.getByTestId("player-time")).toHaveClass(/text-accent/);
    await expect.poll(() => currentTime(tv), { timeout: 5_000 }).toBeGreaterThan(t0 + 20);

    // --- The state reaches the server (TV is the authority).
    await expect
      .poll(serverState, { timeout: 15_000 })
      .toMatchObject({
        screen: "player",
        media_id: movieId,
        players: ["builtin"],
        playback: { media_id: movieId, source_id: SRC.good, paused: true, duration_seconds: 40, audio_track_id: "a0" },
      });
    expect((await serverState()).playback.position_seconds).toBeGreaterThan(20);

    // --- Tracks panel lists audio + subtitles from media_info.
    await press(tv, "ArrowDown");
    await expect(tv.getByTestId("player-tracks")).toContainText("Audio");
    // The Down panel keeps the title and live loading stats on top.
    await expect(tv.getByTestId("player-panel-top").getByTestId("player-stats")).toContainText(/seeders/i);
    await expect(tv.getByTestId("player-panel-top").locator("[data-stat=peers]")).toBeVisible();
    await expect(tv.getByTestId("player-tracks")).toContainText("Русский · Forced");
    await press(tv, "Escape");
    await expect(tv.getByTestId("player-tracks")).toHaveCount(0);

    // --- Paused overlay: closing the panel leaves it folded; Up shows it
    // (controls + pause badge), Up folds it, Up shows it again; Back folds it
    // without leaving the player; the next Back exits.
    const controls = tv.getByTestId("player-controls");
    const badge = tv.getByTestId("player-pause-badge");
    await expect(controls).toHaveCount(0);
    await expect(badge).toHaveCount(0);
    await press(tv, "ArrowUp");
    await expect(controls).toBeVisible();
    await expect(badge).toBeVisible();
    await press(tv, "ArrowUp");
    await expect(controls).toHaveCount(0);
    await expect(badge).toHaveCount(0);
    await press(tv, "ArrowUp");
    await expect(controls).toBeVisible();
    await press(tv, "Escape");
    await expect(controls).toHaveCount(0);
    await expect(badge).toHaveCount(0);
    await expect(tv.getByTestId("player")).toHaveCount(1);
    await expect(tv.getByTestId("player")).toHaveAttribute("data-paused", "1");

    // --- Back again exits to Details and frees the stream.
    await press(tv, "Escape");
    await expect(tv.getByTestId("player")).toHaveCount(0);
    await expect(details).toHaveAttribute("data-media-id", movieId);
    await expect(tv.locator("[data-media-id] .is-focused")).toContainText(/play/i);
    await expect.poll(serverState).toMatchObject({ screen: "details", playback: null });

    // --- media.play with a source prepared on the phone plays at a position.
    const play = await sendCommand(phone, deviceId, { type: "media.play", payload: { media_id: movieId, source_id: SRC.good, position_seconds: 12 } });
    expect(play.ok, JSON.stringify(play)).toBe(true);
    expect(play.result).toMatchObject({ screen: "player", media_id: movieId, playback: { media_id: movieId } });
    await expect.poll(() => currentTime(tv), { timeout: 15_000 }).toBeGreaterThan(12.5);
    // A second media.play without force is refused; the phone must confirm.
    const busy = await sendCommand(phone, deviceId, { type: "media.play", payload: { media_id: movieId } });
    expect(busy).toMatchObject({ ok: false, error: "busy_playing" });
    // Remote controls answer with the new state.
    const paused = await sendCommand(phone, deviceId, { type: "media.pause" });
    expect(paused).toMatchObject({ ok: true, result: { screen: "player", playback: { paused: true } } });
    // Pause shows the overlay; resume (no key on the TV) hides it after a while.
    await expect(tv.getByTestId("player-controls")).toBeVisible();
    await tv.waitForTimeout(5_000);
    expect(await sendCommand(phone, deviceId, { type: "media.resume" })).toMatchObject({ ok: true });
    await expect(tv.getByTestId("player-controls")).toHaveCount(0, { timeout: 7_000 });
    expect(await sendCommand(phone, deviceId, { type: "media.pause" })).toMatchObject({ ok: true });
    const seek = await sendCommand(phone, deviceId, { type: "media.seek", payload: { position_seconds: 5 } });
    expect(seek).toMatchObject({ ok: true, result: { playback: { position_seconds: 5 } } });
    const subs = await sendCommand(phone, deviceId, { type: "playback.set_subtitles", payload: { track_id: "s0" } });
    expect(subs).toMatchObject({ ok: false, error: "unsupported" });
    const next = await sendCommand(phone, deviceId, { type: "media.next_episode" });
    expect(next).toMatchObject({ ok: false, error: "failed" });
    const stop = await sendCommand(phone, deviceId, { type: "media.stop" });
    expect(stop).toMatchObject({ ok: true, result: { screen: "details", playback: null } });
    await expect(tv.getByTestId("player")).toHaveCount(0);

    // --- An unplayable file: the error says why and offers another release.
    await press(tv, "ArrowRight"); // ☰ sources
    await press(tv, "Enter");
    await expect(rows.nth(0)).toHaveClass(/is-focused/);
    await expect(rows.nth(0)).toContainText("Last played");
    await press(tv, "ArrowDown");
    await expect(rows.nth(1)).toHaveClass(/is-focused/);
    await press(tv, "Enter");
    const failed = tv.getByTestId("player-failed");
    await expect(failed).toBeVisible({ timeout: 20_000 });
    await expect(failed).toHaveAttribute("data-code", "unplayable");
    await expect(tv.getByTestId("player-failed-text")).toContainText(/can't play this file/i);
    await expect(failed.locator(".is-focused")).toHaveText("Try another release");
    await expect(failed).toContainText(/next try: 1080p/i);
    expect(calls.refreshes).toBeGreaterThan(0);
    // Back returns to the picker with the failed release dimmed.
    await press(tv, "Escape");
    await expect(rows.nth(1)).toHaveClass(/opacity-50/);
    await press(tv, "Escape");
    await expect(details).toHaveAttribute("data-media-id", movieId);

    // --- Media Station X: hand-off through the bridge (simulated in the page).
    await tv.evaluate(() => {
      const w = window as unknown as { __msx: unknown[] };
      w.__msx = [];
      localStorage.setItem("martytv.msx_bridge", JSON.stringify({ alive_at: Date.now() }));
      const ch = new BroadcastChannel("martytv-msx");
      ch.onmessage = (e) => {
        const m = e.data as { type: string; id: string };
        if (m.type !== "play") return;
        w.__msx.push(m);
        ch.postMessage({ type: "ack", id: m.id, ok: true });
      };
      setInterval(() => localStorage.setItem("martytv.msx_bridge", JSON.stringify({ alive_at: Date.now() })), 4000);
    });
    const msx = await sendCommand(phone, deviceId, { type: "media.play", payload: { media_id: movieId, source_id: SRC.good, player: "msx" } });
    expect(msx.ok, JSON.stringify(msx)).toBe(true);
    await expect(tv.getByTestId("player-handed-off")).toContainText(/media station x/i, { timeout: 15_000 });
    const sent = (await tv.evaluate(() => (window as unknown as { __msx: { url: string; title: string }[] }).__msx))[0]!;
    expect(sent.url).toMatch(/^http:\/\/[^/]+\/api\/v1\/stream\/tok-good-\d+\/good\.webm$/);
    expect(sent.title).toBeTruthy();
    expect(await sendCommand(phone, deviceId, { type: "media.pause" })).toMatchObject({ ok: false, error: "unsupported" });
    await expect.poll(serverState).toMatchObject({ screen: "player", players: ["builtin", "msx"], playback: { paused: false, position_seconds: 0 } });
    await press(tv, "Escape");
    await expect(details).toHaveAttribute("data-media-id", movieId);
  } finally {
    await phone.goto("/devices");
    const card = phone.locator("section", { hasText: deviceName });
    phone.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: /unpair/i }).click();
    await expect(card).toHaveCount(0);
  }
});

/**
 * Series: the overlay shows which episodes are around (⏮ S01E01 · S01E03 ⏭),
 * ▼ opens «Episodes» on «Next episode», OK plays it, the remote's ⏮ goes back.
 */
test("TV player: previous / next episode from the overlay", async ({ browser }) => {
  test.setTimeout(150_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
  await quietHome(tvCtx);
  await isolateWatch(tvCtx);
  const phone = await phoneCtx.newPage();
  const tv = await tvCtx.newPage();
  await phone.goto("/login");
  await phone.getByLabel(/username/i).fill(USER);
  await phone.getByLabel(/password/i).fill(PASS);
  await phone.getByRole("button", { name: /sign in/i }).click();
  await expect(phone.getByRole("heading", { name: /welcome/i })).toBeVisible();

  const search = await (await phoneCtx.request.get(`/api/v1/catalog/search?q=${encodeURIComponent("Breaking Bad")}&kind=series&lang=en`)).json();
  const seriesId = search.items[0].id as string;
  await phoneCtx.request.get(`/api/v1/media/${seriesId}?lang=en`);
  const season = await (await phoneCtx.request.get(`/api/v1/media/${seriesId}/seasons/1?lang=en`)).json();
  const ep2 = season.episodes.find((e: { episode_number: number }) => e.episode_number === 2).id as string;
  await mockPlayback(tvCtx, () => seriesId);

  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Episodes TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });
  try {
    const devices = await (await phoneCtx.request.get("/api/v1/devices")).json();
    const deviceId = devices.items.find((d: { name: string }) => d.name === deviceName).id as string;
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");
    await expect(tv.getByText("Trending this week")).toBeVisible({ timeout: 30_000 });

    const play = await sendCommand(phone, deviceId, { type: "media.play", payload: { media_id: seriesId, episode_id: ep2, source_id: SRC.good } });
    expect(play.ok, JSON.stringify(play)).toBe(true);
    await expect.poll(() => currentTime(tv), { timeout: 20_000 }).toBeGreaterThan(1);

    const ctl = tv.getByTestId("player-controls");
    // Shows the controls (they hide by themselves after a few seconds) and checks the episode.
    const showing = async (code: string) =>
      expect(async () => {
        if (!(await ctl.count())) await press(tv, "ArrowUp");
        await expect(ctl).toContainText(code, { timeout: 1500 });
      }).toPass({ timeout: 30_000 });
    await showing("S01E02");
    const nav = tv.getByTestId("player-episode-nav");
    await expect(nav).toContainText("S01E01");
    await expect(nav).toContainText("S01E03");

    // ▼: «Episodes» first, focused on «Next episode»; OK plays it.
    await press(tv, "ArrowDown");
    const panel = tv.getByTestId("player-tracks");
    await expect(panel).toContainText("Episodes");
    await expect(panel.locator(".bg-text")).toContainText(/next episode · S01E03/i);
    await press(tv, "Enter");
    await expect(panel).toHaveCount(0);
    await expect.poll(() => currentTime(tv), { timeout: 30_000 }).toBeGreaterThan(1);
    await showing("S01E03");

    // The remote's ⏮: back to S01E02.
    await tv.keyboard.press("MediaTrackPrevious");
    await expect.poll(() => currentTime(tv), { timeout: 30_000 }).toBeGreaterThan(1);
    await showing("S01E02");
  } finally {
    await phone.goto("/devices");
    const card = phone.locator("section", { hasText: deviceName });
    phone.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: /unpair/i }).click();
    await expect(card).toHaveCount(0);
  }
});
