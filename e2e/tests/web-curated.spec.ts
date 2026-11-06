import { expect, test } from "@playwright/test";
import { json, login, realItems, reason, SHOTS } from "./foryou-fixtures";

/**
 * «Подборки» on the web: Explore → curated tile → list page with progress,
 * a film marked watched via the API (✓ + progress, «Показать непросмотренные»),
 * the /curated shelf, and the Home row link. Lists and counts come from the live
 * API (the list files may grow), only the daily Home row is mocked.
 */

const LIST = "deleuze-cinema-2";

type Item = { position: number; watched: boolean; media: { id: string; title: string } | null };
type List = { id: string; title: string; count: number; watched: number; items: Item[] };

test.describe("web «Подборки»", () => {
  test("Explore tile → list; marking a film watched updates ✓, progress and the filter", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const { req, headers, profileId } = await login(page, "ru");
    const list = (await (await req.get(`/api/v1/curated/${LIST}?lang=ru&profile_id=${profileId}`)).json()) as List;
    const target = list.items.find((it) => it.media && !it.watched);
    expect(target, "an unwatched film in the catalog").toBeTruthy();
    const mediaId = target!.media!.id;
    const progress = (w: number) => `${w} из ${list.count} просмотрено`;

    try {
      await page.goto("/explore");
      const section = page.getByTestId("explore-curated");
      await expect(section).toBeVisible();
      await expect(section.getByTestId("curated-all-link")).toHaveAttribute("href", "/curated");
      const tile = section.locator(`[data-tile="curated:${LIST}"]`);
      await expect(tile.getByTestId("explore-tile-progress")).toHaveText(`${list.watched} / ${list.count}`);
      await tile.click();

      await expect(page).toHaveURL(new RegExp(`/curated/${LIST}$`));
      await expect(page.getByTestId("curated-title")).toHaveText(list.title);
      await expect(page.getByTestId("curated-item")).toHaveCount(list.items.length);
      await expect(page.getByTestId("curated-progress")).toHaveText(progress(list.watched));
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/curated-list.png`, fullPage: true });

      expect((await req.put(`/api/v1/media/${mediaId}/watched`, { data: { profile_id: profileId, watched: true }, headers })).ok()).toBeTruthy();
      await page.reload();
      const item = page.locator(`[data-testid=curated-item][data-position="${target!.position}"]`);
      await expect(item).toHaveAttribute("data-watched", "true");
      await expect(item.getByTestId("badge-watched")).toBeVisible();
      await expect(page.getByTestId("curated-progress")).toHaveText(progress(list.watched + 1));

      // «Показать непросмотренные» hides it; «Показать все» brings it back.
      const filter = page.getByTestId("curated-filter");
      await expect(filter).toHaveText("Показать непросмотренные");
      await filter.click();
      await expect(filter).toHaveAttribute("aria-pressed", "true");
      await expect(item).toHaveCount(0);
      await expect(page.getByTestId("curated-item")).toHaveCount(list.items.length - list.watched - 1);
      await filter.click();
      await expect(item).toBeVisible();
    } finally {
      await req.put(`/api/v1/media/${mediaId}/watched`, { data: { profile_id: profileId, watched: false }, headers });
    }
    const after = (await (await req.get(`/api/v1/curated/${LIST}?lang=ru&profile_id=${profileId}`)).json()) as List;
    expect(after.watched).toBe(list.watched);
  });

  test("/curated shelf: groups with list cards and progress; unknown list is «not found»", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const { req, profileId } = await login(page, "ru");
    const groups = (await (await req.get(`/api/v1/curated?lang=ru&profile_id=${profileId}`)).json()).groups as { id: string; lists: { id: string; count: number; watched: number }[] }[];
    await page.goto("/curated");
    const shelf = page.getByTestId("curated-shelf");
    await expect(shelf.getByRole("heading", { level: 1, name: "Подборки" })).toBeVisible();
    await expect(shelf.getByTestId("curated-group")).toHaveCount(groups.filter((g) => g.lists.length).length);
    await expect(shelf.locator('[data-testid=curated-group][data-group="thinkers"]').getByRole("heading", { name: "Мыслители и критики" })).toBeVisible();
    const deleuze = groups.flatMap((g) => g.lists).find((l) => l.id === LIST)!;
    const card = shelf.locator(`[data-testid=curated-card][data-list="${LIST}"]`);
    await expect(card.getByTestId("curated-card-progress")).toHaveText(`${deleuze.watched} / ${deleuze.count}`);
    await expect(shelf.locator('[data-testid=curated-card][data-list="soviet-goskino"]')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/curated-shelf.png`, fullPage: true });
    await card.click();
    await expect(page.getByTestId("curated-list")).toHaveAttribute("data-list", LIST);

    await page.goto("/curated/no-such-list");
    await expect(page.getByTestId("curated-missing")).toHaveText("Такой подборки нет.");
  });

  test("Settings: «Подборки на главной» toggles and is saved per profile", async ({ page }) => {
    const { req, headers, profileId } = await login(page, "ru");
    const settings = () => req.get(`/api/v1/profiles/${profileId}/settings`).then((r) => r.json());
    const before = (await settings()).show_curated as boolean;
    try {
      await page.goto("/settings");
      const toggle = page.getByTestId("setting-show-curated");
      await expect(toggle).toHaveAttribute("aria-checked", String(before));
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", String(!before));
      await expect.poll(async () => (await settings()).show_curated).toBe(!before);
    } finally {
      await req.put(`/api/v1/profiles/${profileId}/settings`, { data: { show_curated: before }, headers });
    }
  });

  test("Home: the curated «Для вас» row shows progress and links to the whole list", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const { profileId } = await login(page, "ru");
    const items = await realItems(page, "ru");
    const r = reason("curated", { text: "Делёз" });
    const curated = { list_id: LIST, title: "Делёз: «Кино 2. Образ-время»", author: "Жиль Делёз", count: 6, watched: 2 };
    // The live row is one list per profile per day, so the row is mocked.
    await page.route(/\/api\/v1\/foryou\/rows/, (route) =>
      json(route, {
        profile_id: profileId,
        generated_at: new Date().toISOString(),
        stale: false,
        cold_start: false,
        rows: [{ id: `curated:${LIST}`, kind: "curated", title: "x", reason: r, curated, items: items.slice(0, 6).map((m) => ({ media: m, reason: r, score: 1 })) }],
      }),
    );
    await page.route(/\/api\/v1\/foryou\/feedback/, (route) => json(route, { accepted: 1 }, 202));
    await page.goto("/");
    const row = page.getByTestId("foryou-row-curated");
    await expect(row.getByRole("heading", { name: "Подборка: Делёз: «Кино 2. Образ-время» · 2 из 6" })).toBeVisible();
    const link = row.getByTestId("curated-row-link");
    await expect(link).toHaveText("Вся подборка →");
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/curated/${LIST}$`));
    await expect(page.getByTestId("curated-list")).toBeVisible();
  });
});
