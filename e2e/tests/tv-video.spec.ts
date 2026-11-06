import { mkdirSync, readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

type Design = "kinozal" | "terminal" | "projector" | "wireframe" | "cyberpunk" | "deco" | "retro80" | "retro90" | "popart" | "constructivism";
const SKELETON: Record<Design, "kinozal" | "terminal" | "projector"> = {
  kinozal: "kinozal",
  terminal: "terminal",
  projector: "projector",
  wireframe: "projector",
  cyberpunk: "terminal",
  deco: "kinozal",
  retro80: "kinozal",
  retro90: "terminal",
  popart: "projector",
  constructivism: "terminal",
};
const SHOTS = process.env.VIDEO_SHOTS ?? "test-results/video-tv-shots";
mkdirSync(SHOTS, { recursive: true });
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const FIX = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));

async function press(tv: Page, key: string, times = 1) {
  for (let i = 0; i < times; i++) {
    await tv.keyboard.press(key);
    await tv.waitForTimeout(170);
  }
}

// YouTube ids (11 chars) and a channel id (UC + 22).
const vid = (n: number) => `vid${String(n).padStart(8, "0")}`;
const CHANNEL = "UCabcdefghijklmnopqrstuv";
const COLORS = ["#e03131", "#1971c2", "#2f9e44", "#f08c00", "#7048e8", "#0c8599", "#c2255c"];
const THUMB = (n: number, text: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270"><rect width="480" height="270" fill="${COLORS[n % COLORS.length]}"/><circle cx="240" cy="135" r="60" fill="#fff" opacity=".35"/><text x="24" y="250" font-family="sans-serif" font-size="34" fill="#fff">${text}</text></svg>`;

const TITLES = [
  "",
  "Как устроен двигатель внутреннего сгорания — подробный разбор",
  "Лучшие моменты недели: футбол",
  "Рецепт борща за 30 минут",
  "Обзор нового телевизора: стоит ли покупать?",
  "Котики против пылесоса",
  "Прогулка по ночной Москве 4K",
  "Документальный фильм о космосе",
  "Live: концерт",
  "Смешные котики 2026 — подборка",
  "Котик учится открывать двери",
  "Почему коты мурчат",
];

function item(n: number, o: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: vid(n),
    title: TITLES[n] ?? `Видео ${n}`,
    channel_id: CHANNEL,
    channel_name: n % 2 ? "Наука и техника" : "Cineko Влог",
    channel_verified: n % 3 === 0,
    duration_seconds: 80,
    views: [1_234_567, 15_400, 980, 3_100_000][n % 4],
    published_at: new Date(now - n * 86_400_000 * 2).toISOString(),
    published_text: null,
    thumbnail: `/api/v1/video/thumbs/vi/${vid(n)}/mqdefault.jpg`,
    thumbnail_hd: `/api/v1/video/thumbs/vi/${vid(n)}/hqdefault.jpg`,
    live: false,
    upcoming: false,
    short: false,
    ...o,
  };
}

const progress = (position: number) => ({ position_seconds: position, duration_seconds: 80, finished: false, updated_at: new Date().toISOString() });

function detail(n: number) {
  return {
    ...item(n),
    description: "Описание видео.\nhttps://example.com",
    likes: 1200,
    genre: "Science & Technology",
    channel: { id: CHANNEL, name: "Наука и техника", avatar: null, subscribers: 1_250_000, video_count: 320, verified: true, subscribed: false },
    related: [item(2), item(3), item(4), item(6), item(7)],
    in_watch_later: false,
    qualities: [1080, 720, 480, 360],
    captions: [],
    playable: true,
  };
}

interface Log {
  sources: Record<string, unknown>[];
  progress: Record<string, unknown>[];
  suggestions: string[];
  /** offset of every /video/feed request. */
  feed: number[];
}

interface MockState {
  design: Design;
  unavailable: boolean;
  /** A long «Подписки» feed served page by page (offset/limit, next_offset). */
  feedTotal?: number;
  /** /trending answers 503 (YouTube/VPN down; the feed still comes from the DB cache). */
  failTrending?: boolean;
  /** Feed pages after the first answer 503. */
  failFeedMore?: boolean;
}

/**
 * The VOD fixture (VP9/Opus fMP4, ~16 s) repeated 5× with discontinuities:
 * ~80 s, so resuming at 0:15 and seeking have room.
 */
function playlist(): string {
  const segs = [
    ["6.329670", "seg0.m4s"],
    ["3.164835", "seg1.m4s"],
    ["3.164835", "seg2.m4s"],
    ["3.428571", "seg3.m4s"],
  ];
  const out = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:7", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD", '#EXT-X-MAP:URI="init.mp4"'];
  for (let r = 0; r < 5; r++) {
    if (r > 0) out.push("#EXT-X-DISCONTINUITY", '#EXT-X-MAP:URI="init.mp4"');
    for (const [d, f] of segs) out.push(`#EXTINF:${d},`, f!);
  }
  out.push("#EXT-X-ENDLIST", "");
  return out.join("\n");
}

async function mockTv(ctx: BrowserContext, s: MockState): Promise<Log> {
  const log: Log = { sources: [], progress: [], suggestions: [], feed: [] };
  let current: Record<string, unknown> | null = null;
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
    if (route.request().method() === "GET" && !current) {
      const res = await route.fetch().catch(() => null);
      current = res && res.ok() ? await res.json() : {};
    }
    return json(route, { ...(current ?? {}), design: s.design, theme: "dark", onboarding_completed: true, video_quality: 720, video_hide_shorts: true });
  });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, (route) => json(route, { items: [] }));
  await ctx.route(/\/api\/v1\/recommendations\/inbox/, (route) => json(route, { items: [], unseen: 0 }));
  await ctx.route(/\/api\/v1\/messages(\?.*)?$/, (route) => json(route, { items: [], unread: 0 }));
  await ctx.route(/\/api\/v1\/foryou\/rows/, (route) => json(route, { profile_id: "p", generated_at: null, stale: false, cold_start: true, rows: [] }));

  await ctx.route(/\/api\/v1\/video\//, (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api\/v1\/video/, "");
    const method = route.request().method();
    if (path.startsWith("/thumbs/")) {
      const n = Number(path.split("/")[3]!.slice(3));
      return route.fulfill({ status: 200, contentType: "image/svg+xml", body: THUMB(n, `#${n}`) });
    }
    if (s.unavailable) return json(route, { error: { code: "video_unavailable", message: "Invidious is down" } }, 503);
    if (path === "/progress" && method === "POST") {
      log.progress.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill({ status: 204 });
    }
    if (path === "/continue") return json(route, { items: [item(1, { progress: progress(15) })] });
    if (path === "/feed" && s.feedTotal) {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      log.feed.push(offset);
      if (offset > 0 && s.failFeedMore) return json(route, { error: { code: "video_unavailable", message: "Invidious is down" } }, 503);
      const end = Math.min(s.feedTotal, offset + limit);
      const items = Array.from({ length: Math.max(0, end - offset) }, (_, i) => item(100 + offset + i, { title: `Подписка ${offset + i + 1}` }));
      return json(route, { items, refreshed_at: new Date().toISOString(), next_offset: end < s.feedTotal ? end : null });
    }
    if (path === "/feed") return json(route, { items: [item(2), item(3), item(4), item(5)], refreshed_at: new Date().toISOString() });
    if (path === "/trending" && s.failTrending) return json(route, { error: { code: "video_unavailable", message: "Invidious is down" } }, 503);
    if (path === "/trending") return json(route, { items: [item(6), item(7), item(8, { live: true, duration_seconds: null }), item(2), item(4)] });
    if (path === "/watch-later") return json(route, { items: [item(3)] });
    if (path === "/history") return json(route, { items: [item(1, { progress: progress(15) }), item(7)] });
    if (path.startsWith("/watch-later/")) return method === "DELETE" ? route.fulfill({ status: 204 }) : json(route, item(3));
    if (path === "/search/suggestions") {
      const q = url.searchParams.get("q") ?? "";
      log.suggestions.push(q);
      return json(route, { items: q ? [`${q} смешные`, `${q} 2026`, `${q} спят`] : [] });
    }
    if (path === "/search") return json(route, { videos: [item(9), item(10), item(11)], channels: [], playlists: [], page: Number(url.searchParams.get("page") ?? 1) });
    if (path.startsWith("/videos/")) {
      const n = Number(path.split("/")[2]!.slice(3));
      return json(route, detail(n));
    }
    if (path.startsWith("/channels/")) {
      return json(route, { id: CHANNEL, name: "Наука и техника", avatar: null, subscribers: 1_250_000, video_count: 320, verified: true, subscribed: false, banner: null, description: "", videos: [item(1), item(3), item(5), item(7)], continuation: null });
    }
    if (path.startsWith("/subscriptions/")) return json(route, { id: CHANNEL, name: "Наука и техника", avatar: null, subscribers: 1, video_count: 1, verified: true, subscribed: true });
    return json(route, { error: { code: "not_found", message: `mocked: ${path}` } }, 404);
  });

  await ctx.route(/\/api\/v1\/playback\/sources(\?.*)?$/, (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    log.sources.push(body);
    const id = body.video_id as string;
    // Video #10 has a broken HLS stream: the player falls back to the MP4 (here: the WebM clip).
    const tok = `${id === vid(10) ? "bad" : "ok"}-${id}-${(body.quality as number | undefined) ?? 0}`;
    return json(
      route,
      {
        id: "5e1f0000-0000-4000-8000-0000000000bb",
        media_id: null,
        episode_id: null,
        release: null,
        status: "ready",
        error: null,
        file: null,
        stream_url: `/api/v1/vstream/${tok}/master.m3u8`,
        stream_expires_at: new Date(Date.now() + 3600_000).toISOString(),
        mime_type: "application/vnd.apple.mpegurl",
        media_info: null,
        torrent: null,
        created_at: new Date().toISOString(),
        kind: "video",
        live: false,
        video_id: id,
        provider: null,
        format: "hls",
        quality: (body.quality as number | undefined) ?? 720,
        qualities: [1080, 720, 480, 360],
        subtitles: [],
        duration_seconds: 80,
        fallback_url: `/api/v1/vstream/${tok}/fallback.webm`,
        position_seconds: id === vid(1) ? 15 : null,
      },
      201,
    );
  });
  await ctx.route(/\/api\/v1\/vstream\//, (route) => {
    const parts = new URL(route.request().url()).pathname.split("/");
    const tok = parts.at(-2)!;
    const file = parts.at(-1)!;
    if (file === "fallback.webm") return route.fulfill({ status: 200, headers: { "Content-Type": "video/webm" }, body: FIX("clip.webm") });
    if (tok.startsWith("bad-")) return route.fulfill({ status: 404, body: "gone" });
    if (file === "master.m3u8") return route.fulfill({ status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" }, body: playlist() });
    return route.fulfill({ status: 200, headers: { "Content-Type": "video/mp4" }, body: FIX(`hls/${file}`) });
  });
  return log;
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
      return { status: r.status, body: (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null };
    },
    { deviceId, body },
  );
}

/** Focus into the menu, then onto `id`, then OK. */
async function openMenu(tv: Page, design: Design, id: string) {
  const rail = SKELETON[design] === "kinozal";
  for (let i = 0; i < 12 && !(await tv.locator('nav [data-nav-focused="1"]').count()); i++) await press(tv, rail ? "ArrowLeft" : "ArrowUp");
  const order = await tv.locator("nav [data-menu]").evaluateAll((els) => els.map((e) => e.getAttribute("data-menu")));
  for (let i = 0; i < 14; i++) {
    const cur = await tv.locator('nav [data-nav-focused="1"]').getAttribute("data-menu");
    if (cur === id) break;
    const fwd = order.indexOf(id) > order.indexOf(cur);
    await press(tv, rail ? (fwd ? "ArrowDown" : "ArrowUp") : fwd ? "ArrowRight" : "ArrowLeft");
  }
  await expect(tv.locator(`nav [data-menu="${id}"]`)).toHaveAttribute("data-nav-focused", "1");
  await press(tv, "Enter");
}

const player = (tv: Page) => tv.getByTestId("video-player");
const time = (tv: Page) => tv.locator("[data-testid=video-player] video").evaluate((v: HTMLVideoElement) => v.currentTime);
const playing = (tv: Page, above = 0.3) => expect.poll(() => time(tv), { timeout: 20_000 }).toBeGreaterThan(above);

/**
 * «Видео» on the TV: the tab right after «ТВ» in all six designs, its rows,
 * resume / from-start, the player (OSD, pause → progress report, quality,
 * the related panel), search with the on-screen keyboard and suggestions,
 * the MP4 fallback, the channel page, the phone's video.play (busy → force,
 * media.stop) and the 503 message. Screenshots of every design.
 */
test("TV: «Видео» tab, search, player and video.play in every design", async ({ browser }) => {
  test.setTimeout(360_000);
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
  const s = { design: "kinozal" as Design, unavailable: false };
  const log = await mockTv(tvCtx, s);

  await tv.goto("/tv/");
  await tv.evaluate(() => localStorage.setItem("martytv.locale", "ru"));
  await tv.reload();
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Video TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });
  const devices = await (await phoneCtx.request.get("/api/v1/devices")).json();
  const deviceId = devices.items.find((d: { name: string }) => d.name === deviceName).id as string;
  const chooseProfile = async () => {
    if (await tv.getByRole("heading", { name: /кто смотрит|who's watching/i }).isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");
  };
  const tab = tv.getByTestId("video-tab");
  const focusedCard = () => tab.locator("[data-video-id]:has(.is-focused)");

  try {
    await chooseProfile();
    await expect(tv.locator('[data-design-nav="kinozal"]')).toBeVisible({ timeout: 20_000 });

    // «Видео» right after «ТВ».
    const order = await tv.locator("nav [data-menu]").evaluateAll((els) => els.map((e) => e.getAttribute("data-menu")));
    expect(order[order.indexOf("tv") + 1]).toBe("video");
    await openMenu(tv, "kinozal", "video");
    await expect(tab).toBeVisible();
    await expect(tab.locator("section[data-row]")).toHaveCount(5);
    expect(await tab.locator("section[data-row]").evaluateAll((els) => els.map((e) => e.getAttribute("data-row")))).toEqual(["continue", "subscriptions", "trending", "watch_later", "history"]);
    await expect(tab.locator("[data-row=continue] [data-progress]")).toHaveCount(1);
    await expect(focusedCard()).toHaveAttribute("data-video-id", vid(1));
    await expect(tab.locator("[data-row=trending]")).toContainText("ЭФИР");
    await expect(tab.locator("[data-row=subscriptions]")).toContainText("1,2 млн просмотров");
    await tv.waitForTimeout(600);
    await tv.screenshot({ path: `${SHOTS}/tab-kinozal.png` });

    // OK on an unfinished video: «Продолжить с 0:15» / «С начала».
    await press(tv, "Enter");
    const menu = tv.getByTestId("video-menu");
    await expect(menu).toBeVisible();
    await expect(menu).toContainText("Продолжить с 0:15");
    await expect(menu).toContainText("С начала");
    await tv.screenshot({ path: `${SHOTS}/resume-menu-kinozal.png` });
    await press(tv, "Enter");
    await expect(player(tv)).toBeVisible();
    await expect.poll(() => log.sources.length).toBe(1);
    expect(log.sources[0]).toEqual(expect.objectContaining({ kind: "video", video_id: vid(1), quality: 720 }));
    await playing(tv, 15);
    await expect(player(tv)).toHaveAttribute("data-mode", /^hls-(native|js)$/);
    await expect(tv.getByTestId("video-osd-title")).toHaveText(TITLES[1]!);
    await expect(tv.getByTestId("video-note")).toHaveText("Качество: 720p");
    await tv.screenshot({ path: `${SHOTS}/player-osd-kinozal.png` });

    // OK pauses → a progress report; OK resumes.
    await press(tv, "Enter");
    await expect(player(tv)).toHaveAttribute("data-paused", "1");
    await expect(tv.getByTestId("video-paused")).toBeVisible();
    await expect.poll(() => log.progress.at(-1)?.video_id).toBe(vid(1));
    expect(log.progress.at(-1)!.position_seconds as number).toBeGreaterThanOrEqual(15);
    expect(log.progress.at(-1)!.duration_seconds).toBeGreaterThan(70);
    await tv.screenshot({ path: `${SHOTS}/player-paused-kinozal.png` });
    await press(tv, "Enter");
    await expect(player(tv)).toHaveAttribute("data-paused", "0");

    // ▶ seeks forward (+30 s after a short pause).
    const before = await time(tv);
    await press(tv, "ArrowRight");
    await expect.poll(() => time(tv), { timeout: 5_000 }).toBeGreaterThan(before + 20);

    // ▲: the related panel; ▲ again: quality; ◀ 1080p, OK → a new source at 1080, same position.
    await press(tv, "ArrowUp");
    const panel = tv.getByTestId("video-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-line", "related");
    await expect(panel.locator("[data-related-id]").first()).toContainText(TITLES[2]!);
    await tv.screenshot({ path: `${SHOTS}/player-related-kinozal.png` });
    await press(tv, "ArrowUp");
    await expect(panel).toHaveAttribute("data-line", "quality");
    await expect(panel.locator('[data-quality="720"]')).toHaveClass(/is-focused/);
    await press(tv, "ArrowLeft");
    await expect(panel.locator('[data-quality="1080"]')).toHaveClass(/is-focused/);
    await tv.screenshot({ path: `${SHOTS}/player-quality-kinozal.png` });
    const at = await time(tv);
    await press(tv, "Enter");
    await expect(panel).toHaveCount(0);
    await expect.poll(() => log.sources.length).toBe(2);
    expect(log.sources[1]).toEqual(expect.objectContaining({ video_id: vid(1), quality: 1080 }));
    await expect(player(tv)).toHaveAttribute("data-quality", "1080");
    await expect.poll(() => time(tv), { timeout: 20_000 }).toBeGreaterThan(at - 3);
    await expect(tv.getByTestId("video-note")).toHaveText("Качество: 1080p");

    // ▼: related; ▶ OK plays the second one (keeps 1080).
    await press(tv, "ArrowDown");
    await expect(panel).toHaveAttribute("data-line", "related");
    await press(tv, "ArrowRight");
    await press(tv, "Enter");
    await expect(player(tv)).toHaveAttribute("data-video-id", vid(3));
    await expect.poll(() => log.sources.length).toBe(3);
    expect(log.sources[2]).toEqual(expect.objectContaining({ video_id: vid(3), quality: 1080 }));
    // Leaving the first video reported where it was.
    expect(log.progress.filter((p) => p.video_id === vid(1)).length).toBeGreaterThanOrEqual(2);
    await playing(tv);
    await tv.waitForTimeout(1200);

    // Back leaves (and reports); focus returns to the card.
    const reports = log.progress.length;
    await press(tv, "Escape");
    await expect(player(tv)).toHaveCount(0);
    await expect(tab).toBeVisible();
    await expect.poll(() => log.progress.length).toBeGreaterThan(reports);
    expect(log.progress.at(-1)!.video_id).toBe(vid(3));
    await expect(focusedCard()).toHaveAttribute("data-video-id", vid(1));

    // Holding OK: the video menu (watch later, channel) → the channel page.
    await press(tv, "ArrowDown");
    await expect(focusedCard()).toHaveAttribute("data-video-id", vid(2));
    await tv.keyboard.down("Enter");
    await tv.waitForTimeout(900);
    await tv.keyboard.up("Enter");
    await expect(menu).toBeVisible();
    await expect(menu).toContainText("Смотреть позже");
    await expect(menu).toContainText("Канал: Cineko Влог");
    await press(tv, "ArrowDown", 2);
    await press(tv, "Enter");
    const channel = tv.getByTestId("video-channel");
    await expect(channel).toBeVisible();
    await expect(channel).toContainText("Наука и техника");
    await expect(channel).toContainText("1,2 млн подписчиков");
    await expect(channel.locator("[data-video-id]")).toHaveCount(4);
    await tv.waitForTimeout(400);
    await tv.screenshot({ path: `${SHOTS}/channel-kinozal.png` });
    await press(tv, "ArrowUp");
    await press(tv, "Enter");
    await expect(channel.getByTestId("video-subscribe")).toHaveAttribute("data-subscribed", "1");
    // Back: first to the menu (deep in a page), then back to the tab.
    await press(tv, "Escape", 2);
    await expect(tab).toBeVisible();

    // Search: ▲ to «Поиск», type, suggestions, pick one → results → play.
    for (let i = 0; i < 4 && !(await tv.locator(".is-focused", { hasText: "Поиск на YouTube" }).count()); i++) await press(tv, "ArrowUp");
    await press(tv, "Enter");
    const search = tv.getByTestId("video-search");
    await expect(search).toBeVisible();
    await expect(search).toContainText("Набирайте запрос");
    // The screen keyboard types (OK on «А»), a physical Backspace deletes; then physical keys
    // (Playwright sends Cyrillic as text input only, so Latin here).
    await press(tv, "Enter");
    await expect(tv.getByTestId("video-search-box")).toContainText("А");
    await press(tv, "Backspace");
    await expect(tv.getByTestId("video-search-box")).toContainText("Поиск на YouTube");
    await tv.keyboard.type("cats", { delay: 60 });
    await expect(tv.getByTestId("video-search-box")).toContainText(/cats/i);
    const sugg = tv.getByTestId("video-suggestions");
    await expect(sugg).toContainText(/cats смешные/i);
    await expect(search.locator("[data-video-id]")).toHaveCount(3);
    await tv.waitForTimeout(400);
    await tv.screenshot({ path: `${SHOTS}/search-kinozal.png` });
    await press(tv, "ArrowRight", 7);
    await expect(sugg.locator(".is-focused")).toHaveText(/cats смешные/i);
    await press(tv, "Enter");
    await expect(tv.getByTestId("video-search-box")).toContainText(/cats смешные/i);
    await expect(search.locator("[data-video-id]:has(.is-focused)")).toHaveAttribute("data-video-id", vid(9));
    await press(tv, "Enter");
    await expect(player(tv)).toHaveAttribute("data-video-id", vid(9));
    await playing(tv);
    await press(tv, "Escape");
    await expect(player(tv)).toHaveCount(0);

    // A broken HLS stream: the MP4 fallback plays, with a note.
    await press(tv, "ArrowRight");
    await expect(search.locator("[data-video-id]:has(.is-focused)")).toHaveAttribute("data-video-id", vid(10));
    await press(tv, "Enter");
    await expect(player(tv)).toHaveAttribute("data-mode", "mp4", { timeout: 20_000 });
    await playing(tv);
    await expect(tv.getByTestId("video-note")).toContainText("Базовое качество");
    await tv.screenshot({ path: `${SHOTS}/player-fallback-kinozal.png` });
    await press(tv, "Escape");
    await expect(player(tv)).toHaveCount(0);
    await press(tv, "Escape", 2);
    await expect(tab).toBeVisible();

    // The phone: video.play starts a video (at its position); busy → force; media.stop closes.
    const r = await sendCommand(phone, deviceId, { type: "video.play", payload: { video_id: vid(6), position_seconds: 8 } });
    expect(r.status).toBeLessThan(300);
    expect(r.body?.ok).toBe(true);
    await expect(player(tv)).toHaveAttribute("data-video-id", vid(6), { timeout: 10_000 });
    await playing(tv, 7);
    await expect(tv.getByTestId("tv-toast")).toBeVisible();
    const busy = await sendCommand(phone, deviceId, { type: "video.play", payload: { video_id: vid(7) } });
    expect(busy.body).toEqual(expect.objectContaining({ ok: false, error: "busy_playing" }));
    const forced = await sendCommand(phone, deviceId, { type: "video.play", payload: { video_id: vid(7), force: true } });
    expect(forced.body?.ok).toBe(true);
    await expect(player(tv)).toHaveAttribute("data-video-id", vid(7), { timeout: 10_000 });
    const paused = await sendCommand(phone, deviceId, { type: "media.pause" });
    expect(paused.body?.ok).toBe(true);
    await expect(player(tv)).toHaveAttribute("data-paused", "1");
    const stop = await sendCommand(phone, deviceId, { type: "media.stop" });
    expect(stop.body?.ok).toBe(true);
    await expect(player(tv)).toHaveCount(0);
    await expect(tab).toBeVisible();

    // Every other design: the tab renders its rows; a player screenshot.
    for (const design of ["terminal", "projector", "wireframe", "cyberpunk", "deco"] as Design[]) {
      s.design = design;
      await tv.reload();
      await chooseProfile();
      await expect(tv.locator(`[data-design-nav="${SKELETON[design]}"]`)).toBeVisible({ timeout: 20_000 });
      await openMenu(tv, design, "video");
      await expect(tab).toBeVisible();
      // The 12 tabs fit the bar: nothing (the clock, the profile) runs off the screen / into the pill.
      const nav = tv.locator("nav[data-design-nav]");
      if (SKELETON[design] === "terminal") {
        const right = await nav.evaluate((n) => Math.max(...Array.from(n.querySelectorAll("*")).map((e) => e.getBoundingClientRect().right)));
        expect(right, `${design}: the tab bar fits`).toBeLessThanOrEqual(1920 - 24);
      } else if (SKELETON[design] === "projector") {
        const gap = await nav.evaluate((n) => {
          const pill = n.querySelector(".p-bar")!.getBoundingClientRect();
          const clock = n.querySelector(".mr-6")!.getBoundingClientRect();
          return clock.left - pill.right;
        });
        expect(gap, `${design}: the pill stays clear of the clock`).toBeGreaterThan(16);
      }
      await expect(tab.locator("section[data-row]")).toHaveCount(5);
      await expect(focusedCard()).toHaveCount(1);
      await tv.waitForTimeout(700);
      await tv.screenshot({ path: `${SHOTS}/tab-${design}.png` });
      if (design === "terminal" || design === "projector") {
        await press(tv, "ArrowDown");
        await press(tv, "Enter");
        await expect(player(tv)).toBeVisible();
        await playing(tv);
        await press(tv, "ArrowUp");
        await expect(tv.getByTestId("video-panel")).toBeVisible();
        await tv.waitForTimeout(400);
        await tv.screenshot({ path: `${SHOTS}/player-related-${design}.png` });
        await press(tv, "Escape");
        await press(tv, "Escape");
        await expect(player(tv)).toHaveCount(0);
      }
    }

    // Invidious down: the friendly message.
    s.unavailable = true;
    await tv.reload();
    await chooseProfile();
    await openMenu(tv, "deco", "video");
    await expect(tv.getByTestId("video-unavailable")).toBeVisible({ timeout: 20_000 });
    await expect(tv.getByTestId("video-unavailable")).toContainText("сервис YouTube не отвечает");
    await tv.screenshot({ path: `${SHOTS}/unavailable-deco.png` });
  } finally {
    await phoneCtx.request.delete(`/api/v1/devices/${deviceId}`, { headers: { "X-CSRF-Token": session.csrf_token, Origin: origin } }).catch(() => undefined);
    await phoneCtx.close();
    await tvCtx.close();
  }
});

/**
 * Long lists, errors and the phone remote: «Подписки» with 130 videos loads
 * page by page as focus nears the end (the focused card stays in view); a
 * failed refetch (YouTube/VPN down) and a failed next page keep the rows,
 * the focus and the scroll, say so, and heal by themselves; the phone's
 * media.pause / media.seek / video.play (quality) / media.next_episode drive
 * the TV's player and DeviceState.video follows; Back folds the pause
 * overlay before leaving, like the film player.
 */
test("TV: «Видео» pages in long lists, errors keep focus, the phone controls the video", async ({ browser }) => {
  test.setTimeout(240_000);
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
  const s: MockState = { design: "kinozal", unavailable: false, feedTotal: 130 };
  const log = await mockTv(tvCtx, s);

  await tv.goto("/tv/");
  await tv.evaluate(() => localStorage.setItem("martytv.locale", "ru"));
  await tv.reload();
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Video Lists ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });
  const devices = await (await phoneCtx.request.get("/api/v1/devices")).json();
  const deviceId = devices.items.find((d: { name: string }) => d.name === deviceName).id as string;
  const tab = tv.getByTestId("video-tab");
  const focusedCard = () => tab.locator("[data-video-id]:has(.is-focused)");
  const focusedId = () => focusedCard().getAttribute("data-video-id");
  /** The focused card is fully on screen (not scrolled away, not under the menu). */
  const inView = async () => {
    const b = await focusedCard().boundingBox();
    return !!b && b.x >= 80 && b.x + b.width <= 1920 && b.y >= 0 && b.y + b.height <= 1080;
  };
  const deviceVideo = async () => {
    const r = await phoneCtx.request.get(`/api/v1/devices/${deviceId}/state`);
    const st = (await r.json()) as { state?: { screen?: string; video?: Record<string, unknown> | null } | null };
    return st.state?.video ?? null;
  };

  try {
    if (await tv.getByRole("heading", { name: /кто смотрит|who's watching/i }).isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");
    await expect(tv.locator('[data-design-nav="kinozal"]')).toBeVisible({ timeout: 20_000 });
    await openMenu(tv, "kinozal", "video");
    await expect(tab.locator("section[data-row]")).toHaveCount(5);
    await expect.poll(() => log.feed).toEqual([0]);

    // ▼ to «Подписки», then hold ▶ (key repeat): the next pages load near the end; the focused card stays in view.
    await press(tv, "ArrowDown");
    await expect(focusedId()).resolves.toBe(vid(100));
    for (let i = 0; i < 46; i++) {
      await tv.keyboard.press("ArrowRight");
      await tv.waitForTimeout(90);
    }
    await expect.poll(() => log.feed).toEqual([0, 50]);
    await expect.poll(focusedId).toBe(vid(146));
    expect(await inView()).toBe(true);
    await tv.waitForTimeout(400);
    await tv.screenshot({ path: `${SHOTS}/feed-paged-kinozal.png` });

    // YouTube down: the next page fails — the row keeps its cards and the focus, says so at its end.
    s.failFeedMore = true;
    // (Key repeat is throttled to 80 ms: press until the last loaded card.)
    for (let i = 0; i < 70 && (await focusedId()) !== vid(199); i++) {
      await tv.keyboard.press("ArrowRight");
      await tv.waitForTimeout(90);
    }
    await expect.poll(focusedId).toBe(vid(199));
    await expect.poll(() => log.feed.filter((o) => o === 100).length).toBeGreaterThanOrEqual(1);
    const more = tab.getByTestId("video-more");
    await expect(more).toHaveAttribute("data-failed", "1");
    await expect(tv.getByTestId("video-load-error")).toBeVisible();
    await expect(focusedId()).resolves.toBe(vid(199));
    expect(await inView()).toBe(true);
    await tv.screenshot({ path: `${SHOTS}/feed-more-failed-kinozal.png` });
    // Back up: it retries by itself (5 s) and the rest arrives; focus never moved.
    s.failFeedMore = false;
    await expect(more).toHaveCount(0, { timeout: 15_000 });
    await expect(tab.locator("section[data-row=subscriptions] [data-video-id]").last()).toBeVisible();
    await expect(focusedId()).resolves.toBe(vid(199));
    await press(tv, "ArrowRight", 3);
    await expect.poll(focusedId).toBe(vid(202));

    // A refetch failing while the rows are on screen (after the player, «В тренде» answers 503):
    // rows, focus and scroll stay; a line says so; «Повторить» is next to «Поиск», not focused.
    await press(tv, "ArrowDown");
    await expect(tab.locator("[data-row=trending] [data-video-id]:has(.is-focused)")).toHaveCount(1);
    const before = await focusedId();
    const track = tab.locator("> div").first();
    const scrollBefore = await track.evaluate((e) => (e as HTMLElement).style.transform);
    s.failTrending = true;
    await press(tv, "Enter");
    await expect(player(tv)).toBeVisible();
    await playing(tv);
    await press(tv, "Escape");
    await expect(player(tv)).toHaveCount(0);
    await expect(tv.getByTestId("video-load-error")).toBeVisible({ timeout: 10_000 });
    await expect(tab.locator("section[data-row]")).toHaveCount(5);
    await expect(tab.locator("[data-row=trending]")).toHaveAttribute("data-failed", "1");
    await expect(tab.locator("[data-row=trending] [data-video-id]")).not.toHaveCount(0);
    await expect(focusedId()).resolves.toBe(before);
    expect(await track.evaluate((e) => (e as HTMLElement).style.transform)).toBe(scrollBefore);
    expect(await inView()).toBe(true);
    await expect(tv.getByTestId("video-unavailable")).toHaveCount(0);
    await expect(tv.getByTestId("video-retry")).toBeVisible();
    await expect(tv.locator(".is-focused", { hasText: "Повторить" })).toHaveCount(0);
    await tv.screenshot({ path: `${SHOTS}/refetch-failed-kinozal.png` });
    // Keys still move through the rows while it's down.
    await press(tv, "ArrowRight");
    await expect(focusedCard()).toHaveCount(1);
    await press(tv, "ArrowLeft");
    await expect(focusedId()).resolves.toBe(before);
    // The service is back: the next automatic retry clears the line, focus stays.
    s.failTrending = false;
    await expect(tv.getByTestId("video-load-error")).toHaveCount(0, { timeout: 15_000 });
    await expect(focusedId()).resolves.toBe(before);

    // The phone sends a video; DeviceState.video carries title, channel, position, quality.
    const r = await sendCommand(phone, deviceId, { type: "video.play", payload: { video_id: vid(3), position_seconds: 5 } });
    expect(r.body?.ok).toBe(true);
    await expect(player(tv)).toHaveAttribute("data-video-id", vid(3), { timeout: 10_000 });
    await playing(tv, 5);
    await expect
      .poll(deviceVideo, { timeout: 10_000 })
      .toEqual(expect.objectContaining({ video_id: vid(3), title: TITLES[3], channel_name: "Наука и техника", paused: false, quality: 720, qualities: [1080, 720, 480, 360] }));
    expect((await deviceVideo())!.thumbnail).toMatch(/\/api\/v1\/video\/thumbs\/vi\/vid00000003\//);

    // media.pause → paused on the TV and in the state; media.seek → the position; media.resume.
    expect((await sendCommand(phone, deviceId, { type: "media.pause" })).body?.ok).toBe(true);
    await expect(player(tv)).toHaveAttribute("data-paused", "1");
    await expect.poll(async () => (await deviceVideo())?.paused).toBe(true);
    expect((await sendCommand(phone, deviceId, { type: "media.seek", payload: { position_seconds: 42 } })).body?.ok).toBe(true);
    await expect.poll(() => time(tv)).toBeGreaterThan(41);
    await expect.poll(async () => (await deviceVideo())?.position_seconds).toBe(42);
    expect((await sendCommand(phone, deviceId, { type: "media.resume" })).body?.ok).toBe(true);
    await expect(player(tv)).toHaveAttribute("data-paused", "0");
    await expect.poll(async () => (await deviceVideo())?.paused).toBe(false);

    // Quality from the phone: the same video at 1080, from where it was (not a new start).
    const sources = log.sources.length;
    const at = await time(tv);
    expect((await sendCommand(phone, deviceId, { type: "video.play", payload: { video_id: vid(3), quality: 1080, position_seconds: Math.floor(at), force: true } })).body?.ok).toBe(true);
    await expect(player(tv)).toHaveAttribute("data-quality", "1080");
    await expect.poll(() => log.sources.length).toBe(sources + 1);
    expect(log.sources.at(-1)).toEqual(expect.objectContaining({ video_id: vid(3), quality: 1080 }));
    await expect.poll(() => time(tv), { timeout: 20_000 }).toBeGreaterThan(at - 3);
    await expect.poll(async () => (await deviceVideo())?.quality).toBe(1080);

    // «Следующее видео» (media.next_episode): the first related one.
    expect((await sendCommand(phone, deviceId, { type: "media.next_episode" })).body?.ok).toBe(true);
    await expect(player(tv)).toHaveAttribute("data-video-id", vid(2), { timeout: 10_000 });
    await playing(tv);

    // TV keys: OK pauses; Back folds the pause overlay; Back again leaves (focus back on the card).
    await press(tv, "Enter");
    await expect(player(tv)).toHaveAttribute("data-paused", "1");
    await expect(tv.getByTestId("video-paused")).toBeVisible();
    await press(tv, "Escape");
    await expect(player(tv)).toBeVisible();
    await expect(tv.getByTestId("video-paused")).toHaveCount(0);
    await expect(tv.getByTestId("video-osd")).toHaveCount(0);
    await press(tv, "Escape");
    await expect(player(tv)).toHaveCount(0);
    await expect.poll(deviceVideo).toBeNull();
    await expect(focusedId()).resolves.toBe(before);
    expect(await inView()).toBe(true);
  } finally {
    await phoneCtx.request.delete(`/api/v1/devices/${deviceId}`, { headers: { "X-CSRF-Token": session.csrf_token, Origin: origin } }).catch(() => undefined);
    await phoneCtx.close();
    await tvCtx.close();
  }
});
