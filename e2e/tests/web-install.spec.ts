import { expect, test } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

test("install: iPhone gets the banner and the Share → Home Screen steps; menu item too", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: IPHONE, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(USER);
  await page.getByLabel(/password/i).fill(PASS);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();

  const banner = page.getByTestId("install-banner");
  await expect(banner).toBeVisible();
  await banner.getByRole("button", { name: /^install$/i }).click();
  await expect(page.getByTestId("install-ios-steps")).toBeVisible();
  await page.getByRole("button", { name: /got it/i }).click();
  await expect(page.getByTestId("install-ios-steps")).toHaveCount(0);
  // Dismissed for good.
  await page.reload();
  await expect(page.getByTestId("install-banner")).toHaveCount(0);

  // Still available from the avatar menu.
  await page.getByRole("button", { name: /profile|account|профил/i }).first().click().catch(() => undefined);
  const item = page.getByTestId("menu-install");
  if (!(await item.isVisible().catch(() => false))) await page.locator("header button").last().click();
  await expect(item).toBeVisible();
  await ctx.close();
});

test("install: a desktop browser without an install prompt shows nothing", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(USER);
  await page.getByLabel(/password/i).fill(PASS);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
  await expect(page.getByTestId("install-banner")).toHaveCount(0);
});
