import { expect, test, type BrowserContext, type Route } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** The profile's seasonal_effects and the admin switch, as the API would answer them. */
async function mockSeasonal(ctx: BrowserContext, seasonal: "on" | "calm" | "off", admin = true) {
  await ctx.unrouteAll({ behavior: "ignoreErrors" });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch().catch(() => null);
    const body = res && res.ok() ? await res.json() : {};
    return json(route, { ...body, onboarding_completed: true, seasonal_effects: seasonal });
  });
  await ctx.route(/\/api\/v1\/status$/, async (route) => {
    const res = await route.fetch().catch(() => null);
    const body = res && res.ok() ? await res.json() : {};
    return json(route, { ...body, seasonal_effects: admin });
  });
}

/**
 * Holiday animations in the PWA: ?season=newyear shows the layer (≤ 24
 * particles, fixed, pointer-events off) with a dismissible greeting and the
 * mascot's hat; calm is still; off / the admin switch / ?season=off hide
 * it; title pages skip it; Settings has the select and a 10 s preview.
 */
test("web seasons: ?season shows the layer, off hides it, preview from Settings", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(USER);
  await page.getByLabel(/password/i).fill(PASS);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
  const layer = page.locator("[data-season][data-season-mode]"); // the layer, not season chips

  await mockSeasonal(ctx, "on");
  await page.goto("/?season=newyear");
  await expect(layer).toHaveAttribute("data-season", "newyear");
  await expect(layer).toHaveAttribute("data-season-mode", "full");
  const n = await page.locator(".mt-ss-p").count();
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThanOrEqual(24);
  expect(await layer.evaluate((el) => [getComputedStyle(el).position, getComputedStyle(el).pointerEvents])).toEqual(["fixed", "none"]);
  await expect(page.locator("header [data-hat=santa]")).toHaveCount(1);
  // The greeting is dismissible and shown once per device.
  const greeting = page.getByTestId("season-greeting");
  await expect(greeting).toContainText("Happy New Year!");
  await greeting.getByRole("button", { name: /dismiss/i }).click();
  await expect(greeting).toHaveCount(0);
  await page.reload();
  await expect(layer).toHaveCount(1);
  await expect(greeting).toHaveCount(0);
  // The layer never blocks clicks: the header link under it still works.
  await page.getByRole("link", { name: "Search" }).first().click();
  await expect(page).toHaveURL(/\/search/);

  // Calm: still sprites, no animation.
  await mockSeasonal(ctx, "calm");
  await page.goto("/?season=newyear");
  await expect(layer).toHaveAttribute("data-season-mode", "static");
  await expect(page.locator(".mt-ss-p")).toHaveCount(0);

  // Off, the admin switch and ?season=off hide it.
  await mockSeasonal(ctx, "off");
  await page.goto("/?season=newyear");
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
  await expect(layer).toHaveCount(0);
  await mockSeasonal(ctx, "on", false);
  await page.goto("/?season=newyear");
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
  await expect(layer).toHaveCount(0);
  await mockSeasonal(ctx, "on");
  await page.goto("/?season=off");
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
  await expect(layer).toHaveCount(0);

  // Settings: the select (saved per profile) and the preview of any holiday, even with "off".
  await mockSeasonal(ctx, "off");
  await page.goto("/settings");
  const select = page.getByTestId("seasonal-select");
  await expect(select).toHaveValue("off");
  await page.getByTestId("season-preview-select").selectOption("maslenitsa");
  await page.getByTestId("season-preview-button").click();
  await expect(layer).toHaveAttribute("data-season", "maslenitsa");
  await expect(page.getByTestId("season-greeting")).toHaveCount(0); // previews don't greet
  await page.getByTestId("season-preview-button").click(); // «Showing…» stops it
  await expect(layer).toHaveCount(0);

  // The select saves to the real profile (and back to the default, "off").
  await ctx.unrouteAll({ behavior: "ignoreErrors" });
  await page.reload();
  const saved = page.waitForResponse((r) => r.url().includes("/settings") && r.request().method() === "PUT");
  await page.getByTestId("seasonal-select").selectOption("calm");
  expect((await (await saved).json()).seasonal_effects).toBe("calm");
  const back = page.waitForResponse((r) => r.url().includes("/settings") && r.request().method() === "PUT");
  await page.getByTestId("seasonal-select").selectOption("off");
  expect((await (await back).json()).seasonal_effects).toBe("off");
  await ctx.close();
});
