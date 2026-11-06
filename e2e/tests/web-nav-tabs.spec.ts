import { expect, test } from "@playwright/test";
import { login } from "./foryou-fixtures";

/** Settings → «Вкладки меню»: each profile picks the tabs its header and phone bar show. */
test("nav tabs: hide and show tabs per profile; narrow screens move the tail into «Ещё»", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "ru");
  const nav = page.locator("header nav");
  const card = page.getByTestId("setting-nav-tabs");

  await page.goto("/settings");
  // Start from all tabs on (the profile may be reused between runs).
  for (const sw of await card.getByRole("switch").all()) if ((await sw.getAttribute("aria-checked")) === "false") await sw.click();
  await expect(nav.getByRole("link")).toHaveText(["Главная", "ТВ", "Видео", "Обзор", "Новые серии", "История", "Спросить ИИ"]);

  for (const id of ["video", "ask", "search"]) {
    const saved = page.waitForResponse((r) => r.url().includes("/settings") && r.request().method() === "PUT");
    await card.locator(`[data-tab=${id}]`).click();
    await saved;
  }
  await expect(nav.getByRole("link")).toHaveText(["Главная", "ТВ", "Обзор", "Новые серии", "История"]);
  await expect(page.locator("header").getByRole("link", { name: "Поиск" })).toHaveCount(0);

  // Kept after a reload (stored on the server).
  await page.reload();
  await expect(nav.getByRole("link")).toHaveText(["Главная", "ТВ", "Обзор", "Новые серии", "История"]);

  // Narrow desktop: Новые серии / История go to «Ещё».
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(nav.getByRole("link")).toHaveText(["Главная", "ТВ", "Обзор"]);
  await page.getByTestId("nav-more").click();
  await page.getByRole("menuitem", { name: "История" }).click();
  await expect(page).toHaveURL(/\/history$/);

  // Phone bar: Home + first three shown tabs + Settings (Search hidden → ТВ fills in).
  await page.setViewportSize({ width: 390, height: 844 });
  const bar = page.locator("nav.fixed");
  await expect(bar.getByRole("link")).toHaveText(["Главная", "Обзор", "История", "ТВ", "Настройки"]);

  // Turn everything back on.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings");
  for (const id of ["video", "ask", "search"]) {
    const saved = page.waitForResponse((r) => r.url().includes("/settings") && r.request().method() === "PUT");
    await card.locator(`[data-tab=${id}]`).click();
    await saved;
  }
  await expect(nav.getByRole("link")).toHaveCount(7);
});
