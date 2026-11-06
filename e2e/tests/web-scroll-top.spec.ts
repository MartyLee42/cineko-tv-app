import { expect, test } from "@playwright/test";
import { login } from "./foryou-fixtures";

// Opening a title from far down a page starts at the top of the title page;
// Back returns to where the list was.
for (const vp of [{ n: "phone", width: 390, height: 844, i: 12 }, { n: "pc", width: 1440, height: 900, i: 30 }])
  test(`a new page opens at the top (${vp.n})`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await login(page);
    await page.goto("/browse");
    const cards = page.getByTestId("poster-card");
    await expect(cards.nth(vp.i)).toBeVisible({ timeout: 20_000 });
    await cards.nth(vp.i).scrollIntoViewIfNeeded();
    const listY = await page.evaluate(() => window.scrollY);
    expect(listY).toBeGreaterThan(300);
    await cards.nth(vp.i).click();
    await expect(page).toHaveURL(/\/title\//);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  });
