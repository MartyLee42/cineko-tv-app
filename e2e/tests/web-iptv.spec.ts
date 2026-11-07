import { mkdirSync, readFileSync } from "node:fs";
import { expect, test, type Browser, type Page, type Route } from "@playwright/test";

// «ТВ» (IPTV) on the web: channel list with chips / search / favorites, the
// per-channel schedule (phone) and the guide grid (desktop), the live player
// («В эфир», channel switching, watched event, MPEG-TS fallback), «Включить
// на ТВ» (iptv.play with busy → force), the Home card and Admin → IPTV.
// Every /iptv, /admin/iptv, /playback/sources and /live call is mocked; the
// live stream is a sliding HLS window over 16 tiny 2 s MPEG-TS segments
// (e2e/fixtures/live). One real login for the whole file (login rate limit).

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
const SHOTS = process.env.IPTV_SHOTS ?? "test-results/iptv-shots";
mkdirSync(SHOTS, { recursive: true });
const STATE = "/tmp/pw-iptv-web-state.json";
const SEG = (n: number) => readFileSync(new URL(`../fixtures/live/seg${n}.ts`, import.meta.url));
const SEGMENTS = 16;
const WINDOW = 10;

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const id = (n: number) => `1b7e0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TV_ID = "de71ce00-0000-4000-8000-0000000000e1";
const PL_RU = "a1a10000-0000-4000-8000-000000000001";

let profileId = "";

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  const page = await browser.newPage({ storageState: { cookies: [], origins: [] }, locale: "en-US" });
  await page.goto("/login");
  await page.getByLabel(/username|имя пользователя/i).fill(USER);
  await page.getByLabel(/password|пароль/i).fill(PASS);
  await page.getByRole("button", { name: /sign in|войти/i }).click();
  await expect(page.getByRole("heading", { name: /welcome|привет/i })).toBeVisible();
  const req = page.context().request;
  const session = await (await req.get("/api/v1/auth/session")).json();
  const headers = { "X-CSRF-Token": session.csrf_token as string, Origin: new URL(page.url()).origin };
  let profiles = (await (await req.get("/api/v1/profiles")).json()).items as { id: string }[];
  if (!profiles.length) {
    expect((await req.post("/api/v1/profiles", { data: { name: "E2E", color: "#6366f1" }, headers })).ok()).toBeTruthy();
    profiles = (await (await req.get("/api/v1/profiles")).json()).items;
  }
  profileId = profiles[0]!.id;
  await req.put(`/api/v1/profiles/${profileId}/settings`, { data: { onboarding_completed: true }, headers });
  await page.evaluate(([u, p]) => {
    localStorage.setItem(`martytv.active_profile.${u}`, p);
    localStorage.setItem("martytv.locale", "ru");
  }, [session.user.id as string, profileId]);
  await page.context().storageState({ path: STATE });
  await page.close();
});

test.use({ storageState: STATE });

// ---------------------------------------------------------------- data

const MIN = 60_000;
function schedule(seed: number, titles: string[]) {
  const t0 = Math.floor(Date.now() / (30 * MIN)) * 30 * MIN - 2 * 60 * MIN;
  const out: { start: string; stop: string; title: string; description: string | null; category: string | null }[] = [];
  let t = t0 + (seed % 3) * 10 * MIN;
  for (let i = 0; t < Date.now() + 8 * 60 * MIN; i++) {
    const len = (30 + ((seed + i) % 3) * 15) * MIN;
    out.push({ start: new Date(t).toISOString(), stop: new Date(t + len).toISOString(), title: titles[i % titles.length]!, description: i % 2 ? "Описание передачи." : null, category: null });
    t += len;
  }
  return out;
}
const nowNext = (s: ReturnType<typeof schedule>) => {
  const i = s.findIndex((p) => Date.parse(p.start) <= Date.now() && Date.now() < Date.parse(p.stop));
  return { now: s[i] ?? null, next: s[i + 1] ?? null };
};

interface Ch {
  id: string;
  number: number;
  name: string;
  group_id: string;
  group: string;
  favorite?: boolean;
  offline?: boolean;
  format?: "hls" | "ts";
  titles: string[];
}
const CHANNELS: Ch[] = [
  { id: id(1), number: 1, name: "Первый канал", group_id: "general", group: "General", titles: ["Новости", "Время покажет", "Поле чудес"] },
  { id: id(2), number: 2, name: "Россия 24", group_id: "news", group: "News", favorite: true, titles: ["Вести", "Экономика", "Погода"] },
  { id: id(3), number: 3, name: "Кино ТВ", group_id: "movies", group: "Movies", titles: ["Брат", "Ирония судьбы", "Москва слезам не верит"] },
  { id: id(4), number: 4, name: "Матч! Арена", group_id: "sports", group: "Sports", offline: true, titles: ["Футбол. РПЛ", "Обзор тура"] },
  { id: id(5), number: 5, name: "Ретро TS", group_id: "g:retro", group: "Ретро", format: "ts", titles: ["Старое кино"] },
  { id: id(6), number: 6, name: "Мульт", group_id: "kids", group: "Kids", titles: ["Смешарики", "Фиксики"] },
];

function channel(c: Ch, favs: Set<string>) {
  const s = schedule(c.number, c.titles);
  return {
    id: c.id, number: c.number, custom_number: null, name: c.name, logo_url: `/api/v1/iptv/logos/${c.id}?v=1`, group_id: c.group_id, group: c.group,
    playlist_id: PL_RU, favorite: favs.has(c.id), hidden: false, offline: !!c.offline, format: c.format ?? "hls", has_epg: true, ...nowNext(s),
  };
}

interface Log {
  prefs: Record<string, unknown>[];
  created: Record<string, unknown>[];
  watched: Record<string, unknown>[];
  commands: { type: string; payload: Record<string, unknown> }[];
  playlistRequests: number;
}

async function mockIptv(page: Page, opts: { busyOnce?: boolean } = {}): Promise<Log> {
  const log: Log = { prefs: [], created: [], watched: [], commands: [], playlistRequests: 0 };
  const favs = new Set(CHANNELS.filter((c) => c.favorite).map((c) => c.id));
  // No socket: commands go over HTTP, where the mock can see them.
  await page.routeWebSocket(/\/api\/v1\/ws/, (ws) => ws.close());

  const list = () => CHANNELS.map((c) => channel(c, favs));
  await page.route(/\/api\/v1\/iptv\/channels(\?.*)?$/, (route) =>
    json(route, {
      items: list(),
      groups: [
        { id: "general", name: "General", count: 1 },
        { id: "news", name: "News", count: 1 },
        { id: "movies", name: "Movies", count: 1 },
        { id: "sports", name: "Sports", count: 1 },
        { id: "g:retro", name: "Ретро", count: 1 },
        { id: "kids", name: "Kids", count: 1 },
      ],
      favorites_count: favs.size,
      last_channel_id: id(3),
      server_time: new Date().toISOString(),
    }),
  );
  await page.route(/\/api\/v1\/iptv\/channels\/[^/]+\/prefs$/, (route) => {
    const body = route.request().postDataJSON() as { favorite?: boolean };
    const cid = new URL(route.request().url()).pathname.split("/")[5]!;
    log.prefs.push({ id: cid, ...body });
    if (body.favorite === true) favs.add(cid);
    if (body.favorite === false) favs.delete(cid);
    return json(route, channel(CHANNELS.find((c) => c.id === cid)!, favs));
  });
  await page.route(/\/api\/v1\/iptv\/channels\/[^/]+\/epg/, (route) => {
    const cid = new URL(route.request().url()).pathname.split("/")[5]!;
    const c = CHANNELS.find((x) => x.id === cid)!;
    return json(route, { items: schedule(c.number, c.titles) });
  });
  await page.route(/\/api\/v1\/iptv\/guide/, (route) => {
    const u = new URL(route.request().url());
    const from = Date.parse(u.searchParams.get("from")!);
    const to = Date.parse(u.searchParams.get("to")!);
    const items = CHANNELS.map((c) => ({
      channel: channel(c, favs),
      programmes: schedule(c.number, c.titles).filter((p) => Date.parse(p.stop) > from && Date.parse(p.start) < to),
    }));
    return json(route, { from: new Date(from).toISOString(), to: new Date(to).toISOString(), total: items.length, offset: 0, items });
  });
  await page.route(/\/api\/v1\/iptv\/state/, (route) =>
    json(route, {
      available: true,
      channel_count: CHANNELS.length,
      last: { channel: channel(CHANNELS[2]!, favs), watched_at: new Date().toISOString() },
      playlists: [
        { id: PL_RU, name: "Россия", channel_count: 5, selected: true },
        { id: "a1a10000-0000-4000-8000-000000000002", name: "Мой провайдер", channel_count: 1, selected: true },
      ],
    }),
  );
  await page.route(/\/api\/v1\/iptv\/watched$/, (route) => {
    log.watched.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 204 });
  });
  await page.route(/\/api\/v1\/iptv\/logos\//, (route) => {
    const cid = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const c = CHANNELS.find((x) => x.id === cid);
    if (!c || c.number === 6) return route.fulfill({ status: 404, body: "" });
    const hue = (c.number * 57) % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="hsl(${hue},70%,45%)"/><text x="32" y="42" font-size="26" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">${c.number}</text></svg>`;
    return route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg });
  });

  let tokens = 0;
  await page.route(/\/api\/v1\/playback\/sources$/, (route) => {
    const body = route.request().postDataJSON() as { channel_id: string };
    log.created.push(body);
    const c = CHANNELS.find((x) => x.id === body.channel_id)!;
    const ts = c.format === "ts";
    tokens++;
    return json(
      route,
      {
        id: `5e1ec7ed-0000-4000-8000-${String(tokens).padStart(12, "0")}`, media_id: null, episode_id: null, release: null, status: "ready", error: null, file: null,
        stream_url: ts ? `/api/v1/live/tok${tokens}/stream.ts` : `/api/v1/live/tok${tokens}/index.m3u8`, stream_expires_at: new Date(Date.now() + 3600_000).toISOString(),
        mime_type: ts ? "video/mp2t" : "application/vnd.apple.mpegurl", media_info: null, torrent: null, created_at: new Date().toISOString(),
        kind: "iptv", live: true, channel_id: c.id, provider: null, format: ts ? "ts" : "hls", quality: null, qualities: [], subtitles: [],
      },
      201,
    );
  });
  // Sliding live window: every playlist reload moves it one segment on.
  await page.route(/\/api\/v1\/live\//, (route) => {
    const file = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (file === "index.m3u8") {
      const seq = Math.min(SEGMENTS - WINDOW, log.playlistRequests++);
      const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:2", `#EXT-X-MEDIA-SEQUENCE:${seq}`];
      for (let i = seq; i < seq + WINDOW; i++) lines.push("#EXTINF:2.000,", `seg${i}.ts`);
      return route.fulfill({ status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-cache" }, body: lines.join("\n") + "\n" });
    }
    const n = Number(/^seg(\d+)\.ts$/.exec(file)?.[1] ?? -1);
    if (n < 0 || n >= SEGMENTS) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, headers: { "Content-Type": "video/mp2t" }, body: SEG(n) });
  });

  // One online TV.
  const now = new Date().toISOString();
  await page.route(/\/api\/v1\/devices(\?.*)?$/, (route) =>
    json(route, { items: [{ id: TV_ID, owner_user_id: TV_ID, owner_username: USER, name: "Гостиная", platform: "tizen", default_profile_id: null, created_at: now, last_seen_at: now, access: "owner", online: true }] }),
  );
  await page.route(/\/api\/v1\/devices\/[^/]+\/state/, (route) => json(route, { online: true, state: null }));
  let busy = !!opts.busyOnce;
  await page.route(/\/api\/v1\/devices\/[^/]+\/commands/, (route) => {
    const body = route.request().postDataJSON() as { type: string; payload: Record<string, unknown> };
    log.commands.push({ type: body.type, payload: body.payload });
    if (busy) {
      busy = false;
      return json(route, { ok: false, error: "busy_playing" });
    }
    return json(route, { ok: true });
  });
  return log;
}

// ---------------------------------------------------------------- phone

test.describe("ТВ on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, locale: "ru-RU", hasTouch: true, isMobile: true });

  test("list, chips, search, favorite, schedule", async ({ page }) => {
    const log = await mockIptv(page);
    await page.goto("/tv-channels");
    const rows = page.getByTestId("channel-row");
    await expect(rows).toHaveCount(6);
    await expect(rows.first().getByTestId("channel-now")).not.toBeEmpty();
    await expect(page.locator("[data-channel-id='" + id(4) + "']")).toHaveAttribute("data-offline", "true");

    // Chips: Все, Избранное, then known groups in their fixed order, the playlist's own group, …
    const chips = page.getByTestId("iptv-chip");
    await expect(chips.first()).toContainText("Все");
    await expect(chips.nth(1)).toContainText("Избранное");
    await expect(chips.nth(2)).toContainText("Новости");
    await expect(chips.nth(3)).toContainText("Кино");
    await expect(chips.nth(4)).toContainText("Спорт");
    await expect(page.locator("[data-testid=iptv-chip][data-group='g:retro']")).toContainText("Ретро");
    await page.screenshot({ path: `${SHOTS}/web-iptv-phone-list.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    await page.locator("[data-testid=iptv-chip][data-group=news]").click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first().getByTestId("channel-name")).toHaveText("Россия 24");
    await page.locator("[data-testid=iptv-chip][data-group=favorites]").click();
    await expect(rows).toHaveCount(1);

    // ★ toggle (optimistic + PATCH with the profile).
    await page.locator("[data-testid=iptv-chip][data-group=all]").click();
    const kino = page.locator(`[data-channel-id='${id(3)}']`);
    await kino.getByTestId("channel-favorite").click();
    await expect(kino.getByTestId("channel-favorite")).toHaveAttribute("aria-pressed", "true");
    expect(log.prefs).toEqual([{ id: id(3), profile_id: profileId, favorite: true }]);
    await page.locator("[data-testid=iptv-chip][data-group=favorites]").click();
    await expect(rows).toHaveCount(2);

    // Search by name (ё-insensitive) and by number.
    await page.locator("[data-testid=iptv-chip][data-group=all]").click();
    await page.getByTestId("iptv-search").fill("матч");
    await expect(rows).toHaveCount(1);
    await page.getByTestId("iptv-search").fill("6");
    await expect(rows.first().getByTestId("channel-name")).toHaveText("Мульт");
    await page.getByTestId("iptv-search").fill("");

    // Tap → sheet → «Программа» (phones: per-channel schedule).
    await rows.nth(1).getByRole("button").first().click();
    const sheet = page.getByTestId("channel-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("channel-watch-here")).toHaveText(/Смотреть здесь/);
    await expect(sheet.getByTestId("channel-play-on-tv")).toHaveText(/Включить на ТВ/);
    await sheet.getByTestId("channel-schedule").click();
    const sched = page.getByTestId("iptv-schedule");
    await expect(sched.getByTestId("schedule-item").first()).toBeVisible();
    await expect(sched.locator("[data-testid=schedule-item][data-live=true]")).toHaveCount(1);
    await expect(sched).toContainText("Сегодня");
    await page.screenshot({ path: `${SHOTS}/web-iptv-phone-schedule.png` });
  });

  test("play here: live player, «В эфир», channel switching, watched event", async ({ page }) => {
    test.setTimeout(90_000);
    const log = await mockIptv(page);
    await page.goto("/tv-channels");
    await page.locator(`[data-channel-id='${id(2)}']`).getByRole("button").first().click();
    await page.getByTestId("channel-watch-here").click();

    const player = page.getByTestId("live-player");
    await expect(player).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`play=${id(2)}`));
    await expect(player.getByTestId("live-channel-name")).toContainText("Россия 24");
    expect(log.created[0]).toEqual({ kind: "iptv", channel_id: id(2), profile_id: profileId });
    const video = page.getByTestId("live-video");
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20_000 }).toBeGreaterThan(1);
    // The sliding playlist is reloaded (live), and no seek bar beyond the live window (it's < 30 s).
    await expect.poll(() => log.playlistRequests, { timeout: 10_000 }).toBeGreaterThan(1);
    await expect(player.getByTestId("live-window")).toHaveCount(0);
    await expect(player.getByTestId("live-osd")).toContainText(/Вести|Экономика|Погода/);
    // «Watched channel» after ~5 s of playback.
    await expect.poll(() => log.watched.length, { timeout: 12_000 }).toBe(1);
    expect(log.watched[0]).toEqual({ profile_id: profileId, channel_id: id(2) });
    await page.mouse.move(100, 100);
    await expect(player.getByTestId("live-osd")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: `${SHOTS}/web-iptv-phone-player.png` });
    // No horizontal overflow on phones.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    // Fall behind the live edge → «В эфир» lights up and jumps back.
    await video.evaluate((v: HTMLVideoElement) => {
      v.currentTime = v.seekable.start(0) + 0.5;
    });
    await page.mouse.move(120, 120);
    const live = player.getByTestId("live-go-live");
    await expect(live).toHaveAttribute("data-behind", "true", { timeout: 8_000 });
    await live.click();
    await expect(live).toHaveAttribute("data-behind", "false", { timeout: 8_000 });

    // Channel up (next number) → Кино ТВ, with a fresh token.
    await player.getByTestId("live-next").click();
    await expect(page).toHaveURL(new RegExp(`play=${id(3)}`));
    await expect(player.getByTestId("live-channel-name")).toContainText("Кино ТВ");
    expect(log.created.at(-1)).toMatchObject({ kind: "iptv", channel_id: id(3) });

    // Number keys jump to a channel.
    await page.keyboard.press("6");
    await expect(player.getByTestId("live-digits")).toHaveText("6");
    await expect(page).toHaveURL(new RegExp(`play=${id(6)}`), { timeout: 5_000 });

    // MPEG-TS channels play through mpegts.js; the mock's bytes aren't a real
    // stream, so it ends in the error, which still offers the TV.
    await page.keyboard.press("5");
    await expect(player.getByTestId("live-error")).toBeVisible({ timeout: 15_000 });
    await expect(player.getByTestId("live-send-to-tv")).toBeVisible();

    await player.getByTestId("live-close").click();
    await expect(player).toHaveCount(0);
  });

  test("«Включить на ТВ»: iptv.play, busy → interrupt → force", async ({ page }) => {
    const log = await mockIptv(page, { busyOnce: true });
    await page.goto("/tv-channels");
    await page.locator(`[data-channel-id='${id(1)}']`).getByRole("button").first().click();
    await page.getByTestId("channel-play-on-tv").click();
    const busy = page.getByTestId("busy-dialog");
    await expect(busy).toBeVisible();
    await page.getByRole("button", { name: /Прервать|Interrupt/ }).click();
    await expect(page.getByTestId("send-result")).toHaveAttribute("data-outcome", "sent");
    expect(log.commands).toEqual([
      { type: "iptv.play", payload: { channel_id: id(1), profile_id: profileId } },
      { type: "iptv.play", payload: { channel_id: id(1), profile_id: profileId, force: true } },
    ]);
  });

  test("Home card continues the last channel", async ({ page }) => {
    await mockIptv(page);
    await page.goto("/");
    const card = page.getByTestId("tv-continue");
    await expect(card).toContainText("Кино ТВ");
    await expect(card).toContainText("Продолжить смотреть ТВ");
    await page.getByTestId("tv-card").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/web-iptv-phone-home-card.png` });
    await card.click();
    await expect(page.getByTestId("live-player")).toBeVisible();
    await expect(page.getByTestId("live-channel-name")).toContainText("Кино ТВ");
  });
});

// ---------------------------------------------------------------- desktop

test.describe("ТВ on desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 }, locale: "ru-RU" });

  test("top nav, guide grid, playlists setting", async ({ page }) => {
    await mockIptv(page);
    let saved: unknown = null;
    await page.route(/\/api\/v1\/profiles\/[^/]+\/settings$/, (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      saved = route.request().postDataJSON();
      return json(route, saved); // the client merges the answer into its cached settings
    });
    await page.goto("/");
    await page.getByRole("navigation").getByRole("link", { name: "ТВ", exact: true }).click();
    await expect(page).toHaveURL(/\/tv-channels$/);
    await expect(page.getByTestId("channel-row")).toHaveCount(6);
    await page.screenshot({ path: `${SHOTS}/web-iptv-desktop-list.png` });

    await page.getByTestId("iptv-view-guide").click();
    const guide = page.getByTestId("iptv-guide");
    await expect(guide.getByTestId("guide-row")).toHaveCount(6);
    await expect(guide.locator("[data-testid=guide-programme][data-live=true]")).toHaveCount(6);
    await page.screenshot({ path: `${SHOTS}/web-iptv-desktop-guide.png` });
    await page.getByTestId("guide-later").click();
    await expect(guide.locator("[data-testid=guide-programme][data-live=true]")).toHaveCount(0);

    // ⚙: pick playlists (all → an explicit list).
    await page.getByTestId("iptv-settings").click();
    const sheet = page.getByTestId("iptv-playlists-sheet");
    await expect(sheet.getByTestId("playlist-option")).toHaveCount(2);
    // (The optimistic update lands a tick after the click, so click + assert rather than uncheck().)
    await sheet.getByTestId("playlist-option").nth(1).locator("input").click();
    await expect.poll(() => saved).toEqual({ iptv_playlists: [PL_RU] });
    await expect(sheet.getByTestId("playlist-option").nth(1).locator("input")).not.toBeChecked();
    await expect(sheet.getByTestId("playlist-all").locator("input")).not.toBeChecked();
    await page.screenshot({ path: `${SHOTS}/web-iptv-desktop-playlists.png` });
  });

  test("Admin → IPTV: add countries, refresh, upload, stats", async ({ page }) => {
    const created: Record<string, unknown>[] = [];
    let uploaded = "";
    const stats = (c: number) => ({ channels: c, offline: Math.floor(c / 10), epg_matched: Math.floor(c * 0.8), with_programmes: Math.floor(c * 0.7) });
    const playlist = (o: Record<string, unknown>) => ({
      id: PL_RU, kind: "iptv_org_country", name: "Россия", url: null, country: "ru", epg_url: null, effective_epg_url: "https://epg.pw/xmltv/epg_RU.xml.gz", enabled: true,
      user_agent: null, referrer: null, via_proxy: false, position: 0, has_content: false,
      refresh: { status: "ok", error: null, refreshed_at: new Date(Date.now() - 3600_000).toISOString(), fetched_via: "direct" },
      epg: { status: "ok", error: null, refreshed_at: new Date(Date.now() - 1800_000).toISOString(), xmltv_channels: 4089, programmes: 18230 },
      stats: stats(502), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...o,
    });
    const items: ReturnType<typeof playlist>[] = [playlist({})];
    let refreshes = 0;
    await page.route(/\/api\/v1\/admin\/iptv\/countries/, (route) =>
      json(route, {
        items: [
          { code: "ru", name_en: "Russia", name_ru: "Россия", suggested: true },
          { code: "kz", name_en: "Kazakhstan", name_ru: "Казахстан", suggested: true },
          { code: "ua", name_en: "Ukraine", name_ru: "Украина", suggested: true },
          { code: "by", name_en: "Belarus", name_ru: "Беларусь", suggested: true },
          { code: "int", name_en: "International", name_ru: "Международные", suggested: true },
          { code: "de", name_en: "Germany", name_ru: "Германия", suggested: false },
        ],
      }),
    );
    await page.route(/\/api\/v1\/admin\/iptv\/playlists(\/.*)?$/, async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      if (req.method() === "GET") {
        // A running refresh finishes on the next poll.
        const out = items.map((p) => ({ ...p }));
        items.forEach((p, i) => p.refresh.status === "running" && (items[i] = { ...p, refresh: { ...p.refresh, status: "ok", refreshed_at: new Date().toISOString() } }));
        return json(route, { items: out, totals: stats(items.reduce((n, p) => n + p.stats.channels, 0)), proxy_configured: true, refresh_hours: 12, epg_refresh_hours: 6 });
      }
      if (req.method() === "POST" && path.endsWith("/refresh")) {
        refreshes++;
        if (refreshes > 1) return json(route, { error: { code: "refresh_running", message: "running" } }, 409);
        items[0] = { ...items[0]!, refresh: { ...items[0]!.refresh, status: "running" } };
        return json(route, items[0], 202);
      }
      if (req.method() === "PUT" && path.endsWith("/content")) {
        uploaded = req.postData() ?? "";
        return json(route, items.at(-1));
      }
      if (req.method() === "POST") {
        const body = req.postDataJSON() as Record<string, unknown>;
        created.push(body);
        const p = playlist({
          id: `a1a10000-0000-4000-8000-${String(items.length + 1).padStart(12, "0")}`, kind: body.kind, name: body.name ?? "Мой плейлист", country: body.country ?? null,
          refresh: { status: "running", error: null, refreshed_at: null, fetched_via: null }, epg: { status: "never", error: null, refreshed_at: null, xmltv_channels: 0, programmes: 0 }, stats: stats(0),
        });
        items.push(p);
        return json(route, p, 201);
      }
      return route.fallback();
    });
    await page.goto("/admin?tab=iptv");
    const tab = page.getByTestId("admin-iptv");
    await expect(tab.getByTestId("iptv-playlist")).toHaveCount(1);
    await expect(tab.getByTestId("iptv-totals")).toContainText("502");
    await expect(tab).toContainText("Покрытие программой 70%");

    // Refresh → running → ok (polled); a second refresh while running → 409 message.
    await tab.getByTestId("iptv-refresh").click();
    await expect(tab.getByTestId("iptv-status").first()).toHaveAttribute("data-status", /running|ok/);
    await tab.getByTestId("iptv-refresh").click();
    await expect(tab).toContainText("Обновление уже идёт");

    // Add iptv-org countries: suggested ones preselected (ru is taken already).
    await tab.getByTestId("iptv-add").click();
    const sheet = page.getByTestId("iptv-add-sheet");
    await expect(sheet.locator("[data-testid=iptv-country][data-code=ru]")).toBeDisabled();
    await expect(sheet.locator("[data-testid=iptv-country][data-code=kz]")).toHaveAttribute("aria-pressed", "true");
    await expect(sheet.locator("[data-testid=iptv-country][data-code=de]")).toHaveAttribute("aria-pressed", "false");
    await sheet.locator("[data-testid=iptv-country][data-code=ua]").click();
    await page.screenshot({ path: `${SHOTS}/web-iptv-desktop-admin-add.png` });
    await sheet.getByTestId("iptv-create").click();
    await expect(sheet).toHaveCount(0);
    expect(created.map((c) => c.country)).toEqual(["kz", "by", "int"]);
    expect(created[0]).toMatchObject({ kind: "iptv_org_country", name: "Казахстан", via_proxy: false });

    // An M3U file: create, then PUT the content as text.
    await tab.getByTestId("iptv-add").click();
    await page.getByTestId("iptv-kind-m3u_file").click();
    await page.getByTestId("iptv-name").fill("Провайдер");
    await page.getByTestId("iptv-file").setInputFiles({ name: "my.m3u", mimeType: "audio/x-mpegurl", buffer: Buffer.from('#EXTM3U\n#EXTINF:-1 tvg-id="x",X\nhttp://example.com/x.m3u8\n') });
    await page.getByTestId("iptv-create").click();
    await expect.poll(() => uploaded).toContain("#EXTM3U");
    expect(created.at(-1)).toMatchObject({ kind: "m3u_file", name: "Провайдер" });
    await expect(tab.getByTestId("iptv-playlist")).toHaveCount(5);
    await page.screenshot({ path: `${SHOTS}/web-iptv-desktop-admin.png`, fullPage: true });
  });
});
