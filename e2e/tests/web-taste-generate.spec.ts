import { expect, test } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
const GENERATED = ["genres_like", "genres_dislike", "eras", "origins", "mood", "format", "intensity"];

// Web: «✨ Заполнить по моим фильмам» on /taste-quiz and on /taste — the
// questionnaire filled from the profile's ratings; pressing it again regenerates.
test("web taste quiz: fill in from my movies", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(USER);
  await page.getByLabel(/password/i).fill(PASS);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
  const origin = new URL(page.url()).origin;
  const session = await (await page.request.get("/api/v1/auth/session")).json();
  const profiles = await (await page.request.get("/api/v1/profiles")).json();
  const pid = profiles.items[0].id as string;
  const headers = { "X-CSRF-Token": session.csrf_token, Origin: origin };
  const before = (await (await page.request.get(`/api/v1/profiles/${pid}/taste-quiz`)).json()).answers as Record<string, string[]>;

  // Three well-known titles rated high (the generator needs ≥ 3).
  const titles = (await (await page.request.get(`/api/v1/profiles/${pid}/taste-quiz/titles?lang=en&limit=3`)).json()).items as { id: string }[];
  expect(titles.length).toBe(3);
  const rated: string[] = [];
  try {
    for (const t of titles) {
      const res = await page.request.put(`/api/v1/profiles/${pid}/ratings/${t.id}`, { headers, data: { rating: 9 } });
      expect(res.status()).toBe(204);
      rated.push(t.id);
    }

    await page.goto("/taste-quiz");
    const btn = page.getByTestId("quiz-generate");
    await expect(btn).toBeVisible({ timeout: 30_000 });
    await btn.click();
    await expect(page.getByTestId("quiz-generate-status")).toHaveAttribute("data-status", "ok", { timeout: 30_000 });
    // The filled-in answers are shown for tweaking.
    await expect(page.getByTestId("quiz-question")).toHaveAttribute("data-question", "genres_like");
    const after = (await (await page.request.get(`/api/v1/profiles/${pid}/taste-quiz`)).json()).answers as Record<string, string[]>;
    expect(after.genres_like?.length ?? 0).toBeGreaterThan(0);

    // Taste page: the preferences panel; regenerate from there.
    await page.goto("/taste");
    const panel = page.getByTestId("taste-preferences");
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('[data-question="genres_like"]')).toBeVisible();
    await expect(panel.getByTestId("quiz-generate")).toHaveAttribute("data-filled", "true");
    await panel.getByTestId("quiz-generate").click();
    await expect(panel.getByTestId("quiz-generate-status")).toHaveAttribute("data-status", "ok", { timeout: 30_000 });
  } finally {
    for (const id of rated) await page.request.delete(`/api/v1/profiles/${pid}/ratings/${id}`, { headers }).catch(() => undefined);
    // Restore the answers the profile had.
    const restore: Record<string, string[]> = {};
    for (const q of GENERATED) restore[q] = before[q] ?? [];
    await page.request.post(`/api/v1/profiles/${pid}/taste-quiz/answers`, { headers, data: { questions: restore } }).catch(() => undefined);
  }
});
