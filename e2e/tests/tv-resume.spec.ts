import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { quietHome } from "./quietHome";

// The TV player keeps going whatever the stream does: a stall mid-film
// (the connection hangs) ends by itself, OK / ▶ resume at once, a paused
// film comes back after the screensaver, and the next episode plays
// without a spinner left over it. Catalog, sources and streams are mocked
// (no TMDB needed). The API only checks that the media ids exist (media.play):
// on a dev stack without TMDB insert them once:
//   INSERT INTO media (id, kind, tmdb_id, original_title) VALUES
//     ('a0a0a0a0-0000-4000-8000-00000000c1e0','movie',990001,'Resume Movie'),
//     ('a0a0a0a0-0000-4000-8000-00000000c1e1','series',990002,'Resume Series') ON CONFLICT DO NOTHING;

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

/** A 40 s VP8/Opus WebM (Playwright's Chromium has no H.264). */
const CLIP = readFileSync(new URL("../fixtures/clip.webm", import.meta.url));

const MEDIA = "a0a0a0a0-0000-4000-8000-00000000c1e0";
const SERIES = "a0a0a0a0-0000-4000-8000-00000000c1e1";
const episodeId = (n: number) => `e0e0e0e0-0000-4000-8000-0000000c1e0${n}`;
const SRC = "5e1f0000-0000-4000-8000-00000000c1e0";
const SRC_SERIES = "5e1f0000-0000-4000-8000-00000000c1e9";

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const base = (id: string, kind: "movie" | "series", title: string) => ({
  id,
  kind,
  tmdb_id: kind === "movie" ? 901 : 902,
  title,
  original_title: title,
  year: 2010,
  release_date: "2010-07-16",
  overview: "Overview.",
  poster_path: null,
  backdrop_path: null,
  rating: 8,
  vote_count: 100,
  genre_ids: [],
  tagline: null,
  runtime: 120,
  status: "Released",
  original_language: "en",
  genres: [],
  countries: ["US"],
  cast: [],
  crew: [],
  external_ids: { tmdb: 1, imdb: null, tvdb: null },
  trailer: null,
});

const RELEASE = {
  id: "rel-resume",
  title: "Mock.Release.Resume",
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
  year: 2010,
  seasons: [],
  episodes: [],
  is_season_pack: false,
  confidence: 0.97,
  score: 10,
  reasons: ["title_exact"],
  warnings: [],
};

interface StreamMock {
  /** Bytes the n-th stream URL requested delivers; the rest of it never comes (a dead connection). Later URLs are fine. */
  cuts: number[];
  /** Stream URLs handed out so far (each source poll is a fresh one). */
  urls: Set<string>;
  requests: { url: string; range: string | null }[];
}

/** Mocks the catalog bits the player needs, the playback session, sources (ready at once) and the stream. */
async function mockAll(ctx: BrowserContext, cuts: number[]): Promise<StreamMock> {
  const m: StreamMock = { cuts, urls: new Set(), requests: [] };
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch().catch(() => null);
    const body = res && res.ok() ? await res.json() : {};
    return json(route, { ...body, onboarding_completed: true, autoplay_next_episode: true, autoplay_countdown: false });
  });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, (route) => json(route, { items: [] }));
  await ctx.route(/\/api\/v1\/playback\/sessions(\?.*)?$/, (route) =>
    json(route, { id: "5e550000-0000-4000-8000-00000000c1e0", resume_position_seconds: null, progress: null, report_token: "x" }, 201),
  );
  await ctx.route(/\/api\/v1\/playback\/sessions\/[^/]+\/progress/, (route) => json(route, { accepted: true, progress: null }));
  await ctx.route(/\/api\/v1\/messages(\?.*)?$/, (route) => json(route, { items: [], unread: 0 }));
  await ctx.route(/\/api\/v1\/(catalog|media)\//, (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (path.endsWith("/progress")) return json(route, { media_id: path.split("/")[2], kind: "movie", movie: null, episodes: [], seasons: [], next_up: null });
    if (path.endsWith("/online")) return json(route, { items: [], providers: [], searched_at: new Date().toISOString(), cached: true });
    if (path.endsWith("/releases")) return json(route, { items: [RELEASE], searched_at: new Date().toISOString(), cached: false, indexer_errors: [] });
    if (/\/seasons\/1$/.test(path))
      return json(route, {
        season_number: 1,
        name: "Season 1",
        overview: "",
        air_date: "2020-01-01",
        episode_count: 3,
        poster_path: null,
        media_id: SERIES,
        episodes: [1, 2, 3].map((n) => ({ id: episodeId(n), season_number: 1, episode_number: n, name: `Episode ${n}`, overview: "", air_date: "2020-01-01", runtime: 50, still_path: null, rating: 8 })),
      });
    if (path === `/media/${MEDIA}`) return json(route, base(MEDIA, "movie", "Resume Movie"));
    if (path === `/media/${SERIES}`)
      return json(route, {
        ...base(SERIES, "series", "Resume Series"),
        seasons: [{ season_number: 1, name: "Season 1", overview: "", air_date: "2020-01-01", episode_count: 3, poster_path: null }],
        number_of_seasons: 1,
        number_of_episodes: 3,
      });
    if (path.startsWith("/catalog/") || path.endsWith("/similar") || path.endsWith("/recommendations")) return json(route, { items: [], page: 1, total_pages: 1, total_results: 0 });
    return json(route, { error: { code: "not_found", message: "nf" } }, 404);
  });
  let n = 0;
  const episodes = new Map<string, string | null>();
  const source = (id: string) => {
    const url = `/api/v1/stream/tok-resume-${++n}`;
    m.urls.add(url);
    return {
      id,
      media_id: id === SRC ? MEDIA : SERIES,
      episode_id: episodes.get(id) ?? (id === SRC_SERIES ? episodeId(1) : null),
      release: RELEASE,
      status: "ready",
      error: null,
      file: { index: 0, path: "Movie/clip.webm", size_bytes: CLIP.length, is_video: true, season: null, episode: null },
      stream_url: url,
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
      torrent: { peers: 14, seeders: 9, download_speed_bps: 3_200_000, preloaded_bytes: 18_000_000 },
      created_at: new Date().toISOString(),
    };
  };
  let made = 0;
  await ctx.route(/\/api\/v1\/playback\/sources(\/[^/?]+)?(\?.*)?$/, (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      const body = req.postDataJSON() as { episode_id?: string };
      const id = `5e1f0000-0000-4000-8000-0000000c1e${String(++made).padStart(2, "0")}`;
      episodes.set(id, body.episode_id ?? null);
      return json(route, source(id), 201);
    }
    if (req.method() === "DELETE") return route.fulfill({ status: 204 });
    const id = new URL(req.url()).pathname.split("/").pop()!;
    return json(route, source(id));
  });
  const order: string[] = [];
  await ctx.route(/\/api\/v1\/stream\//, (route) => {
    const url = new URL(route.request().url()).pathname;
    const range = route.request().headers()["range"] ?? null;
    m.requests.push({ url, range });
    if (!order.includes(url)) order.push(url);
    const cut = m.cuts[order.indexOf(url)];
    const rm = /bytes=(\d+)-(\d*)/.exec(range ?? "");
    const start = rm ? Number(rm[1]) : 0;
    let end = rm && rm[2] ? Math.min(Number(rm[2]), CLIP.length - 1) : CLIP.length - 1;
    // The file's tail (WebM cues, needed to seek) is always there, like TorrServer's preloaded end.
    if (cut !== undefined && start < TAIL) {
      // This URL's connection dies at `cut`: what's before arrives, the rest never does.
      if (start >= cut) return; // hangs (never answered)
      end = Math.min(end, cut - 1);
    }
    return route.fulfill({
      status: 206,
      headers: { "Content-Type": "video/webm", "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${CLIP.length}` },
      body: CLIP.subarray(start, end + 1),
    });
  });
  return m;
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
      if (!r.ok) throw new Error(`commands: HTTP ${r.status} ${await r.text()}`);
      return r.json();
    },
    { deviceId, body },
  );
}

const video = (tv: Page) => tv.locator("[data-testid=player] video");
const currentTime = (tv: Page) => video(tv).evaluate((v: HTMLVideoElement) => v.currentTime);
const isPaused = (tv: Page) => video(tv).evaluate((v: HTMLVideoElement) => v.paused);

/** Signs in a phone, pairs a fresh TV, runs `body`, unpairs. */
async function withTv(
  browser: import("@playwright/test").Browser,
  cuts: number[],
  init: (tv: Page) => Promise<void>,
  body: (o: { tv: Page; phone: Page; deviceId: string; m: StreamMock }) => Promise<void>,
) {
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
  await quietHome(tvCtx);
  const m = await mockAll(tvCtx, cuts);
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
  await tv.addInitScript(() => {
    // Shorter waits for the test (production: 30 s rate warm-up).
    (globalThis as { __martytvRateWarmupMs?: number }).__martytvRateWarmupMs = 1000;
  });
  await init(tv);
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Resume TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });
  const devices = await (await phoneCtx.request.get("/api/v1/devices")).json();
  const deviceId = devices.items.find((d: { name: string }) => d.name === deviceName).id as string;
  try {
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await tv.keyboard.press("Enter");
    // RESUME_TRACE=1: the player's state every second (debugging).
    const trace = process.env.RESUME_TRACE
      ? setInterval(() => {
          void tv
            .evaluate(() => {
              const v = document.querySelector("[data-testid=player] video") as HTMLVideoElement | null;
              const ids = Array.from(document.querySelectorAll("[data-testid^=player-], [data-testid^=loader-], [data-testid=screensaver]")).map((e) => e.getAttribute("data-testid"));
              const b = v ? Array.from({ length: v.buffered.length }, (_, i) => `${v.buffered.start(i).toFixed(1)}-${v.buffered.end(i).toFixed(1)}`).join(",") : "";
              return v ? `t=${v.currentTime.toFixed(2)} p=${v.paused} rs=${v.readyState} b=${b} ${ids.join(" ")}` : ids.join(" ");
            })
            .then((x) => console.log(new Date().toISOString().slice(14, 23), x), () => undefined);
        }, 1000)
      : undefined;
    try {
      await body({ tv, phone, deviceId, m });
    } finally {
      clearInterval(trace);
    }
  } finally {
    await phone.goto("/devices");
    const card = phone.locator("section", { hasText: deviceName });
    phone.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: /unpair/i }).click();
    await expect(card).toHaveCount(0);
    await tvCtx.close();
    await phoneCtx.close();
  }
}

/** Waits until the picture stops at the cut (the stall), returns where. */
async function waitForStall(tv: Page): Promise<number> {
  let last = -1;
  let same = 0;
  await expect
    .poll(
      async () => {
        const t = await currentTime(tv);
        same = t > 2 && Math.abs(t - last) < 0.05 ? same + 1 : 0;
        last = t;
        return same;
      },
      { timeout: 40_000, intervals: [500] },
    )
    .toBeGreaterThanOrEqual(3);
  return last;
}

const CUT = Math.floor(CLIP.length * 0.4);
const TAIL = Math.floor(CLIP.length * 0.95);

test("TV player: a stall mid-film (dead connection) continues by itself", async ({ browser }) => {
  test.setTimeout(150_000);
  await withTv(
    browser,
    [CUT],
    async () => {},
    async ({ tv, phone, deviceId, m }) => {
      const play = await sendCommand(phone, deviceId, { type: "media.play", payload: { media_id: MEDIA, source_id: SRC } });
      expect(play.ok, JSON.stringify(play)).toBe(true);
      await expect.poll(() => currentTime(tv), { timeout: 20_000 }).toBeGreaterThan(1);
      const at = await waitForStall(tv);
      const stalled = Date.now();
      // Without a key: the player reopens the stream and goes on, well before anyone reaches for Stop.
      await expect.poll(() => currentTime(tv), { timeout: 25_000 }).toBeGreaterThan(at + 2);
      expect(Date.now() - stalled).toBeLessThan(25_000);
      expect(await isPaused(tv)).toBe(false);
      expect(m.urls.size).toBeGreaterThan(1);
      // Nothing left over the playing film.
      await expect(tv.getByTestId("player-rebuffer")).toHaveCount(0);
      await expect(tv.getByTestId("player-buffering")).toHaveCount(0);
    },
  );
});

test("TV player: OK on a stuck «Buffering…» plays again at once", async ({ browser }) => {
  test.setTimeout(150_000);
  await withTv(
    browser,
    [CUT],
    async () => {},
    async ({ tv, phone, deviceId }) => {
      const play = await sendCommand(phone, deviceId, { type: "media.play", payload: { media_id: MEDIA, source_id: SRC } });
      expect(play.ok, JSON.stringify(play)).toBe(true);
      await expect.poll(() => currentTime(tv), { timeout: 20_000 }).toBeGreaterThan(1);
      const at = await waitForStall(tv);
      // «Buffering…» is up and doesn't move; OK: playing again within a few seconds (not after the 12 s watchdog).
      await expect(tv.getByTestId("player-rebuffer")).toBeVisible({ timeout: 5_000 });
      await tv.waitForTimeout(3000);
      const pressed = Date.now();
      await tv.keyboard.press("Enter");
      await expect.poll(() => currentTime(tv), { timeout: 6_000 }).toBeGreaterThan(at + 1.5);
      expect(Date.now() - pressed).toBeLessThan(6_000);
      expect(await isPaused(tv)).toBe(false);
      await expect(tv.locator("[data-testid=player-rebuffer], [data-testid=player-buffering]")).toHaveCount(0);
    },
  );
});

test("TV player: played into a stall — a spinner, and ▶ plays again", async ({ browser }) => {
  test.setTimeout(150_000);
  await withTv(
    browser,
    [CUT],
    async () => {},
    async ({ tv, phone, deviceId }) => {
      const play = await sendCommand(phone, deviceId, { type: "media.play", payload: { media_id: MEDIA, source_id: SRC } });
      expect(play.ok, JSON.stringify(play)).toBe(true);
      await expect.poll(() => currentTime(tv), { timeout: 20_000 }).toBeGreaterThan(1);
      // OK as soon as «Buffering…» shows: it plays what is buffered — straight into the stall. The picture
      // stands still: a spinner (not a silent frozen frame), still "playing", and ▶ brings it back.
      await expect(tv.getByTestId("player-rebuffer")).toBeVisible({ timeout: 40_000 });
      const at = await currentTime(tv);
      await tv.keyboard.press("Enter");
      await expect(tv.getByTestId("player-buffering")).toBeVisible({ timeout: 5_000 });
      expect(await isPaused(tv)).toBe(false);
      await tv.waitForTimeout(2500);
      const pressed = Date.now();
      await tv.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "MediaPlay", bubbles: true, cancelable: true })));
      await expect.poll(() => currentTime(tv), { timeout: 6_000 }).toBeGreaterThan(at + 1.5);
      expect(Date.now() - pressed).toBeLessThan(6_000);
      expect(await isPaused(tv)).toBe(false);
      await expect(tv.locator("[data-testid=player-rebuffer], [data-testid=player-buffering]")).toHaveCount(0);
    },
  );
});

test("TV player: paused → screensaver → any key → OK plays again", async ({ browser }) => {
  test.setTimeout(150_000);
  await withTv(
    browser,
    [CUT],
    async (tv) => {
      await tv.addInitScript(() => {
        (globalThis as { __martytvPausedSaverMs?: number }).__martytvPausedSaverMs = 3000;
      });
    },
    async ({ tv, phone, deviceId }) => {
      const play = await sendCommand(phone, deviceId, { type: "media.play", payload: { media_id: MEDIA, source_id: SRC } });
      expect(play.ok, JSON.stringify(play)).toBe(true);
      await expect.poll(() => currentTime(tv), { timeout: 20_000 }).toBeGreaterThan(2);
      await tv.keyboard.press("Enter");
      await expect.poll(() => isPaused(tv)).toBe(true);
      const saver = tv.getByTestId("screensaver");
      await expect(saver).toBeVisible({ timeout: 10_000 });
      await expect(tv.locator("html[data-saver-on]")).toHaveCount(1);
      // The waking key only wakes (the film stays paused)…
      await tv.keyboard.press("Enter");
      await expect(saver).toHaveCount(0);
      await expect(tv.locator("html[data-saver-on]")).toHaveCount(0);
      expect(await isPaused(tv)).toBe(true);
      // …the next one plays.
      const t0 = await currentTime(tv);
      await tv.keyboard.press("Enter");
      await expect.poll(() => currentTime(tv), { timeout: 8_000 }).toBeGreaterThan(t0 + 1);
      // Again, with the media ▶ key this time.
      await tv.keyboard.press("Enter");
      await expect.poll(() => isPaused(tv)).toBe(true);
      await expect(saver).toBeVisible({ timeout: 10_000 });
      await tv.keyboard.press("MediaPlayPause");
      await expect(saver).toHaveCount(0);
      const t1 = await currentTime(tv);
      await tv.keyboard.press("MediaPlayPause");
      await expect.poll(() => currentTime(tv), { timeout: 8_000 }).toBeGreaterThan(t1 + 1);
      // The connection died during the pause (only what was buffered plays): soon after a resume a few
      // seconds of nothing are enough to reopen it — on it goes without Stop + Play.
      await expect.poll(() => currentTime(tv), { timeout: 30_000 }).toBeGreaterThan(17);
      expect(await isPaused(tv)).toBe(false);
    },
  );
});

test("TV player: the next episode plays with nothing left over it", async ({ browser }) => {
  test.setTimeout(150_000);
  await withTv(
    browser,
    [],
    async () => {},
    async ({ tv, phone, deviceId }) => {
      // Near the end of S01E01: it ends, autoplay (no countdown) starts S01E02.
      const play = await sendCommand(phone, deviceId, { type: "media.play", payload: { media_id: SERIES, episode_id: episodeId(1), source_id: SRC_SERIES, position_seconds: 34 } });
      expect(play.ok, JSON.stringify(play)).toBe(true);
      await expect.poll(() => currentTime(tv), { timeout: 20_000 }).toBeGreaterThan(34);
      // S01E02 starts from the beginning and plays.
      await expect.poll(() => currentTime(tv), { timeout: 40_000 }).toBeLessThan(10);
      await expect.poll(() => currentTime(tv), { timeout: 30_000 }).toBeGreaterThan(3);
      const overlays = "[data-testid=player-buffering], [data-testid=player-preparing], [data-testid=loader-finale], [data-testid=player-rebuffer]";
      // The loader's end flourish is short (≤ 1.5 s): a few seconds in, nothing covers the picture.
      await tv.waitForTimeout(2500);
      await expect(tv.locator(overlays)).toHaveCount(0);
      // And the episode after that, with the remote's ⏭ — on an engine that never says canplay / playing for
      // the new file (some TV engines): the picture moving is enough to drop the loader.
      await tv.evaluate(() => {
        for (const type of ["canplay", "canplaythrough", "playing"])
          window.addEventListener(type, (e) => e.target instanceof HTMLVideoElement && e.stopImmediatePropagation(), true);
      });
      await tv.keyboard.press("MediaTrackNext");
      await expect.poll(() => currentTime(tv), { timeout: 40_000 }).toBeLessThan(3);
      await expect.poll(() => currentTime(tv), { timeout: 30_000 }).toBeGreaterThan(3);
      await tv.waitForTimeout(2500);
      await expect(tv.locator(overlays)).toHaveCount(0);
    },
  );
});
