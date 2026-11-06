import { expect, test } from "@playwright/test";
import { login } from "./foryou-fixtures";

const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

/** iPad (also via Media Station X) opening /tv/ gets the touch web app; «Версия для ТВ» goes back for the session. */
test("iPad: /tv/ opens the web app, with «Версия для ТВ» and «Вернуться в MSX»", async ({ browser }) => {
  const ctx = await browser.newContext({ userAgent: IPAD, viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true, locale: "ru-RU" });
  const page = await ctx.newPage();
  await login(page, "ru");
  await page.goto("/");
  await page.goto("/tv/");
  await expect(page).toHaveURL(/:\d+\/$/);
  await expect(page.locator("header nav")).toBeVisible();
  // «+ Подключить ТВ» stays on Home even with TVs already paired.
  await expect(page.getByTestId("home-pair-tv")).toBeVisible();
  // No «Установите Cineko» inside MSX.
  await expect(page.getByTestId("install-banner")).toHaveCount(0);

  await page.getByTestId("profile-menu-button").click();
  await expect(page.getByTestId("menu-leave-msx")).toBeVisible();
  await page.getByTestId("menu-tv-version").click();
  await expect(page).toHaveURL(/\/tv\/\?ui=tv$/);
  // The TV app stays for this session.
  await page.goto("/tv/");
  await expect(page).toHaveURL(/\/tv\/$/);
  await ctx.close();
});

test("a TV or desktop browser keeps the TV app", async ({ page }) => {
  await page.goto("/tv/");
  await page.waitForTimeout(1000);
  await expect(page).toHaveURL(/\/tv\/$/);
});
