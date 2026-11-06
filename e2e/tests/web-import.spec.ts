import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
const FIXTURE = fileURLToPath(new URL("../fixtures/kinopoisk_sample.csv", import.meta.url));

/**
 * Settings → Kinopoisk ratings import against the dev stack's real TMDB:
 * four well-known films and one that doesn't exist. Uses its own throwaway
 * profile (deleted afterwards), so ratings never leak into other tests.
 */
test.use({ viewport: { width: 390, height: 844 } });
test.setTimeout(180_000);

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(USER);
  await page.getByLabel(/password/i).fill(PASS);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
}

test("imports Kinopoisk ratings: progress, summary, unmatched list, ratings on title pages", async ({ page }) => {
  await login(page);
  const req = page.context().request;
  const session = await (await req.get("/api/v1/auth/session")).json();
  const headers = { "X-CSRF-Token": session.csrf_token as string, Origin: new URL(page.url()).origin };
  const userId = session.user.id as string;
  const r = await req.post("/api/v1/profiles", { data: { name: `Imp${Date.now() % 100000}`, color: "#f59e0b" }, headers });
  expect(r.ok()).toBeTruthy();
  const profileId = (await r.json()).id as string;

  try {
    await page.evaluate(([u, p]) => localStorage.setItem(`martytv.active_profile.${u}`, p), [userId, profileId]);
    await page.goto("/settings");
    const card = page.getByTestId("settings-kp-import").locator("xpath=..");
    await expect(card.getByRole("heading", { name: /import ratings from kinopoisk/i })).toBeVisible();
    await expect(card.getByTestId("kp-import-watched")).toBeChecked();
    await expect(card.getByTestId("kp-import-overwrite")).not.toBeChecked();
    await expect(card.getByTestId("kp-import-start")).toBeDisabled();

    await card.getByTestId("kp-import-file").setInputFiles(FIXTURE);
    const upload = page.waitForResponse((res) => res.url().endsWith(`/profiles/${profileId}/imports/kinopoisk`) && res.request().method() === "POST");
    await card.getByTestId("kp-import-start").click();
    expect((await upload).status()).toBe(202);

    // Progress, then the summary (TMDB searches take a few seconds).
    const summary = card.getByTestId("kp-import-summary");
    await expect(summary).toBeVisible({ timeout: 120_000 });
    await expect(summary.getByRole("status")).toContainText(/4 ratings imported/i);
    await expect(card.getByTestId("kp-import-total")).toHaveText("5");
    await expect(card.getByTestId("kp-import-matched")).toHaveText("4");
    await expect(card.getByTestId("kp-import-rated")).toHaveText("4");
    await expect(card.getByTestId("kp-import-skipped")).toHaveText("0");

    // The unmatched list is collapsed; it links to search.
    const unmatched = card.getByTestId("kp-import-unmatched");
    await unmatched.getByText(/not found \(1\)/i).click();
    await expect(unmatched).toContainText("Несуществующий фильм");
    await expect(unmatched.getByRole("link", { name: /find manually/i })).toHaveAttribute("href", /\/search\?q=/);

    // Ratings show on the title pages (and the titles count as watched).
    for (const [query, rating] of [
      ["Heat", 7],
      ["The Matrix", 9],
    ] as const) {
      const res = await req.get(`/api/v1/catalog/search?q=${encodeURIComponent(query)}&kind=movie&profile_id=${profileId}`);
      const items = (await res.json()).items as { id: string; me?: { rating: number | null; completed: boolean } }[];
      const hit = items.find((i) => i.me?.rating === rating);
      expect(hit, `${query} rated ${rating}`).toBeTruthy();
      expect(hit!.me!.completed).toBe(true);
      await page.goto(`/title/${hit!.id}`);
      await expect(page.getByTestId("rate-button")).toContainText(String(rating));
    }

    // Nothing landed in Continue watching.
    const cw = await (await req.get(`/api/v1/profiles/${profileId}/continue-watching`)).json();
    expect(cw.items).toHaveLength(0);
  } finally {
    await req.delete(`/api/v1/profiles/${profileId}`, { headers });
  }
});
