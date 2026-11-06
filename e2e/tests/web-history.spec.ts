import { expect, test } from "@playwright/test";
import { diary, historyItems, json, login, mockHistory, realItems, SHOTS, taste } from "./foryou-fixtures";

/**
 * «История» as a first-class tab: in the desktop top nav and the phone bottom
 * bar; thousands of entries grouped by month with the profile's rating,
 * filters (all / movies / series / rated), search over the whole history,
 * infinite scroll; Diary and Taste DNA linked from it. The e2e profile has
 * no history, so it is mocked (cursor pages of real titles).
 */

test("history: nav tab, month groups, rating chips, filters, search", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, SHOTS ? "ru" : undefined);
  const items = await realItems(page);
  const all = historyItems(items, 450);
  await mockHistory(page, all);
  await page.goto("/");

  const nav = page.locator("header nav");
  await expect(nav.getByRole("link")).toHaveText(SHOTS ? ["Главная", "ТВ", "Видео", "Обзор", "Новые серии", "История", "Спросить ИИ"] : ["Home", "TV", "Video", "Explore", "New episodes", "History", "Ask AI"]);
  await nav.getByRole("link", { name: /^(history|история)$/i }).click();
  await expect(page).toHaveURL(/\/history$/);

  // First page (100) → month groups, newest first, with headers.
  const months = page.getByTestId("history-month");
  await expect(months.first()).toHaveAttribute("data-month", "2026-10");
  await expect(months.first().locator("h2")).toContainText(/October 2026|Октябрь 2026/);
  await expect(page.getByTestId("history-row").first()).toContainText(`${items[0]!.title} #1`);
  // Every 3rd entry is rated: its chip shows the profile's rating.
  await expect(page.getByTestId("history-row").first().getByTestId("rating-chip")).toHaveText("★ 10");
  await expect(page.getByTestId("history-row").nth(1).getByTestId("rating-chip")).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/web-desktop-history.png` });

  // Infinite scroll loads more pages.
  const before = await page.getByTestId("history-row").count();
  expect(before).toBe(100);
  await page.getByTestId("history-row").last().scrollIntoViewIfNeeded();
  await expect.poll(() => page.getByTestId("history-row").count(), { timeout: 15_000 }).toBeGreaterThan(100);

  // Rated only.
  await page.getByTestId("history-filters").locator('[data-filter="rated"]').click();
  await expect(page).toHaveURL(/f=rated/);
  const chips = () => page.getByTestId("history-row").evaluateAll((rows) => rows.map((r) => !!r.querySelector('[data-testid="rating-chip"]')));
  await expect.poll(async () => (await chips()).every(Boolean)).toBe(true);
  expect((await chips()).length).toBeGreaterThan(30);
  // Series only (every 5th is a series).
  await page.getByTestId("history-filters").locator('[data-filter="series"]').click();
  await expect(page.getByTestId("history-row").first()).toContainText("#5");
  await expect(page.getByTestId("history-row").first()).toContainText("S01E03");
  // Search runs over the whole history (loads every page): the oldest entry is found.
  await page.getByTestId("history-filters").locator('[data-filter="all"]').click();
  await page.getByTestId("history-search").fill(`#450`);
  await expect(page.getByTestId("history-row")).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByTestId("history-row")).toContainText(`#450`);
  await page.getByTestId("history-search").fill("no such title zzz");
  await expect(page.getByTestId("history-no-match")).toBeVisible();
});

test("history on a phone: bottom bar has 5 items incl. History; Devices from Settings", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await login(page, "ru");
  const items = await realItems(page, "ru");
  await mockHistory(page, historyItems(items, 60));
  await page.goto("/");
  const bar = page.locator("body > div nav.fixed");
  await expect(bar.getByRole("link")).toHaveText(["Главная", "Обзор", "Поиск", "История", "Настройки"]);
  await bar.getByRole("link", { name: "История" }).tap();
  await expect(page.getByTestId("history-month").first()).toBeVisible();
  await expect(bar.getByRole("link", { name: "История" })).toHaveClass(/text-accent/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/web-phone-history.png` });
  await bar.getByRole("link", { name: "Настройки" }).tap();
  await page.getByTestId("settings-devices").tap();
  await expect(page).toHaveURL(/\/devices$/);
  // Devices highlights Settings in the bottom bar.
  await expect(bar.getByRole("link", { name: "Настройки" })).toHaveClass(/text-accent/);
  await ctx.close();
});

test("diary calendar and taste DNA from History", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  // The diary fixture is October 2026; the calendar opens on "this" month.
  await page.clock.setFixedTime(new Date("2026-10-28T12:00:00Z"));
  const { profileId } = await login(page, SHOTS ? "ru" : undefined);
  const items = await realItems(page);
  await mockHistory(page, historyItems(items, 20));
  const months: string[] = [];
  await page.route(/\/api\/v1\/profiles\/[^/]+\/diary/, (route) => {
    const m = new URL(route.request().url()).searchParams.get("month") ?? "";
    months.push(m);
    return json(route, m === "2026-10" ? diary(items) : { ...diary(items), month: m, days: [] });
  });
  await page.route(/\/api\/v1\/profiles\/[^/]+\/taste(\?|$)/, (route) => json(route, taste(profileId)));
  await page.goto("/history");
  await page.getByTestId("history-diary").click();
  await expect(page).toHaveURL(/\/diary$/);
  await expect(page.getByTestId("diary-day")).toHaveCount(9);
  await expect(page.getByTestId("diary-stats")).toContainText("23.5");
  // The latest day is selected; clicking another shows its entries.
  await page.locator('[data-testid="diary-day"][data-date="2026-10-02"]').click();
  await expect(page.getByTestId("diary-day-list")).toContainText(items[0]!.title);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/web-desktop-diary.png`, fullPage: true });
  await page.getByTestId("diary-prev").click();
  await expect(page).toHaveURL(/month=2026-09/);
  await expect(page.getByTestId("diary-empty")).toBeVisible();
  expect(months).toContain("2026-09");

  await page.goto("/history");
  await page.getByTestId("history-taste").click();
  await expect(page).toHaveURL(/\/taste$/);
  await expect(page.getByTestId("taste-histogram")).toBeVisible();
  await expect(page.getByTestId("taste-genres")).toContainText("Drama");
  await expect(page.getByTestId("taste-directors")).toContainText("Christopher Nolan");
  await expect(page.getByTestId("taste-kinds")).toContainText("1890");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/web-desktop-taste.png`, fullPage: true });
});
