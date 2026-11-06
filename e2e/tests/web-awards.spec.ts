// «Награды» on the PWA: the 🏆 poster chip (MediaSummary.award_badge) and
// the title page section (MediaDetail.awards). Real catalog responses are
// patched with mocked awards (page.route + route.fetch), so this does not
// depend on what Wikidata has for the dev catalog.
import { expect, test, type Page } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

test.use({ viewport: { width: 390, height: 844 }, locale: "en-US" });

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(USER);
  await page.getByLabel(/password/i).fill(PASS);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
}

const AWARDS = [
  {
    group: "oscar",
    group_label: "Oscar",
    tier: 1,
    wins: [
      { label: "Best Picture", year: 2020 },
      { label: "Best Director", year: 2020 },
      { label: "Best Original Screenplay", year: 2020 },
    ],
    nominations: [
      { label: "Best Film Editing", year: 2020 },
      { label: "Best Production Design", year: 2020 },
    ],
  },
  { group: "cannes", group_label: "Cannes", tier: 1, wins: [{ label: "Palme d'Or", year: 2019 }], nominations: [] },
  { group: "golden_globe", group_label: "Golden Globe", tier: 2, wins: [], nominations: [{ label: "Best Director", year: 2020 }] },
  { group: "other", group_label: "Other awards", tier: 3, wins: [{ label: "Dorian Award for Film of the Year", year: 2019 }], nominations: [] },
];

test("awards: poster chip and the title page section", async ({ page }) => {
  // Home rows: every item of the first row gets a tier-1 badge.
  await page.route(/\/api\/v1\/catalog\/home(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    for (const it of body.rows?.[0]?.items ?? []) it.award_badge = { group: "oscar", count: 3 };
    await route.fulfill({ response: res, json: body });
  });
  // Details: mocked awards on whatever title is opened.
  await page.route(/\/api\/v1\/media\/[0-9a-f-]{36}(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.awards = AWARDS;
    await route.fulfill({ response: res, json: body });
  });
  await login(page);

  const firstRow = page.locator('[data-testid^="row-"]').first();
  const card = firstRow.getByTestId("poster-card").first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  const badge = card.getByTestId("award-badge");
  await expect(badge).toHaveText("🏆Oscar ×3");
  await expect(badge).toHaveAttribute("title", "Awards: Oscar ×3");

  await card.click();
  await expect(page).toHaveURL(/\/title\/[0-9a-f-]{36}/);
  const awards = page.getByTestId("awards");
  await expect(awards).toBeVisible({ timeout: 20_000 });
  await expect(awards.getByRole("heading", { name: "Awards" })).toBeVisible();
  const wins = awards.getByTestId("awards-win-line");
  await expect(wins).toHaveCount(2);
  await expect(wins.nth(0)).toHaveText("🏆Oscar 2020: Best Picture, Best Director, Best Original Screenplay");
  await expect(wins.nth(1)).toHaveText("🏆Cannes 2019: Palme d'Or");
  await expect(awards.getByTestId("awards-other-line")).toHaveText("Other awards 2019: Dorian Award for Film of the Year");

  // Nominations are collapsed behind «3 more nominations ▸».
  const more = awards.getByTestId("awards-more");
  await expect(more).toHaveText("3 more nominations ▸");
  await expect(awards.getByTestId("awards-nominations")).toHaveCount(0);
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  const noms = awards.getByTestId("awards-nomination-line");
  await expect(noms).toHaveText(["Oscar 2020: Best Film Editing, Best Production Design", "Golden Globe 2020: Best Director"]);
  await more.click();
  await expect(awards.getByTestId("awards-nominations")).toHaveCount(0);
});

test("awards: no section without awards", async ({ page }) => {
  await page.route(/\/api\/v1\/media\/[0-9a-f-]{36}(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.awards = [];
    await route.fulfill({ response: res, json: body });
  });
  await login(page);
  const card = page.locator('[data-testid^="row-"]').first().getByTestId("poster-card").first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();
  await expect(page.getByTestId("title-overview")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("awards")).toHaveCount(0);
});
