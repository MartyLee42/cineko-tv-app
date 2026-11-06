import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
/** Canvas px: text floor and the overscan safe band (≈5 % of 1920). */
const MIN_FONT = 22;
const SAFE = 48;

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function press(tv: Page, key: string, times = 1) {
  for (let i = 0; i < times; i++) {
    await tv.keyboard.press(key);
    await tv.waitForTimeout(170);
  }
}

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
  await ctx.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) => json(route, { items: [], searched_at: new Date().toISOString(), cached: true, indexer_errors: [] }));
  await ctx.route(/\/api\/v1\/playback\//, (route) => json(route, { error: { code: "not_found", message: "mocked" } }, 404));
  await ctx.route(/\/api\/v1\/foryou\/rows/, (route) => json(route, { profile_id: "p", generated_at: null, stale: false, cold_start: true, rows: [] }));
}

/** Boxes (canvas coordinates) and computed font sizes of the focused element and of `selector`'s visible matches. */
function measure(tv: Page, selector: string) {
  return tv.evaluate((sel) => {
    const r0 = document.getElementById("root")!.getBoundingClientRect();
    const s = r0.width / 1920;
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: (r.left - r0.left) / s, y: (r.top - r0.top) / s, r: (r.right - r0.left) / s, b: (r.bottom - r0.top) / s };
    };
    const all = document.querySelectorAll(".is-focused, [data-nav-focused='1']");
    const f = all[all.length - 1];
    // Elements that render text themselves (a direct text node), not wrappers inheriting a font size.
    const ownText = (el: Element) => [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 1);
    const texts = [...document.querySelectorAll(sel)]
      .filter(ownText)
      .filter((el) => {
        const b = box(el);
        return b.r > b.x && b.b > b.y && b.b > 0 && b.y < 1080 && b.r > 0 && b.x < 1920;
      })
      .map((el) => ({ text: (el.textContent ?? "").trim().slice(0, 40), font: parseFloat(getComputedStyle(el).fontSize), ...box(el) }))
      // Text only (icon wrappers carry no label).
      .filter((t) => t.text.length > 1);
    return { scale: s, focused: f ? box(f) : null, texts };
  }, selector);
}

type Box = { x: number; y: number; r: number; b: number };
function inSafe(b: Box, what: string) {
  expect(b.x, `${what}: left ${b.x}`).toBeGreaterThanOrEqual(SAFE);
  expect(b.y, `${what}: top ${b.y}`).toBeGreaterThanOrEqual(SAFE);
  expect(b.r, `${what}: right ${b.r}`).toBeLessThanOrEqual(1920 - SAFE);
  expect(b.b, `${what}: bottom ${b.b}`).toBeLessThanOrEqual(1080 - SAFE);
}

/**
 * Small TVs (1280×720 viewport: the canvas at 2/3): on Home, Details and
 * Settings, in a rail design and a tab-bar design, the focused element and
 * the key texts sit inside the overscan safe area, and key labels are at
 * least 22 canvas px (≈15 real px).
 */
test("TV at 720p: safe area and minimum text size (Кинозал, Киберпанк)", async ({ browser }) => {
  test.setTimeout(240_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
  const phone = await phoneCtx.newPage();
  const tv = await tvCtx.newPage();

  await phone.goto("/login");
  await phone.getByLabel(/username/i).fill(USER);
  await phone.getByLabel(/password/i).fill(PASS);
  await phone.getByRole("button", { name: /sign in/i }).click();
  await expect(phone.getByRole("heading", { name: /welcome/i })).toBeVisible();

  await mockBackend(tvCtx, "kinozal");
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  // The pairing code itself is in the safe area and large.
  const pair = await measure(tv, "p.font-mono");
  expect(pair.scale).toBeCloseTo(2 / 3, 2);
  inSafe(pair.texts[0]!, "pairing code");
  expect(pair.texts[0]!.font).toBeGreaterThanOrEqual(MIN_FONT);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Small TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  try {
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");

    for (const design of ["kinozal", "cyberpunk"]) {
      await mockBackend(tvCtx, design);
      await tv.reload();
      await expect(tv.locator(`[data-design-skin="${design}"]`)).toBeVisible({ timeout: 30_000 });
      await expect(tv.locator("[data-row=trending]")).toBeVisible({ timeout: 30_000 });
      await tv.waitForTimeout(800);

      // Home: hero title, row titles, card captions and the menu.
      const home = await measure(tv, "[data-testid=hero] h2, [data-testid=hero] p, [data-row] h3, [data-card-id] p, nav [data-menu] span");
      expect(home.focused, `${design}: focus on Home`).not.toBeNull();
      inSafe(home.focused!, `${design} home focused`);
      inSafe(home.texts.find((t) => t.y < 700 && t.text.length > 2) ?? home.texts[0]!, `${design} home hero`);
      for (const t of home.texts) expect(t.font, `${design} home «${t.text}»`).toBeGreaterThanOrEqual(MIN_FONT);
      // The menu fits the canvas (Терминал-style bar: all tabs inside the safe band).
      for (const t of home.texts.filter((x) => x.y < 160 && x.text)) {
        expect(t.r, `${design} menu «${t.text}» right`).toBeLessThanOrEqual(1920 - SAFE);
      }

      // Details: title, meta, buttons; focus on Play in the safe area.
      await press(tv, "Enter");
      await expect(tv.locator("[data-media-id] h1")).not.toBeEmpty({ timeout: 20_000 });
      await tv.waitForTimeout(800);
      const det = await measure(tv, "[data-media-id] h1, [data-media-id] p, [data-focus-key^='d-']");
      inSafe(det.focused!, `${design} details play`);
      inSafe(det.texts.find((t) => t.text && t.font > 40)!, `${design} details title`);
      for (const t of det.texts.filter((x) => x.text)) expect(t.font, `${design} details «${t.text}»`).toBeGreaterThanOrEqual(MIN_FONT);
      await press(tv, "Escape");
      await expect(tv.locator("[data-row=trending]")).toBeVisible({ timeout: 20_000 });

      // Settings: rows, values and the side hint.
      await tv.evaluate(() => (document.querySelector('[data-menu="settings"]') as HTMLElement | null)?.click());
      await expect(tv.getByTestId("tv-settings")).toBeVisible();
      await tv.waitForTimeout(600);
      const set = await measure(tv, "[data-testid=tv-settings] [data-setting] span, [data-testid=tv-settings] aside p, [data-testid=tv-settings] h1");
      inSafe(set.focused!, `${design} settings focused row`);
      for (const t of set.texts.filter((x) => x.text && x.b < 1080 - SAFE)) {
        expect(t.font, `${design} settings «${t.text}»`).toBeGreaterThanOrEqual(MIN_FONT);
        expect(t.x, `${design} settings «${t.text}» left`).toBeGreaterThanOrEqual(SAFE);
        expect(t.r, `${design} settings «${t.text}» right`).toBeLessThanOrEqual(1920 - SAFE);
      }
      await press(tv, "Escape");
      await expect(tv.getByTestId("tv-settings")).toHaveCount(0);
    }
  } finally {
    await phone.goto("/devices");
    const card = phone.locator("section", { hasText: deviceName });
    phone.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: /unpair/i }).click();
    await expect(card).toHaveCount(0);
  }
});
