import { expect, test, type Page, type Request } from "@playwright/test";
import { COLLECTION_ID, collection, forYouRows, json, login, realItems, reason, SHOTS, type Media } from "./foryou-fixtures";

/**
 * Phase 6 on the web: «Для вас» rows with localized reasons, «Не интересно»,
 * Explore → collection, Surprise reveal + reroll, and the admin rerun panel.
 * The e2e profile is a cold start, so personal rows, collections, surprise
 * picks and admin runs are mocked (with real catalog titles); Explore's
 * sections and tiles come from the live API.
 */

function feedbackBodies(page: Page) {
  const bodies: { action?: string; media_id?: string; events?: { action: string; media_id: string; row_id?: string }[] }[] = [];
  page.on("request", (r: Request) => {
    if (r.url().includes("/api/v1/foryou/feedback") && r.method() === "POST") bodies.push(r.postDataJSON());
  });
  return bodies;
}

async function mockRows(page: Page, profileId: string, items: Media[], ru = false) {
  await page.route(/\/api\/v1\/foryou\/rows/, (route) => json(route, forYouRows(profileId, items, ru)));
  await page.route(/\/api\/v1\/foryou\/feedback/, (route) => json(route, { accepted: 1 }, 202));
}

test.describe("web «Для вас»", () => {
  test("rows render with localized reasons; dismiss removes a card; impressions are batched", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const { profileId } = await login(page);
    const items = await realItems(page);
    await mockRows(page, profileId, items);
    const fb = feedbackBodies(page);
    await page.goto("/");

    const section = page.getByTestId("foryou");
    await expect(section).toBeVisible();
    // «Расскажите о вкусах»: the header links to the taste note in Settings.
    await expect(section.getByTestId("taste-link")).toHaveAttribute("href", "/settings#taste");
    // Titles come from the typed reason, never from the server text.
    await expect(section.getByRole("heading", { name: "Because you liked “The Matrix”" })).toBeVisible();
    await expect(section.getByRole("heading", { name: "More from director Denis Villeneuve" })).toBeVisible();
    await expect(section.getByRole("heading", { name: "Hidden gems" })).toBeVisible();
    await expect(section.getByText(/server:/)).toHaveCount(0);
    // «For you» comes after Continue watching / «Советуют близкие» and before the catalog rows.
    const order = await page.evaluate(() => {
      const f = document.querySelector('[data-testid="foryou"]')!;
      const tr = document.querySelector('[data-testid="row-trending"]');
      return tr ? !!(f.compareDocumentPosition(tr) & Node.DOCUMENT_POSITION_FOLLOWING) : true;
    });
    expect(order).toBe(true);
    if (SHOTS) {
      await section.scrollIntoViewIfNeeded();
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${SHOTS}/web-desktop-home-foryou.png` });
    }

    // Hover shows the reason on the poster.
    const row = page.locator('[data-row-id^="byr:"]');
    const card = row.getByTestId("foryou-card").first();
    await card.hover();
    await expect(card.getByTestId("foryou-reason-hover")).toBeVisible();
    await expect(card.getByTestId("foryou-reason-hover")).toHaveText("Because you liked “The Matrix”");

    // One impression batch per visible row.
    await expect.poll(() => fb.flatMap((b) => b.events ?? []).filter((e) => e.action === "impression" && e.row_id?.startsWith("byr:")).length, { timeout: 10_000 }).toBe(7);

    // «Not interested»: the card disappears at once and a dismiss is sent.
    const id = await card.getAttribute("data-media-id");
    await card.getByTestId("foryou-dismiss-quick").click();
    await expect(page.locator(`[data-testid="foryou-card"][data-media-id="${id}"]`)).toHaveCount(0);
    await expect(page.getByTestId("foryou-undo")).toBeVisible();
    await expect.poll(() => fb.some((b) => b.action === "dismiss" && b.media_id === id)).toBe(true);
    await expect(row.getByTestId("foryou-card")).toHaveCount(6);

    // Opening a card sends `open`.
    await row.getByTestId("foryou-card").first().locator("a").click();
    await expect(page).toHaveURL(/\/title\//);
    await expect.poll(() => fb.flatMap((b) => b.events ?? []).some((e) => e.action === "open"), { timeout: 10_000 }).toBe(true);
  });

  test("«Почему?» after «Не интересно» saves a note; the title page shows it; the rating popover asks «Почему?» too", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const { profileId, req, headers } = await login(page, "ru");
    const items = await realItems(page);
    await mockRows(page, profileId, items, true);
    const target = items[1]!;
    try {
      await page.goto("/");
      const card = page.locator(`[data-testid="foryou-card"][data-media-id="${target.id}"]`).first();
      await card.hover();
      await card.getByTestId("foryou-dismiss-quick").click();
      const toast = page.getByTestId("foryou-undo");
      await toast.getByTestId("foryou-dismiss-why").click();
      const editor = toast.getByTestId("foryou-dismiss-note");
      // Dislike chips are offered; pick two and add a comment.
      await expect(editor.locator("[data-reason=too_slow]")).toHaveText("Слишком медленно");
      await expect(editor.locator("[data-reason=loved_atmosphere]")).toHaveCount(0);
      await editor.locator("[data-reason=too_slow]").click();
      await editor.locator("[data-reason=bad_ending]").click();
      await editor.getByTestId("note-text").fill("  Затянуто, а финал слит  ");
      const put = page.waitForRequest((r) => r.url().includes(`/profiles/${profileId}/notes/${target.id}`) && r.method() === "PUT");
      await editor.getByTestId("note-save").click();
      expect((await put).postDataJSON()).toEqual({ text: "Затянуто, а финал слит", reasons: ["too_slow", "bad_ending"] });
      await expect(editor.getByTestId("note-saved")).toContainText("Заметка сохранена");

      // The title page shows «Моя заметка».
      await page.goto(`/title/${target.id}`);
      const noteCard = page.getByTestId("note-card");
      await expect(noteCard.getByTestId("note-view")).toContainText("Затянуто, а финал слит");
      await expect(noteCard.locator("[data-reason=bad_ending]")).toHaveText("Плохая концовка");

      // Rating popover: a high score suggests the like chips; «Почему?» saves.
      await page.getByTestId("rate-button").click();
      await page.getByTestId("rating-scale").getByRole("radio", { name: "9", exact: true }).click();
      await page.getByTestId("rate-why").click();
      const pop = page.getByTestId("rate-note");
      await expect(pop.locator("[data-reason=loved_atmosphere]")).toBeVisible();
      await expect(pop.locator("[data-reason=too_violent]")).toHaveCount(0);
      await pop.locator("[data-reason=loved_atmosphere]").click();
      const put2 = page.waitForRequest((r) => r.url().includes(`/notes/${target.id}`) && r.method() === "PUT");
      await pop.getByTestId("note-save").click();
      expect((await put2).postDataJSON()).toEqual({ text: "Затянуто, а финал слит", reasons: ["too_slow", "bad_ending", "loved_atmosphere"] });
      await expect(page.getByTestId("rate-popover")).toHaveCount(0);
      await expect(noteCard.locator("[data-reason=loved_atmosphere]")).toBeVisible();

      // «Мои заметки» lists it (linked from History).
      await page.goto("/history");
      await page.getByTestId("history-notes").click();
      await expect(page.locator(`[data-testid="note-item"][data-media-id="${target.id}"]`)).toContainText("Затянуто, а финал слит");
    } finally {
      await req.put(`/api/v1/profiles/${profileId}/notes/${target.id}`, { data: { text: "", reasons: [] }, headers });
      await req.delete(`/api/v1/profiles/${profileId}/ratings/${target.id}`, { headers });
      await req.post("/api/v1/foryou/feedback", { data: { profile_id: profileId, media_id: target.id, action: "undismiss" }, headers });
    }
  });

  test("phone: long-press shows the reason and «Не интересно»", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const { profileId } = await login(page, "ru");
    const items = await realItems(page, "ru");
    await mockRows(page, profileId, items, true);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Потому что вам понравился «Матрица»" })).toBeVisible();
    const card = page.getByTestId("foryou-card").first();
    await card.getByTestId("foryou-why").tap();
    await expect(card.getByTestId("foryou-reason")).toHaveText("Потому что вам понравился «Матрица»");
    if (SHOTS) {
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/web-phone-home-foryou.png` });
    }
    const id = await card.getAttribute("data-media-id");
    await card.getByTestId("foryou-dismiss").tap();
    await expect(page.locator(`[data-testid="foryou-card"][data-media-id="${id}"]`)).toHaveCount(0);
    await ctx.close();
  });

  test("explore → tile and AI collection", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const { profileId } = await login(page, SHOTS ? "ru" : undefined);
    const items = await realItems(page);
    // Live sections plus one AI collection section (AI is off on the dev server).
    await page.route(/\/api\/v1\/foryou\/explore/, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.sections.push({
        id: "collections",
        kind: "collections",
        title: "AI collections",
        tiles: [{ id: `collection:${COLLECTION_ID}`, kind: "collection", title: collection(items).title, subtitle: collection(items).description, emoji: "🌧", image_path: items[3]!.backdrop_path, collection_id: COLLECTION_ID, discover: null }],
      });
      return json(route, body);
    });
    await page.route(/\/api\/v1\/foryou\/collections\/[^/?]+/, (route) => json(route, collection(items, !!SHOTS)));
    await page.goto("/");
    // Top nav: Explore.
    await page.locator("header nav").getByRole("link", { name: /^(explore|обзор)$/i }).click();
    await expect(page).toHaveURL(/\/explore$/);
    await expect(page.getByTestId("explore-moods")).toBeVisible({ timeout: 20_000 });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/web-desktop-explore.png`, fullPage: true });

    // A live tile opens its titles.
    await page.getByTestId("explore-moods").getByTestId("explore-tile").first().click();
    await expect(page).toHaveURL(/\/explore\/mood%3A/);
    await expect(page.getByTestId("poster-grid").or(page.getByText(/nothing here yet|здесь пока пусто/i))).toBeVisible({ timeout: 30_000 });
    await page.goBack();

    // The collection tile opens the collection page with the AI badge.
    await page.getByTestId("explore-collections").getByTestId("explore-tile").click();
    await expect(page).toHaveURL(new RegExp(`/collections/${COLLECTION_ID}`));
    await expect(page.getByTestId("collection-title")).toHaveText(collection(items, !!SHOTS).title);
    await expect(page.getByTestId("collection").getByTestId("ai-badge")).toBeVisible();
    await expect(page.getByTestId("poster-grid").getByTestId("poster-card")).toHaveCount(12);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/web-desktop-collection.png` });
    void profileId;
  });

  test("«Обновить подборки ИИ»: once a day, spinner while running, then «Доступно завтра»", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const { profileId } = await login(page, "ru");
    const items = await realItems(page);
    await mockRows(page, profileId, items, true);
    // AI is off on the dev server: the status endpoint is mocked.
    const tomorrow = new Date(Date.now() + 86_400_000);
    tomorrow.setUTCHours(21, 0, 0, 0);
    let phase: "available" | "running" | "used" = "available";
    let polls = 0;
    const posts: unknown[] = [];
    const status = () => ({
      available: phase === "available",
      used_today: phase === "available" ? 0 : 1,
      daily_limit: 1,
      unlimited: false,
      next_available_at: phase === "used" ? tomorrow.toISOString() : new Date().toISOString(),
      running: phase === "running",
      run_id: phase === "running" ? "00000000-0000-4000-8000-0000000000aa" : null,
      ai_enabled: true,
    });
    await page.route(/\/api\/v1\/foryou\/regenerate/, (route) => {
      if (route.request().method() === "POST") {
        posts.push(route.request().postDataJSON());
        phase = "running";
        return json(route, status(), 202);
      }
      if (phase === "running" && ++polls >= 2) phase = "used";
      return json(route, status());
    });
    await page.goto("/");
    const regen = page.getByTestId("foryou").getByTestId("regen");
    await expect(regen).toHaveAttribute("data-state", "available");
    await expect(regen.getByTestId("regen-hint")).toHaveText("1 раз в день · следующее обновление завтра");
    await regen.getByTestId("regen-button").click();
    await expect(regen).toHaveAttribute("data-state", "running");
    await expect(regen.getByTestId("regen-button")).toContainText("Обновляем подборки");
    await expect(regen.getByTestId("regen-button")).toBeDisabled();
    expect(posts).toEqual([{ profile_id: profileId }]);
    // When it ends, rows refetch and the button says when it's next available.
    const refetch = page.waitForRequest((r) => r.url().includes("/api/v1/foryou/rows"));
    await expect(regen).toHaveAttribute("data-state", "used", { timeout: 15_000 });
    await refetch;
    await expect(regen.getByTestId("regen-button")).toBeDisabled();
    await expect(regen.getByTestId("regen-hint")).toHaveText(/^Доступно завтра в \d\d:\d\d$/);
  });

  test("surprise: spoiler-free reveal and reroll", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, SHOTS ? "ru" : undefined);
    const items = await realItems(page);
    const sent: { exclude_ids?: string[]; mood?: string; kind?: string }[] = [];
    let n = 0;
    await page.route(/\/api\/v1\/foryou\/surprise(\?.*)?$/, (route) => {
      sent.push(route.request().postDataJSON());
      const m = items[n++ % items.length]!;
      return json(route, {
        media: m,
        reason: reason("mood", { mood: "cozy" }),
        source: "pool",
        pool_size: 42,
        reroll: { exclude_ids: items.slice(0, n).map((x) => x.id) },
      });
    });
    await page.route(/\/api\/v1\/foryou\/feedback/, (route) => json(route, { accepted: 1 }, 202));
    await page.goto("/surprise");
    await page.getByTestId("mood-cozy").click();
    await page.getByTestId("surprise-go").click();
    const result = page.getByTestId("surprise-result");
    await expect(result).toBeVisible();
    expect(sent[0]).toMatchObject({ mood: "cozy", kind: "movie" });
    // Spoiler-free (default): no title / poster until «Reveal».
    await expect(result).toHaveAttribute("data-hidden", "1");
    await expect(page.getByTestId("surprise-title")).toHaveCount(0);
    await expect(page.getByTestId("surprise-reason")).toHaveText(/cozy|уютное/i);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/web-desktop-surprise-hidden.png`, fullPage: true });
    await page.getByTestId("surprise-reveal").click();
    await expect(page.getByTestId("surprise-title")).toHaveText(items[0]!.title);
    await expect(page.getByTestId("surprise-watch")).toBeVisible();
    await expect(page.getByTestId("surprise-tv")).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/web-desktop-surprise-revealed.png`, fullPage: true });
    // Reroll sends the shown ids back and hides the new pick again.
    await page.getByTestId("surprise-reroll").click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1]!.exclude_ids).toEqual([items[0]!.id]);
    await expect(result).toHaveAttribute("data-hidden", "1");
    await page.getByTestId("surprise-reveal").click();
    await expect(page.getByTestId("surprise-title")).toHaveText(items[1]!.title);
  });

  test("admin: rerun shows progress; 409 says already running", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, SHOTS ? "ru" : undefined);
    const run = (status: string, done: number, extra: Record<string, unknown> = {}) => ({
      id: "11111111-2222-4333-8444-555555555555",
      scope: "all",
      target_id: null,
      ai: true,
      trigger: "admin",
      status,
      requested_by: { id: "x", username: "e2e-admin" },
      profiles_total: 3,
      profiles_done: done,
      ai_calls: done,
      ai_tokens: done * 2100,
      collections_created: done,
      errors: [],
      started_at: new Date(Date.now() - 20_000).toISOString(),
      finished_at: status === "running" ? null : new Date().toISOString(),
      duration_ms: status === "running" ? null : 20_000,
      ...extra,
    });
    let calls = 0;
    let started = false;
    const failed = run("failed", 1, { id: "99999999-2222-4333-8444-555555555555", trigger: "schedule", requested_by: null, errors: [{ profile_id: null, step: "ai", message: "budget exhausted" }] });
    await page.route(/\/api\/v1\/admin\/foryou\/runs/, (route) => {
      const items = !started ? [failed] : calls++ < 2 ? [run("running", calls), failed] : [run("completed", 3), failed];
      return json(route, { items, ai: { enabled: true, model: "deepseek-chat", tokens_today: 4515, daily_budget: 300000, run_budget: 200000 }, daily_at: "05:00", next_run_at: "2026-10-30T02:00:00Z" });
    });
    const posts: unknown[] = [];
    await page.route(/\/api\/v1\/admin\/foryou\/rerun/, (route) => {
      posts.push(route.request().postDataJSON());
      if (started) return json(route, { error: { code: "run_in_progress", message: "A run is in progress" }, run_id: "11111111-2222-4333-8444-555555555555" }, 409);
      started = true;
      return json(route, { run_id: "11111111-2222-4333-8444-555555555555" }, 202);
    });
    await page.goto("/admin");
    await page.getByRole("tab", { name: /recommendations|рекомендации/i }).click();
    await expect(page).toHaveURL(/tab=foryou/);
    await expect(page.getByTestId("foryou-run")).toHaveCount(1);
    await expect(page.getByTestId("foryou-run").first()).toHaveAttribute("data-status", "failed");
    await page.getByTestId("foryou-rerun").click();
    await expect.poll(() => posts[0]).toEqual({ scope: "all", ai: true });
    // Polls while running: 1 → 2 → completed.
    await expect(page.locator('[data-testid="foryou-run"][data-status="running"]')).toBeVisible();
    await expect(page.locator('[data-testid="foryou-run"][data-status="running"] [data-testid="foryou-run-progress"]')).toHaveText(/[12] (of|из) 3/);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/web-desktop-admin-foryou.png`, fullPage: true });
    await expect(page.locator('[data-testid="foryou-run"][data-status="completed"]')).toBeVisible({ timeout: 15_000 });
    // A second start while one runs → "already running".
    await page.getByTestId("foryou-rerun").click();
    await expect(page.getByTestId("foryou-already")).toBeVisible();
  });
});
