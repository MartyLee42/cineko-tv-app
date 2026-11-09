import { expect, test } from "@playwright/test";
import { json, login, realItems } from "./foryou-fixtures";

/**
 * Search's «✦ ИИ»: a regular search offers «Спросить ИИ: «…»»; AI mode sends
 * the typed words to /foryou/ask (only on Enter / the button), shows the
 * answer and titles inline, follow-ups re-ask, Back from a title restores the
 * answer. /foryou/ask and /foryou/asks are mocked (no tokens spent).
 */
test.use({ viewport: { width: 390, height: 844 } });

test("web search: ask AI from the search box", async ({ page }) => {
  const { profileId } = await login(page, "ru");
  const items = await realItems(page, "ru");
  const asked: { prompt: string; kind: string; include_watched: boolean; creativity?: string }[] = [];
  const history: unknown[] = [];
  await page.route(/\/api\/v1\/foryou\/asks/, (route) => json(route, { items: history, ai_enabled: true, daily_limit: 30 }));
  await page.route(/\/api\/v1\/foryou\/ask(\?|$)/, async (route) => {
    const body = route.request().postDataJSON() as { prompt: string; kind: string; include_watched: boolean };
    asked.push(body);
    await new Promise((r) => setTimeout(r, 400));
    const res = {
      id: `c0a80101-0000-4000-8000-00000000000${asked.length}`,
      profile_id: profileId,
      prompt: body.prompt,
      kind: body.kind,
      include_watched: body.include_watched,
      answer: `Ответ на «${body.prompt}».`,
      items: items.slice(asked.length, asked.length + 4).map((m) => ({ media: m, why: "Потому что подходит." })),
      followups: ["Только комедии"],
      refused: false,
      tokens: 1000,
      created_at: new Date().toISOString(),
    };
    history.unshift(res);
    await json(route, res);
  });
  await page.route(/\/api\/v1\/foryou\/feedback/, (route) => json(route, { accepted: 1 }, 202));

  // Regular search offers the AI with the same words.
  const q = "лёгкая комедия на вечер";
  await page.goto(`/search?q=${encodeURIComponent(q)}`);
  const suggest = page.getByTestId("search-ask-ai");
  await expect(suggest).toContainText(q);
  expect(asked).toHaveLength(0); // nothing is sent while typing
  await suggest.click();
  await expect(page).toHaveURL(/ai=1/);
  await expect(page.getByTestId("ask-thinking")).toBeVisible();
  await expect(page.getByTestId("ask-answer-text")).toHaveText(`Ответ на «${q}».`);
  await expect(page.getByTestId("ask-card")).toHaveCount(4);
  // The same ask as «Спросить ИИ»: watched titles left out unless ticked, the same controls.
  expect(asked[0]).toMatchObject({ prompt: q, kind: "any", include_watched: false, creativity: "normal" });
  await expect(page.getByTestId("search-ai-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("ask-watched")).not.toBeChecked();
  await expect(page.getByTestId("ask-creativity")).toBeVisible();
  await expect(page.getByTestId("ask-why").first()).toHaveText("Потому что подходит.");

  // Typing doesn't send; Enter does, with the kind tab.
  await page.getByRole("tab", { name: "Фильмы" }).click();
  const input = page.getByTestId("search-input");
  await input.fill("триллер про ограбление банка");
  await page.waitForTimeout(600);
  expect(asked).toHaveLength(1);
  await input.press("Enter");
  await expect(page.getByTestId("ask-answer-text")).toHaveText("Ответ на «триллер про ограбление банка».");
  expect(asked[1]).toMatchObject({ prompt: "триллер про ограбление банка", kind: "movie" });

  // A follow-up chip re-asks with the refined words, shown in the box.
  await page.getByTestId("ask-followups").getByRole("button").first().click();
  await expect(page.getByTestId("ask-answer-text")).toHaveText(/только комедии/i);
  expect(asked[2]!.prompt).toMatch(/^триллер про ограбление банка, только комедии$/);
  await expect(input).toHaveValue(asked[2]!.prompt);

  // Open a title, come back: the answer is still there (no new ask).
  const card = page.getByTestId("ask-card").first();
  const id = await card.getAttribute("data-media-id");
  await card.locator("a").first().click();
  await expect(page).toHaveURL(new RegExp(`/title/${id}`));
  await page.goBack();
  await expect(page.getByTestId("ask-answer-text")).toHaveText(/только комедии/i);
  expect(asked).toHaveLength(3);

  // Back to regular search: posters from the title search.
  await page.getByTestId("search-ai-toggle").click();
  await expect(page).not.toHaveURL(/ai=1/);
  await expect(page.getByTestId("ai-search")).toHaveCount(0);
  await expect(page.getByTestId("search-ask-ai")).toBeVisible();
});

test("web search: no AI chip when AI is off", async ({ page }) => {
  await login(page, "ru");
  await page.route(/\/api\/v1\/foryou\/asks/, (route) => json(route, { items: [], ai_enabled: false, daily_limit: 30 }));
  await page.goto("/search?q=matrix");
  await expect(page.getByTestId("poster-card").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("search-ai-toggle")).toHaveCount(0);
  await expect(page.getByTestId("search-ask-ai")).toHaveCount(0);
});
