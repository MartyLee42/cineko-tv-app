import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

/**
 * «Конструктивизм» on the web (phone, iPad, desktop): no Cineko — Mayakovsky
 * stands in ([data-mascot="mayakovsky"]); monumental headings; the
 * «Ленин в Октябре» card (opens the title, cannot be dismissed); the
 * news strip, the five-year plan and «Рекомендовано Госкино»; «VOICE OF
 * AMERICA» over «Видео»; the player loader with the hammer and sickle and
 * changing slogans; the «очередь за дефицитом»; the poster-voice error; the
 * renamed menu items (accessible names unchanged).
 */

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
/** Cineko's sticker files (idle, happy…): none may load in this design. */
const MARTY_IMG = /\/(idle|happy|excited|love|music|sleepy|thinking|surprised|error|loading|popcorn|laptop|rain|run|sly)(-anim)?[-.][\w-]*\.webp/;

async function loginState(browser: Browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(USER);
  await page.getByLabel(/password/i).fill(PASS);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
  const session = await (await ctx.request.get("/api/v1/auth/session")).json();
  const profiles = await (await ctx.request.get("/api/v1/profiles")).json();
  if (profiles.items.length === 0) {
    const r = await ctx.request.post("/api/v1/profiles", { data: { name: "E2E", color: "#6366f1" }, headers: { "X-CSRF-Token": session.csrf_token, Origin: new URL(page.url()).origin } });
    expect(r.ok()).toBeTruthy();
  }
  const profileId = (await (await ctx.request.get("/api/v1/profiles")).json()).items[0].id as string;
  const state = await ctx.storageState();
  await ctx.close();
  return { state, userId: session.user.id as string, profileId };
}

async function cvContext(browser: Browser, auth: Awaited<ReturnType<typeof loginState>>, viewport: { width: number; height: number }): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport, storageState: auth.state, locale: "ru-RU", serviceWorkers: "block" });
  await ctx.addInitScript(([u, p]) => {
    localStorage.setItem(`martytv.active_profile.${u}`, p);
    localStorage.setItem("martytv.design", "constructivism");
    localStorage.setItem("martytv.locale", "ru");
  }, [auth.userId, auth.profileId]);
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
    if (route.request().method() !== "GET") return route.fulfill(json({}));
    const res = await route.fetch().catch(() => null);
    const body = res && res.ok() ? await res.json() : {};
    return route.fulfill(json({ ...body, design: "constructivism", theme: "dark", onboarding_completed: true, loading_style: "marty" }));
  });
  // The player never gets a stream: its loader stays up.
  await ctx.route(/\/api\/v1\/playback\//, () => {});
  return ctx;
}

async function noMarty(page: Page, where: string) {
  const mascots = await page.locator("[data-mascot]").evaluateAll((els) => els.map((e) => e.getAttribute("data-mascot")));
  expect(mascots.filter((m) => m !== "mayakovsky"), `${where}: only Mayakovsky`).toEqual([]);
  const srcs = await page.locator("img").evaluateAll((els) => els.map((e) => (e as HTMLImageElement).currentSrc || (e as HTMLImageElement).src));
  expect(srcs.filter((s) => MARTY_IMG.test(s)), `${where}: no Cineko images`).toEqual([]);
}

const noSideScroll = (page: Page) => page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1);

for (const [tag, viewport] of [
  ["phone", { width: 390, height: 844 }],
  ["ipad", { width: 820, height: 1180 }],
  ["desktop", { width: 1440, height: 900 }],
] as const) {
  test(`web constructivism (${tag}): Mayakovsky, monumental Home, Lenin card, VOA, loader`, async ({ browser }) => {
    test.setTimeout(150_000);
    const auth = await loginState(browser);
    const ctx = await cvContext(browser, auth, viewport);
    const page = await ctx.newPage();
    try {
      await page.goto("/");
      await expect(page.locator("html")).toHaveClass(/design-constructivism/);
      await expect(page.getByTestId("marty-hello")).toBeVisible({ timeout: 20_000 });
      // Mayakovsky in the greeting and the header wordmark; no Cineko anywhere.
      await expect(page.getByTestId("marty-hello").locator('[data-mascot="mayakovsky"]')).toBeVisible();
      await expect(page.locator('header [data-mascot="mayakovsky"]')).toBeVisible();
      await noMarty(page, `${tag} home`);

      // The news strip runs (transform changes), the plan is there.
      const news = page.getByTestId("cv-news");
      await expect(news).toBeVisible();
      const tr = () => news.locator(".cv-news-track").evaluate((e) => getComputedStyle(e).transform);
      const t1 = await tr();
      await page.waitForTimeout(1200);
      expect(await tr()).not.toBe(t1);
      await expect(page.getByTestId("cv-plan")).toContainText(/Пятилетка/i, { timeout: 20_000 });
      await expect(page.getByTestId("cv-plan")).toContainText(/из 60/);

      // «Рекомендуем к просмотру»: «Ленин в Октябре» (found by search) → the title page.
      const lenin = page.getByTestId("cv-lenin");
      await expect(lenin).toBeVisible({ timeout: 30_000 });
      await expect(lenin).toContainText(/Рекомендуем к просмотру/i);
      await expect(lenin.locator("h2")).toContainText(/Ленин в Октябре/i);
      // Monumental: condensed capitals, tilted.
      const h2 = await lenin.locator("h2").evaluate((e) => ({ font: getComputedStyle(e).fontFamily, tt: getComputedStyle(e).textTransform, size: parseFloat(getComputedStyle(e).fontSize), tf: getComputedStyle(e).transform }));
      expect(h2.font).toMatch(/Oswald/);
      expect(h2.tt).toBe("uppercase");
      expect(h2.size).toBeGreaterThanOrEqual(30);
      expect(h2.tf).not.toBe("none");
      // The Home hero title: giant, tilted.
      const hero = page.locator("#hero-title");
      if (await hero.count()) {
        const s = await hero.evaluate((e) => ({ size: parseFloat(getComputedStyle(e).fontSize), tf: getComputedStyle(e).transform }));
        expect(s.size).toBeGreaterThanOrEqual(44);
        expect(s.tf).not.toBe("none");
      }
      // «Рекомендовано Госкино».
      await expect(page.getByTestId("row-cv-goskino")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("row-cv-goskino").locator("[data-testid=poster-card]").first()).toBeVisible();
      expect(await noSideScroll(page), `${tag}: no sideways scroll on Home`).toBe(true);

      const mediaId = await lenin.getAttribute("data-media-id");
      await lenin.getByRole("link").first().click();
      await expect(page).toHaveURL(new RegExp(`/title/${mediaId}`));
      await expect(page.locator("main h1").first()).toContainText(/Ленин в Октябре/i, { timeout: 20_000 });
      await noMarty(page, `${tag} title`);

      // Buttons share one style: square slabs in condensed capitals on an offset block.
      // Primary = red with cream text; secondary = cream with black text.
      const look = (sel: string) =>
        page.locator(sel).first().evaluate((e) => {
          const s = getComputedStyle(e);
          return { radius: s.borderTopLeftRadius, shadow: s.boxShadow, font: s.fontFamily, tt: s.textTransform, bg: s.backgroundColor, color: s.color, tf: s.transform };
        });
      const primary = await look("main button.bg-accent");
      expect(primary.radius).toBe("0px");
      expect(primary.shadow).toContain("4px 4px 0px");
      expect(primary.font).toMatch(/Oswald/);
      expect(primary.tt).toBe("uppercase");
      expect(primary.bg).toBe("rgb(215, 38, 30)");
      const secondary = await look('[data-testid="toggle-watched"]');
      expect(secondary.radius).toBe("0px");
      expect(secondary.shadow).toContain("4px 4px 0px");
      expect(secondary.font).toMatch(/Oswald/);
      expect(secondary.bg).toBe("rgb(239, 228, 204)");
      expect(secondary.color).toBe("rgb(26, 21, 18)");
      if (tag === "desktop") {
        // Hover: the slab lifts, the red offset slab shifts out.
        await page.locator('[data-testid="toggle-watched"]').hover();
        await expect.poll(async () => (await look('[data-testid="toggle-watched"]')).tf).not.toBe("none");
        await expect.poll(async () => (await look('[data-testid="toggle-watched"]')).shadow).toContain("rgb(215, 38, 30) 7px 7px 0px");
      }
      // Its icons are the constructivist pictograms (filled, no strokes).
      await expect(page.locator("main [data-cv-icon]").first()).toBeVisible();
      expect(await page.locator("main button svg[stroke='currentColor']").count(), `${tag}: no line icons on the title's buttons`).toBe(0);
      expect(await noSideScroll(page), `${tag}: no sideways scroll on the title`).toBe(true);

      // The menu icons too (phone tab bar / desktop header).
      await expect(page.locator("header.sticky [data-cv-icon], nav.fixed [data-cv-icon]").filter({ visible: true }).first()).toBeVisible();

      // The AI is «Товарищ ЭВМ» (accessible names unchanged).
      if (tag === "desktop") await expect(page.getByRole("link", { name: "Спросить ИИ" }).first()).toHaveText(/Товарищ ЭВМ/);
      await page.goto("/ask");
      await expect(page.locator("main h1").first()).toContainText(/Спросите Товарища ЭВМ/i, { timeout: 20_000 });
      await expect(page.locator("main")).toContainText(/электронный советчик Госкино/i);
      await expect(page.getByTestId("ask-input")).toHaveAttribute("aria-label", "Спросить ИИ");
      await expect(page.locator("main h1 [data-cv-icon=spark]").first()).toBeVisible();

      // Not dismissible: no ✕ / hide control, and the card is back on every visit (reload, a new tab).
      await page.goto("/");
      await expect(lenin).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("cv-lenin-hide")).toHaveCount(0);
      await expect(lenin.getByRole("button")).toHaveCount(0);
      await page.reload();
      await expect(lenin).toBeVisible({ timeout: 20_000 });
      const tab2 = await ctx.newPage();
      await tab2.goto("/");
      await expect(tab2.getByTestId("cv-lenin")).toBeVisible({ timeout: 20_000 });
      await tab2.close();

      // Menu: renamed labels, accessible names unchanged.
      const home = page.getByRole("link", { name: "Главная" }).first();
      await expect(home).toBeVisible();
      await expect(home).toContainText("Главк");

      // «Видео»: «VOICE OF AMERICA», decorative, nothing pushed sideways.
      await page.goto("/video");
      const voa = page.getByTestId("cv-voa");
      await expect(voa).toBeVisible();
      await expect(voa).toHaveText(/voice of america/i);
      await expect(voa).toHaveAttribute("aria-hidden", "true");
      const box = (await voa.boundingBox())!;
      expect(box.height, `${tag}: VOA height`).toBeLessThan(viewport.height * 0.3);
      expect(await noSideScroll(page), `${tag}: no sideways scroll on Видео`).toBe(true);
      // The page title: giant condensed capitals.
      const h1 = await page.locator("main h1").first().evaluate((e) => ({ font: getComputedStyle(e).fontFamily, size: parseFloat(getComputedStyle(e).fontSize) }));
      expect(h1.font).toMatch(/Oswald/);
      expect(h1.size).toBeGreaterThanOrEqual(36);

      // Player loader: whatever the style («Cineko» here), the hammer and sickle and changing slogans; no mascot.
      await page.goto("/watch/00000000-0000-4000-8000-000000000000");
      const loader = page.getByTestId("player-loader");
      await expect(loader).toBeVisible({ timeout: 15_000 });
      await expect(loader).toHaveAttribute("data-cv", "1");
      await expect(loader.locator("[data-emblem=hammer-sickle]")).toBeVisible();
      await expect(loader.locator("[data-mascot]")).toHaveCount(0);
      const slogan = loader.getByTestId("cv-slogan");
      const first = await slogan.getAttribute("data-n");
      await expect.poll(() => slogan.getAttribute("data-n"), { timeout: 6000 }).not.toBe(first);
      await noMarty(page, `${tag} loader`);
    } finally {
      await ctx.close();
    }
  });
}

test("web constructivism: «очередь за дефицитом» once per title, the poster-voice error", async ({ browser }) => {
  test.setTimeout(90_000);
  const auth = await loginState(browser);
  const ctx = await cvContext(browser, auth, { width: 1440, height: 900 });
  const page = await ctx.newPage();
  try {
    // A very popular title opened inside the app: the queue shows ~1.2 s, then the page.
    await page.goto(`/search?q=${encodeURIComponent("Интерстеллар")}`);
    const card = page.getByTestId("poster-card").first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.click();
    const queue = page.getByTestId("cv-queue");
    await expect(queue).toBeVisible({ timeout: 10_000 });
    await expect(queue).toContainText(/в очереди за дефицитом/);
    await expect(queue).toHaveCount(0, { timeout: 3000 });
    // Once per title per session.
    await page.goBack();
    await expect(card).toBeVisible();
    await card.click();
    await expect(page.locator("main h1").first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(600);
    await expect(queue).toHaveCount(0);
    // A deep link never queues.
    const url = page.url();
    const p2 = await ctx.newPage();
    await p2.goto(url);
    await expect(p2.locator("main h1").first()).toBeVisible({ timeout: 20_000 });
    await expect(p2.getByTestId("cv-queue")).toHaveCount(0);
    await p2.close();

    // The catalog failing: «Товарищ, сервер на субботнике…», the retry button stays.
    await ctx.route(/\/api\/v1\/catalog\/home/, (route) => route.fulfill(json({ error: { code: "internal", message: "boom" } }, 500)));
    await page.goto("/");
    await expect(page.getByTestId("cv-error")).toContainText(/сервер на субботнике/i, { timeout: 20_000 });
    await expect(page.getByRole("button", { name: /повторить|retry/i }).first()).toBeVisible();
  } finally {
    await ctx.close();
  }
});
