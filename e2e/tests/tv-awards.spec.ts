import { mkdirSync } from "node:fs";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
/** Set SHOTS=1 to save 1920×1080 screenshots of the line and the panel per design. */
const SHOTS = process.env.SHOTS ? "/repo/e2e/scripts/out/awards-tv" : null;

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

// MediaDetail.awards as the API returns it (?lang=ru), abridged.
const AWARDS = [
  {
    group: "oscar",
    group_label: "Оскар",
    tier: 1,
    wins: [
      { label: "лучший фильм", year: 2020 },
      { label: "лучшая режиссёрская работа", year: 2020 },
    ],
    nominations: [{ label: "лучший монтаж", year: 2020 }],
  },
  { group: "cannes", group_label: "Канны", tier: 1, wins: [{ label: "Золотая пальмовая ветвь", year: 2019 }], nominations: [] },
  { group: "bafta", group_label: "BAFTA", tier: 2, wins: [], nominations: [{ label: "лучший фильм", year: 2020 }, { label: "лучшая режиссура", year: 2020 }] },
  { group: "other", group_label: "Другие награды", tier: 3, wins: [{ label: "Премия Dorian Awards", year: 2019 }], nominations: [] },
];

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
  await ctx.route(/\/api\/v1\/foryou\/rows/, (route) => json(route, { rows: [], cold_start: false }));
  await ctx.route(/\/api\/v1\/messages(\?.*)?$/, (route) => json(route, { items: [], unread: 0 }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/progress/, (route) => json(route, { media_id: "x", kind: "movie", movie: null, episodes: [], seasons: [], next_up: null }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/(releases|online)/, (route) => json(route, { items: [], providers: [], searched_at: new Date().toISOString(), cached: true, indexer_errors: [] }));
  // Home: the first trending title carries the tier-1 badge.
  await ctx.route(/\/api\/v1\/catalog\/home(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const first = body.rows?.[0]?.items?.[0];
    if (first) first.award_badge = { group: "oscar", count: 2 };
    return json(route, body);
  });
  // Details: the real title with mocked awards.
  await ctx.route(/\/api\/v1\/media\/[0-9a-f-]{36}(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    return json(route, { ...body, awards: AWARDS, award_badge: { group: "oscar", count: 2 } });
  });
}

const focusKey = (tv: Page) => tv.evaluate(() => (window as unknown as { __focusKey: () => string }).__focusKey());

async function press(tv: Page, key: string) {
  await tv.keyboard.press(key);
  await tv.waitForTimeout(170);
}

/**
 * «Награды» on TV details (Кинозал, Терминал, Проектор): the one-line
 * summary of major wins in the header, focusable; OK opens the panel with
 * wins per award and year and the nominations, ▲▼ scroll, Back closes it
 * and focus returns to the line (Details stay open).
 */
test("TV awards: header line and panel in every details layout", async ({ browser }) => {
  test.setTimeout(240_000);
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: "ru-RU" });
  await tvCtx.addInitScript(() => localStorage.setItem("martytv.locale", "ru"));
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
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Awards TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  try {
    if (await tv.getByRole("heading", { name: /кто смотрит|who's watching/i }).isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");

    for (const design of ["kinozal", "terminal", "projector"]) {
      await mockBackend(tvCtx, design);
      await tv.reload();
      await expect(tv.locator("[data-row=trending]")).toBeVisible({ timeout: 30_000 });
      // Poster badge (🏆 + count) on the first trending card.
      await expect(tv.locator("[data-row=trending] [data-award-badge=oscar]").first()).toHaveText("🏆2");
      await expect.poll(() => focusKey(tv), { timeout: 15_000 }).toMatch(/^row-trending-/);
      await tv.waitForTimeout(600);
      await press(tv, "Enter");
      const details = tv.locator("[data-media-id]");
      await expect(details.locator("h1")).not.toBeEmpty({ timeout: 20_000 });

      // The line: major wins (Oscar counted, Cannes named), nominations counted.
      const line = tv.getByTestId("tv-awards-line");
      await expect(line).toBeVisible();
      await expect(line).toContainText("🏆 Оскар ×2 · Канны: Золотая пальмовая ветвь");
      await expect(line).toContainText("3 номинации");
      await expect(tv.getByTestId("tv-awards-open")).toHaveText("Награды ▸");

      // Focus it with the remote (it sits above the action buttons).
      await expect.poll(() => focusKey(tv)).toBe("d-play");
      for (let i = 0; i < 4 && (await focusKey(tv)) !== "d-awards"; i++) await press(tv, "ArrowUp");
      expect(await focusKey(tv)).toBe("d-awards");
      if (SHOTS) await tv.screenshot({ path: `${SHOTS}/${design}-line.png` });

      await press(tv, "Enter");
      const panel = tv.getByTestId("tv-awards-panel");
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-award-win]").first()).toHaveText("🏆Оскар 2020: лучший фильм, лучшая режиссёрская работа");
      await expect(panel.locator("[data-award-win]")).toHaveCount(3);
      await expect(panel).toContainText("Номинации · 3 номинации");
      await expect(panel.locator("[data-award-nomination]")).toHaveText(["Оскар 2020: лучший монтаж", "BAFTA 2020: лучший фильм, лучшая режиссура"]);
      if (SHOTS) await tv.screenshot({ path: `${SHOTS}/${design}-panel.png` });
      // ▲▼ scroll the panel; spatial focus does not move behind it.
      await press(tv, "ArrowDown");
      expect(await focusKey(tv)).toBe("d-awards");

      // Back closes the panel only; focus is back on the line.
      await press(tv, "Escape");
      await expect(panel).toHaveCount(0);
      await expect(details).toBeVisible();
      expect(await focusKey(tv)).toBe("d-awards");
      // OK also closes it.
      await press(tv, "Enter");
      await expect(panel).toBeVisible();
      await press(tv, "Enter");
      await expect(panel).toHaveCount(0);
      await press(tv, "Escape");
      await expect(tv.locator("[data-row=trending]")).toBeVisible({ timeout: 20_000 });
    }
  } finally {
    const origin = new URL(phone.url()).origin;
    const session = await (await phoneCtx.request.get("/api/v1/auth/session")).json();
    const devs = await (await phoneCtx.request.get("/api/v1/devices")).json();
    const dev = devs.items.find((d: { name: string }) => d.name === deviceName);
    if (dev) await phoneCtx.request.delete(`/api/v1/devices/${dev.id}`, { headers: { "X-CSRF-Token": session.csrf_token, Origin: origin } });
    await phoneCtx.close();
    await tvCtx.close();
  }
});
