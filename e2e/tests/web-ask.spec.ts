import { expect, test, type Page, type Request } from "@playwright/test";
import { json, login, realItems, type Media } from "./foryou-fixtures";

/**
 * «Спросить ИИ» on the web: examples → thinking → answer + poster grid with
 * «почему», follow-ups, «Не интересно» + undo, opening sends `open`/ask,
 * history reopen, error states and the phone → TV flow. /foryou/ask and
 * /foryou/asks are mocked (no tokens spent); titles are real catalog items.
 * Screenshots go to $ASK_SHOTS (default /tmp/pw-ask/web).
 */

const SHOTS = process.env.ASK_SHOTS ?? "/tmp/pw-ask/web";
const DEVICE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const WHY = [
  "Лёгкая и смешная — идеально на вечер вдвоём.",
  "Тёплая история без лишней драмы, меньше двух часов.",
  "Остроумные диалоги и красивые виды.",
  "Добрый юмор, который понравится обоим.",
  "Немного приключений и много обаяния.",
  "Классика, которую приятно пересмотреть вместе.",
];

function askResult(profileId: string, items: Media[], over: Record<string, unknown> = {}) {
  return {
    id: "c0a80101-0000-4000-8000-000000000001",
    profile_id: profileId,
    prompt: "Что-нибудь лёгкое на вечер, не ужасы, до 2 часов",
    kind: "any",
    include_watched: false,
    answer: "Вот несколько лёгких фильмов на вечер: смешные, тёплые и без ужасов. Все короче двух часов.",
    items: items.slice(0, 6).map((m, i) => ({ media: m, why: WHY[i]! })),
    followups: ["Только комедии", "Что-нибудь поновее", "С русской озвучкой"],
    refused: false,
    tokens: 1834,
    created_at: new Date().toISOString(),
    ...over,
  };
}

/** Lets lazy posters load, then scrolls back to the top (for full-page shots). */
async function settle(page: Page) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
}

function bodiesOf(page: Page, part: string) {
  const out: Record<string, unknown>[] = [];
  page.on("request", (r: Request) => {
    if (r.url().includes(part) && r.method() === "POST") out.push(r.postDataJSON());
  });
  return out;
}

async function mockAsk(page: Page, profileId: string, items: Media[], history: unknown[] = [], delay = 700) {
  const answer = askResult(profileId, items);
  await page.route(/\/api\/v1\/foryou\/asks/, (route) => json(route, { items: history, ai_enabled: true, daily_limit: 30 }));
  await page.route(/\/api\/v1\/foryou\/ask(\?|$)/, async (route) => {
    await new Promise((r) => setTimeout(r, delay));
    const body = route.request().postDataJSON() as { prompt: string; device_id?: string };
    await json(route, { ...answer, prompt: body.prompt, ...(body.device_id ? { sent_to_device: true } : {}) });
  });
  await page.route(/\/api\/v1\/foryou\/feedback/, (route) => json(route, { accepted: 1 }, 202));
  return answer;
}

test.describe("web «Спросить ИИ»", () => {
  test("desktop: example → thinking → answer grid; follow-up, dismiss, open, history", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { profileId } = await login(page, "ru");
    const items = await realItems(page, "ru");
    const previous = askResult(profileId, items.slice(6), { id: "c0a80101-0000-4000-8000-000000000002", prompt: "Сериал про ограбления, русская озвучка", answer: "Вот сериалы про ограбления.", created_at: "2026-10-27T18:00:00Z" });
    await mockAsk(page, profileId, items, [previous]);
    const asks = bodiesOf(page, "/api/v1/foryou/ask?");
    const fb = bodiesOf(page, "/api/v1/foryou/feedback");

    // Entry points: desktop nav and the Home card.
    await page.goto("/");
    await expect(page.getByTestId("ask-card-entry")).toBeVisible();
    await page.getByRole("navigation").getByRole("link", { name: "Спросить ИИ" }).click();
    await expect(page).toHaveURL(/\/ask$/);
    await expect(page.getByRole("heading", { name: "Спросить ИИ" })).toBeVisible();
    await expect(page.getByTestId("ask-history-item")).toHaveCount(1);
    await page.screenshot({ path: `${SHOTS}/web-desktop-ask-empty.png` });

    await page.getByTestId("ask-kind").getByRole("radio", { name: "Фильмы" }).click();
    await page.getByTestId("ask-example-light").click();
    await expect(page.getByTestId("ask-thinking")).toBeVisible();
    await expect(page.getByTestId("ask-user")).toContainText("лёгкое на вечер");
    await page.screenshot({ path: `${SHOTS}/web-desktop-ask-thinking.png` });
    await expect(page.getByTestId("ask-card")).toHaveCount(6);
    expect(asks[0]).toMatchObject({ profile_id: profileId, prompt: "Что-нибудь лёгкое на вечер, не ужасы, до 2 часов", kind: "movie", include_watched: false, lang: "ru" });
    await expect(page.getByTestId("ask-answer-text")).toContainText("лёгких фильмов");
    await expect(page.getByTestId("ask-why").first()).toContainText(WHY[0]!);
    await expect(page.getByTestId("ask-tokens")).toContainText("1");
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/web-desktop-ask.png`, fullPage: true });

    // A follow-up refines the ask at once: the first words + the chip, same kind (as in search and on the TV).
    await page.getByTestId("ask-followups").getByRole("button", { name: /Только комедии/ }).click();
    await expect(page.getByTestId("ask-user")).toHaveText(/только комедии$/);
    await expect(page.getByTestId("ask-card")).toHaveCount(6);
    expect(asks[1]).toMatchObject({ prompt: "Что-нибудь лёгкое на вечер, не ужасы, до 2 часов, только комедии", kind: "movie", include_watched: false });

    // «Не интересно» + undo.
    const card = page.getByTestId("ask-card").nth(1);
    const id = await card.getAttribute("data-media-id");
    await card.getByTestId("ask-dismiss").click();
    await expect(card).toHaveAttribute("data-hidden", "1");
    await expect.poll(() => fb.some((b) => b.action === "dismiss" && b.media_id === id && b.row_id === "ask")).toBe(true);
    await card.getByTestId("ask-undo").click();
    await expect.poll(() => fb.some((b) => b.action === "undismiss" && b.media_id === id)).toBe(true);

    // History reopens without a new call.
    const before = asks.length;
    await page.getByTestId("ask-history-item").filter({ hasText: "ограбления" }).click();
    await expect(page.getByTestId("ask-answer-text")).toHaveText("Вот сериалы про ограбления.");
    expect(asks.length).toBe(before);

    // Opening a poster: feedback `open` with row_id "ask".
    await page.getByTestId("ask-card").first().locator("a").click();
    await expect(page).toHaveURL(/\/title\//);
    const opens = () => fb.flatMap((b) => (b.events as { action: string; row_id?: string }[] | undefined) ?? [b as { action: string; row_id?: string }]);
    await expect.poll(() => opens().some((e) => e.action === "open" && e.row_id === "ask"), { timeout: 10_000 }).toBe(true);
  });

  test("error states: limit, AI off, failure with retry; refused answers", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const { profileId } = await login(page, "ru");
    await page.route(/\/api\/v1\/foryou\/asks/, (route) => json(route, { items: [], ai_enabled: true, daily_limit: 30 }));
    let mode: "limit" | "disabled" | "failed" | "refused" = "limit";
    await page.route(/\/api\/v1\/foryou\/ask(\?|$)/, (route) => {
      const err = (status: number, code: string) => json(route, { error: { code, message: code } }, status);
      if (mode === "limit") return err(429, "ask_limit");
      if (mode === "disabled") return err(503, "ai_disabled");
      if (mode === "failed") return err(502, "ai_failed");
      return json(route, { ...askResult(profileId, []), refused: true, items: [], answer: "Я помогаю только с выбором фильмов и сериалов.", tokens: 0 });
    });
    await page.goto("/ask");
    const input = page.getByTestId("ask-input");
    await input.fill("как сварить борщ");
    await input.press("Enter");
    await expect(page.getByTestId("ask-error")).toContainText("На сегодня всё");
    await expect(page.getByTestId("ask-retry")).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/web-desktop-ask-limit.png` });

    mode = "disabled";
    await input.fill("лёгкая комедия");
    await page.getByTestId("ask-send").click();
    await expect(page.getByTestId("ask-error").locator("[data-kind]")).toHaveAttribute("data-kind", "disabled");

    mode = "failed";
    await input.fill("лёгкая комедия");
    await page.getByTestId("ask-send").click();
    await expect(page.getByTestId("ask-error").locator("[data-kind]")).toHaveAttribute("data-kind", "failed");
    mode = "refused";
    await page.getByTestId("ask-retry").click();
    await expect(page.getByTestId("ask-refused")).toBeVisible();
    await expect(page.getByTestId("ask-card")).toHaveCount(0);
    await expect(page.getByTestId("ask-followups").getByRole("button")).toHaveCount(3);
  });

  test("phone: asking for the TV from its QR link", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const { profileId } = await login(page, "ru");
    const items = await realItems(page, "ru");
    await mockAsk(page, profileId, items, [], 300);
    const asks = bodiesOf(page, "/api/v1/foryou/ask?");
    await page.goto(`/ask?device=${DEVICE}&profile=${profileId}`);
    await expect(page.getByTestId("ask-for-tv")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/web-phone-ask-empty.png` });
    await page.getByTestId("ask-input").fill("фильмы как Интерстеллар, но менее известные");
    await page.getByTestId("ask-send").click();
    await expect(page.getByTestId("ask-card")).toHaveCount(6);
    expect(asks[0]).toMatchObject({ device_id: DEVICE, profile_id: profileId, kind: "any" });
    await expect(page.getByTestId("ask-sent")).toHaveText("Отправлено на ТВ");
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/web-phone-ask.png`, fullPage: true });
    await ctx.close();
  });

  test("phone: Home and Обзор show the Ask AI card", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await login(page, "ru");
    await page.route(/\/api\/v1\/foryou\/asks/, (route) => json(route, { items: [], ai_enabled: true, daily_limit: 30 }));
    await expect(page.getByTestId("ask-card-entry")).toBeVisible();
    await page.goto("/explore");
    await page.getByTestId("ask-card-entry").click();
    await expect(page).toHaveURL(/\/ask$/);
    await expect(page.getByTestId("ask-examples").getByRole("button")).toHaveCount(4);
    await ctx.close();
  });
});
