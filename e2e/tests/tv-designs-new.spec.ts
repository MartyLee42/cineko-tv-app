import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

/** The later designs and the skeleton each one is drawn on. */
const NEW = [
  { design: "wireframe", skeleton: "projector", bg: "synthwave" },
  { design: "cyberpunk", skeleton: "terminal", bg: "city" },
  { design: "deco", skeleton: "kinozal", bg: "lacquer" },
  { design: "retro80", skeleton: "kinozal", bg: "vhs" },
  { design: "retro90", skeleton: "terminal", bg: "desktop" },
  { design: "popart", skeleton: "projector", bg: "comic" },
  { design: "constructivism", skeleton: "terminal", bg: "poster" },
  { design: "matrix", skeleton: "terminal", bg: "rain" },
] as const;
type NewDesign = (typeof NEW)[number];

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function press(tv: Page, key: string, times = 1) {
  for (let i = 0; i < times; i++) {
    await tv.keyboard.press(key);
    await tv.waitForTimeout(170);
  }
}

// ---- viewport assertions (as in tv-scroll.spec.ts)
const focused = (tv: Page) => tv.locator(".is-focused").last();
const focusKey = (tv: Page) => tv.evaluate(() => (window as unknown as { __focusKey: () => string }).__focusKey());

/**
 * The focused element is fully on screen, below the top chrome (≥ 80) and
 * above the very bottom (≤ 1000; Home rows: on screen, ≤ 1080 — Проектор's
 * current row sits at the bottom edge by design).
 */
async function expectInView(tv: Page, what: string, maxBottom = 1000) {
  await tv.waitForTimeout(320);
  await expect.poll(async () => !!(await focused(tv).boundingBox()), { message: `${what}: focused element` }).toBe(true);
  const b = (await focused(tv).boundingBox())!;
  expect(b.y, `${what}: top ${b.y}`).toBeGreaterThanOrEqual(80);
  expect(b.y + b.height, `${what}: bottom ${b.y + b.height}`).toBeLessThanOrEqual(maxBottom);
  expect(b.x, `${what}: left`).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width, `${what}: right`).toBeLessThanOrEqual(1920);
}

const RELEASES = [1, 2, 3].map((i) => ({
  id: `rel-${i}`, title: `Mock.Release.${i}`, indexer: "MockTracker", size_bytes: (2 + i) * 1024 ** 3, seeders: 100 - i, leechers: 1, published_at: null, info_hash: null,
  resolution: "1080p", video_codec: "h264", hdr: null, audio_codecs: ["ac3"], languages: ["ru"], voiceovers: [{ kind: "dub", studio: null, language: "ru" }],
  release_group: null, source_quality: "web-dl", year: 2024, seasons: [], episodes: [], is_season_pack: false, confidence: 0.95, score: 1, reasons: [], warnings: [],
}));

async function mockBackend(ctx: BrowserContext, design: string) {
  await ctx.unrouteAll({ behavior: "ignoreErrors" });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
    if (route.request().method() !== "GET") return json(route, {});
    const res = await route.fetch().catch(() => null);
    const body = res && res.ok() ? await res.json() : {};
    return json(route, { ...body, design, theme: "dark", onboarding_completed: true });
  });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, (route) => json(route, { items: [] }));
  await ctx.route(/\/api\/v1\/recommendations\/inbox/, (route) => json(route, { items: [], unseen: 0 }));
  await ctx.route(/\/api\/v1\/messages(\?.*)?$/, (route) => json(route, { items: [], unread: 0 }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/progress/, (route) => json(route, { media_id: "x", kind: "movie", movie: null, episodes: [], seasons: [], next_up: null }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) => json(route, { items: RELEASES, searched_at: new Date().toISOString(), cached: true, indexer_errors: [] }));
  await ctx.route(/\/api\/v1\/playback\//, (route) => json(route, { error: { code: "not_found", message: "mocked" } }, 404));
  await ctx.route(/\/api\/v1\/foryou\/rows/, (route) => json(route, { profile_id: "p", generated_at: null, stale: false, cold_start: true, rows: [] }));
}

const rail = (d: NewDesign) => d.skeleton === "kinozal";

async function intoMenu(tv: Page, d: NewDesign) {
  const inMenu = () => tv.locator('nav [data-nav-focused="1"]').count();
  await expect.poll(async () => (await inMenu()) + (await tv.locator(".is-focused").count())).toBeGreaterThan(0);
  for (let i = 0; i < 12 && !(await inMenu()); i++) await press(tv, rail(d) ? "ArrowLeft" : "ArrowUp");
  await expect(tv.locator('nav [data-nav-focused="1"]'), `${d.design}: focus reaches the menu`).toHaveCount(1);
}

async function pick(tv: Page, d: NewDesign, id: string) {
  const order = await tv.locator("nav [data-menu]").evaluateAll((els) => els.map((e) => e.getAttribute("data-menu")));
  for (let i = 0; i < 14; i++) {
    const cur = await tv.locator('nav [data-nav-focused="1"]').getAttribute("data-menu");
    if (cur === id) break;
    const forward = order.indexOf(id) > order.indexOf(cur);
    await press(tv, rail(d) ? (forward ? "ArrowDown" : "ArrowUp") : forward ? "ArrowRight" : "ArrowLeft");
  }
  await expect(tv.locator(`nav [data-menu="${id}"]`)).toHaveAttribute("data-nav-focused", "1");
  await press(tv, "Enter");
}

const homeVisible = (tv: Page) => expect(tv.locator("[data-row=trending]")).toBeVisible({ timeout: 20_000 });

/**
 * Каркас / Киберпанк / Ар-деко: each renders its skeleton's shell with its
 * own skin (html classes, background layer, ornaments), keeps the shared
 * menu order (incl. «ТВ»), and Home → Details, Browse and Settings work with
 * the focused element always on screen.
 */
test("TV new designs: skin on skeleton, Details / Browse / Settings, focus in view", async ({ browser }) => {
  test.setTimeout(300_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: "en-US" });
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
    expect((await phoneCtx.request.post("/api/v1/profiles", { data: { name: "E2E", color: "#6366f1" }, headers: { "X-CSRF-Token": session.csrf_token, Origin: origin } })).ok()).toBeTruthy();
  }

  await mockBackend(tvCtx, "kinozal");
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Skins TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  try {
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");

    for (const d of NEW) {
      await mockBackend(tvCtx, d.design);
      await tv.reload();
      // Shell: the skeleton's layout and nav with the skin's classes and background.
      await expect(tv.locator(`[data-design-skin="${d.design}"]`)).toBeVisible({ timeout: 30_000 });
      await expect(tv.locator(`[data-design-shell="${d.skeleton}"]`)).toBeVisible();
      await expect(tv.locator(`nav[data-design-nav="${d.skeleton}"]`)).toBeVisible();
      await expect(tv.locator(`[data-skin-bg="${d.bg}"]`)).toHaveCount(1);
      const cls = await tv.evaluate(() => document.documentElement.className);
      expect(cls).toContain(`design-${d.design}`);
      expect(cls).toContain(`skel-${d.skeleton}`);
      // Shared menu order: «ТВ», Explore… appear like in the skeleton's original design.
      await expect(tv.locator('nav [data-menu="tv"]')).toHaveCount(1);
      await expect(tv.locator('nav [data-menu="explore"]')).toHaveCount(1);
      await homeVisible(tv);
      // Поп-арт: one «БАМ!» burst over the Home hero artwork.
      if (d.design === "popart") await expect(tv.locator(".pa-burst")).toHaveCount(1);

      // Home rows: focus stays in view while moving down.
      await expect.poll(() => focusKey(tv)).toMatch(/^(row-|hero-)/);
      if ((await focusKey(tv)).startsWith("hero-")) await press(tv, "ArrowDown");
      for (let i = 0; i < 3; i++) {
        await press(tv, "ArrowDown");
        await expectInView(tv, `${d.design}: home row ${i + 2}`, 1080);
      }
      // Back from a lower row: the menu, and it stays there (the rows that
      // scroll away must not pull focus back ~300 ms later); then the next
      // two presses reach «Видео» and one back reaches «ТВ» (none skipped).
      await press(tv, "Escape");
      await expect.poll(() => focusKey(tv)).toBe("menu-home");
      await tv.waitForTimeout(700);
      expect(await focusKey(tv), `${d.design}: focus stays on the menu`).toBe("menu-home");
      const next = rail(d) ? "ArrowDown" : "ArrowRight";
      const prev = rail(d) ? "ArrowUp" : "ArrowLeft";
      await press(tv, next, 2);
      await expect.poll(() => focusKey(tv)).toBe("menu-video");
      await press(tv, prev);
      await expect.poll(() => focusKey(tv)).toBe("menu-tv");
      await press(tv, prev);
      await expect.poll(() => focusKey(tv)).toBe("menu-home");
      // Back into the rows: the first row.
      await press(tv, rail(d) ? "ArrowRight" : "ArrowDown");
      if ((await focusKey(tv)).startsWith("hero-")) await press(tv, "ArrowDown");
      // «Конструктивизм» always puts «Рекомендуем к просмотру» («Ленин в Октябре») first.
      await expect.poll(() => focusKey(tv)).toMatch(d.design === "constructivism" ? /^row-(cv-lenin|trending)-/ : /^row-trending-/);

      // Details: opens, the header is on screen, the skin's ornament is there; Back restores Home.
      await press(tv, "Enter");
      const details = tv.locator("[data-media-id]");
      await expect(details.locator("h1")).not.toBeEmpty({ timeout: 20_000 });
      await expect.poll(() => focusKey(tv)).toBe("d-play");
      await expectInView(tv, `${d.design}: details play`);
      const h1 = (await details.locator("h1").boundingBox())!;
      expect(h1.y, `${d.design}: title on screen`).toBeGreaterThan(0);
      if (d.design === "deco") await expect(tv.getByTestId("marquee")).toBeVisible();
      if (d.design === "cyberpunk") await expect(tv.getByTestId("sources-table")).toBeVisible();
      // Down through the lower sections and back up to Play.
      for (let i = 0; i < 3; i++) {
        await press(tv, "ArrowDown");
        await expectInView(tv, `${d.design}: details section ${i + 1}`);
      }
      await press(tv, "Escape");
      await expect.poll(() => focusKey(tv)).toBe("d-play");
      await press(tv, "Escape");
      await homeVisible(tv);

      // Browse: the grid scrolls with focus in view; cards carry the skin's frame.
      await intoMenu(tv, d);
      await pick(tv, d, "movies");
      await expect(tv.locator("[data-focus-key^=b-] [data-card-id]").first()).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => focusKey(tv)).toMatch(/^b-/);
      for (let i = 0; i < 4; i++) {
        await press(tv, "ArrowDown");
        await expectInView(tv, `${d.design}: browse row ${i + 2}`);
      }
      if (d.design === "cyberpunk") {
        // Clipped corners on idle cards (prefixed for old engines), none on the focused one.
        const clip = await tv.locator(".mt-card:not(.is-focused)").first().evaluate((el) => {
          const s = getComputedStyle(el) as CSSStyleDeclaration & { webkitClipPath?: string };
          return s.clipPath || s.webkitClipPath || "";
        });
        expect(clip).toContain("polygon");
      }
      await press(tv, "Escape");
      await expect(tv.locator('nav [data-nav-focused="1"]')).toHaveCount(1);
      await press(tv, "Escape");
      await homeVisible(tv);

      // Settings: the design row shows every design's preview tile; Back closes.
      await intoMenu(tv, d);
      await pick(tv, d, "settings");
      await expect(tv.getByTestId("tv-settings")).toBeVisible();
      await expect(tv.getByTestId("design-previews").locator("[data-design-tile]")).toHaveCount(11);
      await expect(tv.locator(`[data-design-tile="${d.design}"]`)).toHaveAttribute("data-active", "1");
      await expect(tv.locator('[data-setting="calm_motion"]')).toHaveCount(d.design === "wireframe" ? 1 : 0);
      await press(tv, "Escape");
      await expect(tv.getByTestId("tv-settings")).toHaveCount(0);
      await homeVisible(tv);
    }

    // Каркас calm mode: one moving layer, stopped when calm (device-local).
    await tv.evaluate(() => localStorage.setItem("martytv.calm_motion", "0"));
    await mockBackend(tvCtx, "wireframe");
    await tv.reload();
    await expect(tv.locator('[data-skin-bg="synthwave"]')).toBeVisible({ timeout: 30_000 });
    await expect(tv.locator(".sw-lines-run")).toHaveCount(1);
    await tv.evaluate(() => localStorage.setItem("martytv.calm_motion", "1"));
    await tv.reload();
    await expect(tv.locator('[data-skin-bg="synthwave"]')).toHaveAttribute("data-calm", "1", { timeout: 30_000 });
    await expect(tv.locator(".sw-lines-run")).toHaveCount(0);
    await tv.evaluate(() => localStorage.removeItem("martytv.calm_motion"));
  } finally {
    await phone.goto("/devices");
    const card = phone.locator("section", { hasText: deviceName });
    phone.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: /unpair/i }).click();
    await expect(card).toHaveCount(0);
  }
});
