import { expect, test } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

// Web: /taste-quiz — rate a title with the stars, skip one, answer a question.
test("web taste quiz: rate, skip, answer", async ({ page }) => {
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
  // Clear answers a previous (aborted) run may have left on this profile.
  const headers = { "X-CSRF-Token": session.csrf_token, Origin: origin };
  await page.request.post(`/api/v1/profiles/${pid}/taste-quiz/answers`, { headers, data: { questions: { genres_like: [], genres_dislike: [] } } });

  await page.goto("/taste-quiz");
  const title = page.getByTestId("quiz-title");
  await expect(title).toBeVisible({ timeout: 30_000 });
  const id1 = (await title.getAttribute("data-media-id"))!;
  try {
    await title.locator('[data-star="7"]').click();
    // The next title — unless the dev profile has rated every candidate and
    // the quiz goes straight to the questions.
    const question = page.getByTestId("quiz-question");
    await expect
      .poll(async () => ((await question.isVisible()) ? "question" : await title.getAttribute("data-media-id").catch(() => null)))
      .not.toBe(id1);
    if (!(await question.isVisible())) {
      await page.locator('[data-action="unseen"]').click();
      await page.locator('[data-action="enough"]').click();
    }
    await expect(page.getByTestId("quiz-question")).toHaveAttribute("data-question", "genres_like");
    await page.locator('[data-option="35"]').click();
    await expect(page.locator('[data-option="35"]')).toHaveAttribute("aria-pressed", "true");
    await page.locator('[data-action="next"]').click();
    await expect(page.getByTestId("quiz-question")).toHaveAttribute("data-question", "genres_dislike");
    await expect
      .poll(async () => (await (await page.request.get(`/api/v1/profiles/${pid}/taste-quiz`)).json()).answers.genres_like ?? [])
      .toContain("35");
    const me = await (await page.request.get(`/api/v1/media/${id1}?lang=en&profile_id=${pid}`)).json();
    expect(me.me?.rating).toBe(7);
  } finally {
    await page.request.delete(`/api/v1/profiles/${pid}/ratings/${id1}`, { headers }).catch(() => undefined);
  }
});
