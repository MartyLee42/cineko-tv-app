import { expect, test } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

// Regression: scrolling down Browse and then switching Movies → Series used to
// keep auto-loading page after page (the old long list kept the "load more"
// sentinel on screen while the new tab's first page was loading).
test("switching browse tabs after scrolling doesn't load pages endlessly", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(USER);
  await page.getByLabel(/password/i).fill(PASS);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();

  await page.goto("/browse?kind=movie");
  await expect(page.locator('a[href^="/title/"]').first()).toBeVisible({ timeout: 30_000 });
  // Scroll to the bottom a few times so several movie pages load.
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 20_000);
    await page.waitForTimeout(800);
  }

  const seriesPages: number[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.endsWith("/catalog/discover") && u.searchParams.get("kind") === "series") {
      seriesPages.push(Number(u.searchParams.get("page") ?? "1"));
    }
  });
  await page.getByRole("tab", { name: /series|сериалы/i }).first().click();
  await expect(page).toHaveURL(/kind=series/);
  await page.waitForTimeout(4_000);

  // The first page (plus at most one more if the viewport is still short) — not a chain.
  expect(Math.max(0, ...seriesPages)).toBeLessThanOrEqual(2);
});
