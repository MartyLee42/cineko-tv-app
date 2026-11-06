import { expect, test, type Page } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

/**
 * Phase 2 PWA catalog: home rows → search → detail (movie + series seasons)
 * → browse with a genre filter. Needs the API with TMDB configured.
 */
test.use({ viewport: { width: 390, height: 844 } });

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(USER);
  await page.getByLabel(/password/i).fill(PASS);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
}

test("browse the catalog from the phone", async ({ page }) => {
  await login(page);

  // Home: at least one row with poster cards.
  const firstRow = page.locator('[data-testid^="row-"]').first();
  await expect(firstRow).toBeVisible({ timeout: 20_000 });
  await expect(firstRow.getByTestId("poster-card").first()).toBeVisible();

  // Search (debounced, URL-synced).
  await page.getByRole("link", { name: /^search$/i }).first().click();
  await page.getByRole("searchbox").fill("Matrix");
  await expect(page).toHaveURL(/q=Matrix/);
  const result = page.getByTestId("poster-card").filter({ hasText: /matrix/i }).first();
  await expect(result).toBeVisible({ timeout: 20_000 });

  // Detail: title + overview.
  await result.click();
  await expect(page).toHaveURL(/\/title\/[0-9a-f-]{36}/);
  await expect(page.getByRole("heading", { level: 1, name: /matrix/i })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("title-overview")).not.toBeEmpty();

  // Series: switching season changes the episode list.
  await page.goto("/search?q=Breaking%20Bad&kind=series");
  await page.getByTestId("poster-card").first().click();
  const seasons = page.getByTestId("seasons");
  await expect(seasons).toBeVisible({ timeout: 20_000 });
  const episodes = page.getByTestId("episodes");
  await expect(episodes.getByText(/^S\d\dE01$/).first()).toBeVisible({ timeout: 20_000 });
  const before = (await episodes.getByText(/^S\d\dE\d\d$/).first().textContent())!;
  const other = seasons.getByRole("tab", { selected: false }).filter({ hasText: /\d/ }).first();
  const name = (await other.textContent())!.trim();
  const tab = seasons.getByRole("tab", { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(episodes.getByText(/^S\d\dE\d\d$/).first()).not.toHaveText(before, { timeout: 20_000 });

  // Browse with a genre filter → grid.
  await page.goto("/browse?kind=movie");
  await page.getByRole("button", { name: /filters/i }).click();
  const genre = page.getByTestId("genre-chip").first();
  await genre.click();
  await expect(genre).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/genres=\d+/);
  await page.getByRole("button", { name: /^done$/i }).click();
  await expect(page.getByTestId("poster-grid").getByTestId("poster-card").first()).toBeVisible({ timeout: 20_000 });
});
