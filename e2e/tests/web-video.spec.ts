import { mkdirSync, readFileSync } from "node:fs";
import { expect, test, type Browser, type Page, type Route } from "@playwright/test";

// «Видео» (YouTube via Invidious) on the web: tabs (Подписки with
// «Продолжить» and the channel strip, В тренде, Поиск with suggestions and
// «Показать ещё», Смотреть позже, История), the watch page (HLS through
// hls.js, resume, progress reports, quality switch, MP4 fallback, watch
// later / subscribe, description, related), «На ТВ» (video.play with busy →
// force), the channel page, the Home card, the unavailable state, Admin →
// Сервер's Invidious card and the profile settings. Every /video,
// /admin/video, /playback/sources and /vstream call is mocked; the stream is
// the VOD fMP4 fixture (e2e/fixtures/hls). One real login for the file.

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
const SHOTS = process.env.VIDEO_SHOTS ?? "test-results/video-shots";
mkdirSync(SHOTS, { recursive: true });
const STATE = "/tmp/pw-video-web-state.json";
const HLS = (name: string) => readFileSync(new URL(`../fixtures/hls/${name}`, import.meta.url));
const CLIP = readFileSync(new URL("../fixtures/clip.webm", import.meta.url));
const TV_ID = "de71ce00-0000-4000-8000-0000000000e2";

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

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
  await req.put(`/api/v1/profiles/${profileId}/settings`, { data: { onboarding_completed: true, video_quality: 720, video_hide_shorts: true }, headers });
  await page.evaluate(([u, p]) => {
    localStorage.setItem(`martytv.active_profile.${u}`, p);
    localStorage.setItem("martytv.locale", "ru");
    // Another feature's «this device» suggestion would cover the phone page.
    localStorage.setItem("martytv.devprefs.suggest_dismissed", "1");
  }, [session.user.id as string, profileId]);
  await page.context().storageState({ path: STATE });
  await page.close();
});

test.use({ storageState: STATE });

// ---------------------------------------------------------------- data

const HOUR = 3600_000;
const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString();
const COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899", "#64748b", "#0ea5e9", "#84cc16", "#f43f5e"];
/** 11-char YouTube-style ids: vid000000a1 … */
const vid = (n: number) => `vid${String(n).padStart(8, "0")}`;
const CH = [
  { id: "UCaaaaaaaaaaaaaaaaaaaaa1", name: "Научпоп Лаб", subs: 1_450_000, verified: true },
  { id: "UCaaaaaaaaaaaaaaaaaaaaa2", name: "Кухня за 15 минут", subs: 312_000, verified: false },
  { id: "UCaaaaaaaaaaaaaaaaaaaaa3", name: "Горные тропы", subs: 48_200, verified: false },
];
const TITLES = [
  "Как устроены чёрные дыры — простое объяснение",
  "Паста карбонара: настоящий итальянский рецепт",
  "Эльбрус за 5 дней: маршрут, снаряжение, ошибки",
  "Почему небо голубое? Опыт дома",
  "Борщ, который съедят все",
  "Алтай осенью: 200 км пешком",
  "Квантовые компьютеры за 10 минут",
  "Хлеб без замеса",
  "Байкал зимой — лёд и тишина",
  "Как работает GPS",
  "Сырники как в кафе",
  "Ночёвка в палатке при −20",
];

type Item = Record<string, unknown> & { id: string; channel_id: string };
function item(n: number, o: Record<string, unknown> = {}): Item {
  const c = CH[n % 3]!;
  return {
    id: vid(n),
    title: TITLES[n % TITLES.length],
    channel_id: c.id,
    channel_name: c.name,
    channel_verified: c.verified,
    duration_seconds: 120 + n * 97,
    views: [1_234_567, 45_300, 890, 12_000_000, 3][n % 5],
    published_at: ago(5 + n * 19),
    published_text: null,
    thumbnail: `/api/v1/video/thumbs/vi/${vid(n)}/mqdefault.jpg`,
    thumbnail_hd: `/api/v1/video/thumbs/vi/${vid(n)}/hqdefault.jpg`,
    live: false,
    upcoming: false,
    short: false,
    progress: null,
    ...o,
  };
}
const chRef = (i: number, subscribed = false) => ({
  id: CH[i]!.id,
  name: CH[i]!.name,
  avatar: `/api/v1/video/thumbs/ggpht/${i}.jpg`,
  subscribers: CH[i]!.subs,
  video_count: 120,
  verified: CH[i]!.verified,
  subscribed,
});
const progress = (pos: number, dur: number) => ({ position_seconds: pos, duration_seconds: dur, finished: false, updated_at: ago(1) });

/** The watched video (vid 0): resumable at 6 s of the ~16 s fixture. */
const DETAIL_ID = vid(0);
const LONG_DESC =
  "В этом выпуске разбираемся, как устроены чёрные дыры.\n\nИсточники: https://example.org/papers/black-holes и https://arxiv.org/abs/1234.5678.\n\n00:00 Вступление\n01:10 Горизонт событий\n05:30 Излучение Хокинга\n09:00 Итоги\n\nПодписывайтесь!";

interface Log {
  sources: Record<string, unknown>[];
  progress: Record<string, unknown>[];
  later: { method: string; id: string }[];
  subs: { method: string; id: string }[];
  history: string[];
  commands: { type: string; payload: Record<string, unknown> }[];
  searches: string[];
  stream: string[];
  feeds: string[];
}

function thumbSvg(path: string) {
  const n = Number(/vid0*(\d+)/.exec(path)?.[1] ?? /ggpht\/(\d+)/.exec(path)?.[1] ?? 0);
  const color = COLORS[n % COLORS.length];
  const avatar = path.includes("ggpht");
  return avatar
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="176" height="176"><rect width="176" height="176" fill="${color}"/><circle cx="88" cy="70" r="34" fill="#fff" opacity=".85"/><rect x="34" y="114" width="108" height="50" rx="25" fill="#fff" opacity=".85"/></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="#111"/></linearGradient></defs><rect width="480" height="270" fill="url(#g)"/><circle cx="360" cy="90" r="60" fill="#fff" opacity=".18"/><path d="M0 230 L140 140 L240 200 L330 120 L480 230 L480 270 L0 270Z" fill="#000" opacity=".35"/></svg>`;
}

async function mockVideo(
  page: Page,
  opts: { busyOnce?: boolean; unavailable?: boolean; hlsBroken?: boolean; emptyLists?: boolean; longFeed?: { failOnce: number } } = {},
): Promise<Log> {
  const log: Log = { sources: [], progress: [], later: [], subs: [], history: [], commands: [], searches: [], stream: [], feeds: [] };
  const failFeed = new Set(opts.longFeed ? [opts.longFeed.failOnce] : []);
  const later = new Set(opts.emptyLists ? [] : [vid(4), vid(5)]);
  const subscribed = new Set(opts.emptyLists ? [] : [CH[0]!.id, CH[1]!.id]);
  let history = opts.emptyLists ? [] : [vid(0), vid(7), vid(8)];
  await page.routeWebSocket(/\/api\/v1\/ws/, (ws) => ws.close());
  // Backstop if the suggestion still shows (its key is seeded in beforeAll).
  await page.addLocatorHandler(page.getByTestId("devprefs-suggest"), (l) => l.getByTestId("devprefs-suggest-later").click());

  await page.route(/\/api\/v1\/video\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace("/api/v1/video", "");
    const method = req.method();
    if (path.startsWith("/thumbs/")) return route.fulfill({ status: 200, contentType: "image/svg+xml", body: thumbSvg(path) });
    if (opts.unavailable) return json(route, { error: { code: "video_unavailable", message: "Invidious is not reachable" } }, 503);
    const withState = (v: Item) => ({ ...v, progress: v.id === DETAIL_ID ? progress(6, 16) : v.id === vid(7) ? progress(300, 900) : null });
    let m: RegExpExecArray | null;
    if (path === "/feed" && opts.longFeed) {
      // 120 entries paged with offset / limit → next_offset; one page fails once.
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      log.feeds.push(`${offset}+${limit}`);
      if (failFeed.delete(offset)) return json(route, { error: { code: "video_unavailable", message: "down" } }, 503);
      const items = Array.from({ length: Math.max(0, Math.min(limit, 120 - offset)) }, (_, i) => withState(item(100 + offset + i)));
      return json(route, { items, refreshed_at: ago(0.3), next_offset: offset + limit < 120 ? offset + limit : null });
    }
    if (path === "/feed") return json(route, { items: [...subscribed].length ? [1, 2, 3, 6, 9, 10, 11].map((n) => withState(item(n))).filter((v) => subscribed.has(v.channel_id)) : [], refreshed_at: ago(0.3) });
    if (path === "/subscriptions") return json(route, { items: CH.map((_, i) => ({ ...chRef(i, true), created_at: ago(100) })).filter((c) => subscribed.has(c.id)) });
    if (path === "/continue") return json(route, { items: opts.emptyLists ? [] : [withState(item(0)), withState(item(7))] });
    if (path === "/trending") return json(route, { items: [0, 1, 2, 3, 4, 5, 6, 7].map((n) => withState(item(n + 20, { title: TITLES[n] }))) });
    if (path === "/watch-later" && method === "GET") return json(route, { items: [...later].map((id) => withState(item(Number(id.slice(3))))) });
    if (path === "/history" && method === "GET") return json(route, { items: history.map((id) => withState(item(Number(id.slice(3))))) });
    if ((m = /^\/watch-later\/([\w-]{11})$/.exec(path))) {
      log.later.push({ method, id: m[1]! });
      if (method === "PUT") later.add(m[1]!);
      else later.delete(m[1]!);
      return route.fulfill({ status: 204 });
    }
    if ((m = /^\/history\/([\w-]{11})$/.exec(path))) {
      log.history.push(m[1]!);
      history = history.filter((x) => x !== m![1]);
      return route.fulfill({ status: 204 });
    }
    if ((m = /^\/subscriptions\/([\w-]+)$/.exec(path))) {
      log.subs.push({ method, id: m[1]! });
      if (method === "PUT") subscribed.add(m[1]!);
      else subscribed.delete(m[1]!);
      return route.fulfill({ status: 204 });
    }
    if (path === "/search/suggestions") {
      const q = url.searchParams.get("q") ?? "";
      return json(route, { items: [`${q} объяснение`, `${q} для детей`, `${q} документальный`].slice(0, 3) });
    }
    if (path === "/search") {
      const q = url.searchParams.get("q") ?? "";
      const pg = Number(url.searchParams.get("page") ?? 1);
      log.searches.push(`${q}#${pg}`);
      const base = pg === 1 ? [0, 3, 6, 9, 10, 11] : pg === 2 ? [12, 13, 14] : [];
      return json(route, { videos: base.map((n) => withState(item(n))), channels: pg === 1 ? [chRef(0, subscribed.has(CH[0]!.id))] : [], playlists: [], page: pg });
    }
    if (path === "/progress") {
      log.progress.push(req.postDataJSON() as Record<string, unknown>);
      return route.fulfill({ status: 204 });
    }
    if ((m = /^\/videos\/([\w-]{11})$/.exec(path))) {
      const n = Number(m[1]!.slice(3));
      const base = withState(item(n));
      return json(route, {
        ...base,
        description: n === 0 ? LONG_DESC : "Короткое описание.",
        likes: 48_200,
        genre: "Education",
        channel: chRef(n % 3, subscribed.has(base.channel_id)),
        related: [1, 2, 3, 4, 5, 6].map((r) => withState(item(n + r))),
        in_watch_later: later.has(m[1]!),
        qualities: [1080, 720, 480, 360],
        captions: [{ label: "Русский", language: "ru" }],
        playable: true,
      });
    }
    if ((m = /^\/channels\/([\w-]+)\/videos$/.exec(path))) {
      return json(route, { items: [30, 31, 32, 33].map((n) => item(n)), continuation: null });
    }
    if ((m = /^\/channels\/([\w-]+)$/.exec(path))) {
      const i = Math.max(0, CH.findIndex((c) => c.id === m![1]));
      return json(route, {
        ...chRef(i, subscribed.has(CH[i]!.id)),
        banner: null,
        description: "Научно-популярные видео каждую неделю: космос, физика, технологии.",
        videos: [0, 3, 6, 9, 12, 15, 18, 21].map((n) => item(n)),
        continuation: "page2",
      });
    }
    return json(route, { error: { code: "not_found", message: path } }, 404);
  });

  let tokens = 0;
  await page.route(/\/api\/v1\/playback\/sources$/, (route) => {
    const body = route.request().postDataJSON() as { video_id: string; quality?: number };
    log.sources.push(body);
    tokens++;
    const base = `/api/v1/vstream/tok${tokens}/`;
    return json(
      route,
      {
        id: `5e1ec7ed-0000-4000-8000-${String(tokens).padStart(12, "0")}`, media_id: null, episode_id: null, release: null, status: "ready", error: null, file: null,
        stream_url: `${base}master.m3u8`, stream_expires_at: new Date(Date.now() + 3600_000).toISOString(), mime_type: "application/vnd.apple.mpegurl",
        media_info: null, torrent: null, created_at: new Date().toISOString(), kind: "video", video_id: body.video_id, provider: { id: "youtube", name: "YouTube", kind: "online" },
        format: "hls", quality: body.quality ?? 720, qualities: [1080, 720, 480, 360], subtitles: [{ url: `${base}cc0.vtt`, lang: "ru", label: "Русский" }],
        fallback_url: `${base}p18.mp4`, position_seconds: body.video_id === DETAIL_ID ? 6 : null, duration_seconds: 16,
      },
      201,
    );
  });
  await page.route(/\/api\/v1\/vstream\//, (route) => {
    const file = new URL(route.request().url()).pathname.split("/").at(-1)!;
    log.stream.push(file);
    if (file === "master.m3u8") {
      if (opts.hlsBroken) return route.fulfill({ status: 502, body: "" });
      return route.fulfill({ status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" }, body: HLS("index.m3u8") });
    }
    if (file === "cc0.vtt") return route.fulfill({ status: 200, headers: { "Content-Type": "text/vtt" }, body: "WEBVTT\n\n00:00.000 --> 00:04.000\nПривет!\n" });
    if (file === "p18.mp4") return route.fulfill({ status: 200, headers: { "Content-Type": "video/webm" }, body: CLIP });
    if (/^(init\.mp4|seg\d\.m4s)$/.test(file)) return route.fulfill({ status: 200, headers: { "Content-Type": "video/mp4" }, body: HLS(file) });
    return route.fulfill({ status: 404, body: "" });
  });

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

async function playing(page: Page, min = 0.5) {
  await expect.poll(() => page.getByTestId("video-element").evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20_000 }).toBeGreaterThan(min);
}

// ---------------------------------------------------------------- phone

test.describe("Видео on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, locale: "ru-RU", hasTouch: true, isMobile: true });

  test("Home card, Подписки (continue, channels, feed), В тренде", async ({ page }) => {
    await mockVideo(page);
    await page.goto("/");
    const card = page.getByTestId("video-home-card");
    await expect(card.getByTestId("video-home-continue")).toContainText(TITLES[0]!);
    await card.getByTestId("video-home-open").click();
    await expect(page).toHaveURL(/\/video$/);
    await expect(page.getByTestId("video-tab-subscriptions")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("video-continue").getByTestId("video-card")).toHaveCount(2);
    await expect(page.getByTestId("video-continue").getByTestId("video-progress").first()).toBeVisible();
    await expect(page.getByTestId("video-sub-channel")).toHaveCount(2);
    const grid = page.getByTestId("video-grid").last();
    await expect(grid.getByTestId("video-card").first()).toBeVisible();
    await expect(grid.getByTestId("video-meta").first()).toContainText(/просмотр/);
    await expect(grid.getByTestId("video-duration").first()).toHaveText(/^\d+:\d\d$/);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/web-video-phone-subscriptions.png` });

    await page.getByTestId("video-tab-trending").click();
    await expect(page).toHaveURL(/tab=trending/);
    await expect(page.getByTestId("video-card")).toHaveCount(8);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/web-video-phone-trending.png` });
  });

  test("Поиск: suggestions, channel + videos, «Показать ещё», subscribe", async ({ page }) => {
    const log = await mockVideo(page);
    await page.goto("/video?tab=search");
    await expect(page.getByText("Ищите видео и каналы на YouTube.")).toBeVisible();
    const input = page.getByTestId("video-search-input");
    await input.fill("чёрные дыры");
    const sugg = page.getByTestId("video-suggestions");
    await expect(sugg.getByTestId("video-suggestion")).toHaveCount(3);
    await page.screenshot({ path: `${SHOTS}/web-video-phone-suggestions.png` });
    await sugg.getByTestId("video-suggestion").first().click();
    await expect(page).toHaveURL(/q=%D1%87/);
    await expect(input).toHaveValue("чёрные дыры объяснение");
    const results = page.getByTestId("video-search-results");
    await expect(results.getByTestId("video-channel-result")).toContainText("Научпоп Лаб");
    await expect(results.getByTestId("video-card")).toHaveCount(6);
    // Scrolling to the end loads the next page by itself (page 3 is empty: the end).
    await results.getByTestId("video-card").last().scrollIntoViewIfNeeded();
    await expect(results.getByTestId("video-card")).toHaveCount(9);
    expect(log.searches.slice(0, 2)).toEqual(["чёрные дыры объяснение#1", "чёрные дыры объяснение#2"]);
    await page.evaluate(() => window.scrollTo(0, 0));
    // The channel is already subscribed: unsubscribe.
    const sub = results.getByTestId("video-channel-result").getByTestId("video-subscribe");
    await expect(sub).toHaveAttribute("aria-pressed", "true");
    await sub.click();
    await expect(sub).toHaveAttribute("aria-pressed", "false");
    expect(log.subs).toEqual([{ method: "DELETE", id: CH[0]!.id }]);
    await page.screenshot({ path: `${SHOTS}/web-video-phone-search.png` });
    // Submitting with Enter works too.
    await input.fill("борщ");
    await input.press("Enter");
    await expect(page).toHaveURL(/q=%D0%B1%D0%BE%D1%80%D1%89/);
  });

  test("watch: resume, progress, quality, watch later, description, related", async ({ page }) => {
    const log = await mockVideo(page);
    await page.goto("/video?tab=trending");
    await page.goto(`/video/watch/${DETAIL_ID}`);
    await expect(page.getByTestId("video-watch-title")).toHaveText(TITLES[0]!);
    await playing(page, 6);
    expect(log.sources[0]).toEqual({ kind: "video", video_id: DETAIL_ID, profile_id: profileId });
    await expect(page.getByTestId("video-resumed")).toContainText("Продолжить с 0:06");
    await expect(page.getByTestId("video-element")).toHaveAttribute("data-mode", "hls");
    expect(log.stream).toContain("seg1.m4s");
    // Pause → a progress report.
    await page.getByTestId("video-element").evaluate((v: HTMLVideoElement) => v.pause());
    await expect.poll(() => log.progress.length).toBeGreaterThan(0);
    const rep = log.progress.at(-1)!;
    expect(rep).toMatchObject({ profile_id: profileId, video_id: DETAIL_ID, duration_seconds: 16 });
    expect(rep.position_seconds as number).toBeGreaterThanOrEqual(6);
    await page.screenshot({ path: `${SHOTS}/web-video-phone-watch.png` });

    // Quality: a new source with the cap, playback continues from the same spot.
    // (dev StrictMode may POST the first source twice)
    const before = log.sources.length;
    await page.getByTestId("video-quality").selectOption("480");
    await expect.poll(() => log.sources.length).toBeGreaterThan(before);
    expect(log.sources.at(-1)).toEqual({ kind: "video", video_id: DETAIL_ID, profile_id: profileId, quality: 480 });
    await expect(page.getByTestId("video-quality")).toHaveValue("480");
    await expect.poll(() => page.getByTestId("video-element").evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThanOrEqual(6);
    // «С начала».
    await page.getByTestId("video-from-start").click();
    await expect(page.getByTestId("video-resumed")).toHaveCount(0);

    // Watch later + subscribe.
    const later = page.getByTestId("video-watch-later");
    await expect(later).toHaveAttribute("aria-pressed", "false");
    await later.click();
    await expect(later).toHaveAttribute("aria-pressed", "true");
    await expect(later).toContainText("В «Смотреть позже»");
    expect(log.later).toEqual([{ method: "PUT", id: DETAIL_ID }]);
    await expect(page.getByTestId("video-watch-channel")).toContainText("Научпоп Лаб");

    // Description: collapsed, links open outside.
    const desc = page.getByTestId("video-description");
    await expect(desc.getByRole("link", { name: "https://example.org/papers/black-holes" })).toHaveAttribute("target", "_blank");
    await desc.getByTestId("video-description-toggle").click();
    await expect(desc.getByTestId("video-description-toggle")).toHaveText("Свернуть");

    // Related → another video (a new source).
    const related = page.getByTestId("video-related").getByTestId("video-row");
    await expect(related).toHaveCount(6);
    await related.first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/web-video-phone-watch-related.png` });
    await related.first().click();
    await expect(page).toHaveURL(new RegExp(`/video/watch/${vid(1)}$`));
    await expect.poll(() => log.sources.at(-1)?.video_id).toBe(vid(1));
    // Leaving the first video flushed its position.
    expect(log.progress.some((p) => p.video_id === DETAIL_ID)).toBeTruthy();
  });

  test("HLS failure falls back to the progressive MP4", async ({ page }) => {
    await mockVideo(page, { hlsBroken: true });
    await page.goto(`/video/watch/${vid(2)}`);
    await expect(page.getByTestId("video-element")).toHaveAttribute("data-mode", "mp4", { timeout: 20_000 });
    await expect(page.getByTestId("video-fallback")).toHaveText("Упрощённый режим (360p)");
    await playing(page, 0.2);
    await expect(page.getByTestId("video-quality")).toHaveCount(0);
  });

  test("«На ТВ»: video.play with the position, busy → interrupt → force", async ({ page }) => {
    const log = await mockVideo(page, { busyOnce: true });
    await page.goto(`/video/watch/${DETAIL_ID}`);
    await playing(page, 6);
    await page.getByTestId("video-element").evaluate((v: HTMLVideoElement) => v.pause());
    await page.getByTestId("video-send-tv").click();
    await expect(page.getByTestId("busy-dialog")).toBeVisible();
    await page.getByRole("button", { name: /Прервать|Interrupt/ }).click();
    await expect(page.getByTestId("send-result")).toHaveAttribute("data-outcome", "sent");
    expect(log.commands).toHaveLength(2);
    expect(log.commands[0]).toMatchObject({ type: "video.play", payload: { video_id: DETAIL_ID, profile_id: profileId } });
    expect(log.commands[0]!.payload.position_seconds as number).toBeGreaterThanOrEqual(6);
    expect(log.commands[1]).toMatchObject({ type: "video.play", payload: { video_id: DETAIL_ID, force: true } });
    await page.screenshot({ path: `${SHOTS}/web-video-phone-send.png` });
  });

  test("Смотреть позже and История: remove; channel page", async ({ page }) => {
    const log = await mockVideo(page);
    await page.goto("/video?tab=watch_later");
    await expect(page.getByTestId("video-card")).toHaveCount(2);
    await page.getByTestId("video-remove-later").first().click();
    await expect(page.getByTestId("video-card")).toHaveCount(1);
    expect(log.later).toEqual([{ method: "DELETE", id: vid(4) }]);

    await page.getByTestId("video-tab-history").click();
    const hist = page.getByTestId("video-history");
    await expect(hist.getByTestId("video-row")).toHaveCount(3);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/web-video-phone-history.png` });
    await hist.getByTestId("video-remove-history").first().click();
    await expect(hist.getByTestId("video-row")).toHaveCount(2);
    expect(log.history).toEqual([vid(0)]);

    // Channel page from a card.
    await hist.getByTestId("video-row").first().click();
    await page.getByTestId("video-watch-channel").click();
    // History is now vid 7, vid 8: vid 7 belongs to the second channel.
    await expect(page.getByTestId("video-channel-name")).toHaveText("Кухня за 15 минут");
    await expect(page.getByTestId("video-channel-page").getByTestId("video-card")).toHaveCount(8);
    // Infinite scroll through the continuation.
    await page.getByTestId("video-channel-page").getByTestId("video-card").last().scrollIntoViewIfNeeded();
    await expect(page.getByTestId("video-channel-page").getByTestId("video-card")).toHaveCount(12);
    await expect(page.getByTestId("video-load-more-box")).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/web-video-phone-channel.png` });
  });

  test("Подписки: infinite scroll; a failed page keeps the list and retries by itself", async ({ page }) => {
    const log = await mockVideo(page, { longFeed: { failOnce: 50 } });
    await page.goto("/video");
    const grid = page.getByTestId("video-grid").last();
    await expect(grid.getByTestId("video-card")).toHaveCount(50);
    expect(log.feeds[0]).toBe("0+50");
    // Near the end: the next page (fails once → inline message, the cards stay, then the retry).
    await grid.getByTestId("video-card").last().scrollIntoViewIfNeeded();
    await expect(page.getByTestId("video-load-failed")).toBeVisible();
    await expect(grid.getByTestId("video-card")).toHaveCount(50);
    const y = await page.evaluate(() => window.scrollY);
    expect(y).toBeGreaterThan(1000);
    await page.screenshot({ path: `${SHOTS}/web-video-phone-feed-failed.png` });
    await expect(grid.getByTestId("video-card")).toHaveCount(100, { timeout: 10_000 });
    await expect(page.getByTestId("video-load-failed")).toHaveCount(0);
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - y)).toBeLessThan(400);
    await grid.getByTestId("video-card").last().scrollIntoViewIfNeeded();
    await expect(grid.getByTestId("video-card")).toHaveCount(120);
    await expect(page.getByTestId("video-load-more-box")).toHaveCount(0);
    expect(log.feeds.filter((f) => f === "50+50")).toHaveLength(2);
    expect(log.feeds).toContain("100+50");
  });

  test("remote: a YouTube video on the TV gets the playback controls", async ({ page }) => {
    const log = await mockVideo(page);
    const video = {
      video_id: DETAIL_ID,
      title: TITLES[0],
      channel_id: CH[0]!.id,
      channel_name: CH[0]!.name,
      thumbnail: `/api/v1/video/thumbs/vi/${DETAIL_ID}/mqdefault.jpg`,
      position_seconds: 95,
      duration_seconds: 600,
      paused: false,
      buffering: false,
      quality: 720,
      qualities: [1080, 720, 480, 360],
      volume: 1,
      error: null,
    };
    await page.route(/\/api\/v1\/devices\/[^/]+\/state/, (route) =>
      json(route, { online: true, state: { screen: "player", profile_id: profileId, profile_name: "E2E", media_id: null, kind: null, title: TITLES[0], poster_path: null, season_number: null, playback: null, video } }),
    );
    await page.goto(`/remote/${TV_ID}`);
    const now = page.getByTestId("now-on-tv");
    await expect(now).toHaveAttribute("data-video-id", DETAIL_ID);
    await expect(page.getByTestId("now-on-tv-title")).toHaveText(TITLES[0]!);
    await expect(now).toContainText(CH[0]!.name);
    await expect(page.getByTestId("now-on-tv-thumb")).toBeVisible();
    await expect(page.getByTestId("now-status")).toHaveText("Воспроизводится");
    await expect(now).toContainText("1:35");
    const pb = page.getByTestId("remote-playback");
    await expect(pb).toHaveAttribute("data-kind", "video");
    await expect(page.getByTestId("playback-soon")).toHaveCount(0);
    await expect(pb.getByRole("button", { name: "Пауза" })).toBeEnabled();
    await expect(page.getByTestId("remote-video-related").first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/web-remote-video.png`, fullPage: true });

    await pb.getByRole("button", { name: "Пауза" }).click();
    await expect.poll(() => log.commands.length).toBe(1);
    await pb.getByRole("button", { name: "Вперёд на 30 секунд" }).click();
    await expect.poll(() => log.commands.length).toBe(2);
    await page.getByTestId("remote-video-quality").selectOption("1080");
    await expect.poll(() => log.commands.length).toBe(3);
    await page.getByTestId("remote-video-related").first().click();
    await expect.poll(() => log.commands.length).toBe(4);
    await page.getByTestId("remote-video-stop").click();
    await expect.poll(() => log.commands.length).toBe(5);
    const related = await page.getByTestId("remote-video-related").first().getAttribute("data-video-id");
    expect(log.commands).toEqual([
      { type: "media.pause", payload: undefined },
      { type: "media.seek", payload: { position_seconds: 125 } },
      { type: "video.play", payload: { video_id: DETAIL_ID, quality: 1080, position_seconds: 95, force: true } },
      { type: "video.play", payload: { video_id: related, force: true } },
      { type: "media.stop", payload: undefined },
    ]);
    // The floating mini-bar elsewhere shows the video too.
    await page.goto("/video?tab=trending");
    await expect(page.getByTestId("now-on-tv-bar")).toHaveAttribute("data-video-id", DETAIL_ID);
    await expect(page.getByTestId("now-on-tv-bar")).toContainText(TITLES[0]!);
  });

  test("empty lists and the unavailable service", async ({ page }) => {
    await mockVideo(page, { emptyLists: true });
    await page.goto("/video");
    await expect(page.getByTestId("video-empty")).toContainText("Подпишитесь на каналы");
    await page.getByTestId("video-tab-watch_later").click();
    await expect(page.getByTestId("video-empty")).toContainText("Пока ничего не отложено.");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await mockVideo(page, { unavailable: true });
    await page.goto("/video?tab=trending");
    await expect(page.getByTestId("video-unavailable")).toContainText("сервис YouTube не отвечает");
    await page.screenshot({ path: `${SHOTS}/web-video-phone-unavailable.png` });
  });
});

// ---------------------------------------------------------------- desktop

test.describe("Видео on desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 }, locale: "ru-RU" });

  test("top nav, grid, watch page with the related column", async ({ page }) => {
    await mockVideo(page);
    await page.goto("/");
    const nav = page.locator("header nav");
    await nav.getByRole("link", { name: "Видео", exact: true }).click();
    await expect(page).toHaveURL(/\/video$/);
    await expect(nav.getByRole("link", { name: "Видео", exact: true })).toHaveClass(/bg-surface-2/);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/web-video-desktop-subscriptions.png` });
    await page.goto(`/video/watch/${DETAIL_ID}`);
    await playing(page, 6);
    const box = await page.getByTestId("video-related").boundingBox();
    expect(box!.x).toBeGreaterThan(900);
    await page.screenshot({ path: `${SHOTS}/web-video-desktop-watch.png` });
  });

  test("settings rows and Admin → Сервер Invidious card", async ({ page }) => {
    await mockVideo(page);
    let checks = 0;
    await page.route(/\/api\/v1\/admin\/video\/status/, (route) => {
      if (new URL(route.request().url()).searchParams.get("check")) checks++;
      return json(route, {
        configured: true, reachable: true, version: "2.20260804.1", latency_ms: 84, checked_at: ago(0.01), last_error: "GET /api/v1/videos/xyz: 500 Internal Server Error",
        last_error_at: ago(3), last_ok_at: ago(0.01), subscriptions: 7, channels: 5, feed_videos: 150, feed_refreshed_at: ago(0.2),
      });
    });
    const puts: Record<string, unknown>[] = [];
    await page.route(/\/api\/v1\/profiles\/[^/]+\/settings$/, async (route) => {
      if (route.request().method() === "PUT") puts.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fallback();
    });
    await page.goto("/settings");
    await page.getByTestId("setting-video-quality").selectOption("1080");
    await expect.poll(() => puts.some((p) => p.video_quality === 1080)).toBeTruthy();
    await page.getByTestId("setting-video-hide-shorts").click();
    await expect.poll(() => puts.some((p) => p.video_hide_shorts === false)).toBeTruthy();
    await page.getByTestId("setting-video-quality").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/web-video-desktop-settings.png` });
    // Restore the defaults.
    await page.getByTestId("setting-video-quality").selectOption("720");
    await page.getByTestId("setting-video-hide-shorts").click();
    await expect.poll(() => puts.filter((p) => p.video_hide_shorts === true).length).toBeGreaterThan(0);

    await page.goto("/admin");
    await page.getByRole("tab", { name: /Сервер|Server/ }).click();
    const card = page.getByTestId("admin-video");
    await expect(card).toContainText("2.20260804.1");
    await expect(card).toContainText("84 мс");
    await expect(page.getByTestId("admin-video-state")).toHaveText("Доступен");
    await expect(page.getByTestId("admin-video-error")).toContainText("500 Internal Server Error");
    await page.getByTestId("admin-video-check").click();
    await expect.poll(() => checks).toBe(1);
    await page.getByTestId("admin-video").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/web-video-desktop-admin.png` });
  });
});
