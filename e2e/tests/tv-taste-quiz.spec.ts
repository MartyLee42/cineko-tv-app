import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
/** SHOTS=<dir> saves screenshots of the quiz (kinozal + wireframe). */
const SHOTS = process.env.SHOTS ?? null;

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function press(tv: Page, key: string, times = 1) {
  for (let i = 0; i < times; i++) {
    await tv.keyboard.press(key);
    await tv.waitForTimeout(170);
  }
}

/**
 * The design and a fresh-looking quiz (the invitation shows); everything the
 * quiz saves (titles, answers, finish) goes to the real server.
 */
async function mockBase(ctx: BrowserContext, design: string) {
  await ctx.unrouteAll({ behavior: "ignoreErrors" });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch().catch(() => null);
    const body = res && res.ok() ? await res.json() : {};
    return json(route, { ...body, design, theme: "dark", onboarding_completed: true });
  });
  // Until this run finishes it, the quiz looks never taken (earlier runs
  // completed it on the shared e2e profile).
  let finished = false;
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/taste-quiz\/finish/, (route) => {
    finished = true;
    return route.continue();
  });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/taste-quiz(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    if (finished) return json(route, body);
    return json(route, { ...body, completed_at: null, dismissed_at: null, rated: 0, answered: 0, answers: {} });
  });
}

test("TV taste quiz: Home invitation, rate titles, answer questions, finish", async ({ browser }) => {
  test.setTimeout(180_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: "en-US" });
  const phone = await phoneCtx.newPage();
  const tv = await tvCtx.newPage();

  await phone.goto("/login");
  await phone.getByLabel(/username/i).fill(USER);
  await phone.getByLabel(/password/i).fill(PASS);
  await phone.getByRole("button", { name: /sign in/i }).click();
  await expect(phone.getByRole("heading", { name: /welcome/i })).toBeVisible();
  const origin = new URL(phone.url()).origin;
  const session = await (await phoneCtx.request.get("/api/v1/auth/session")).json();
  const headers = { "X-CSRF-Token": session.csrf_token, Origin: origin };

  await mockBase(tvCtx, "kinozal");
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  await phone.getByLabel(/tv name/i).fill(`E2E Quiz TV ${Date.now()}`);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  const rated: string[] = [];
  let pid = "";
  try {
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");
    const profiles = await (await phoneCtx.request.get("/api/v1/profiles")).json();
    pid = profiles.items[0].id as string;

    // Test browsers skip the invitation unless ?quiz=1.
    await tv.goto("/tv/?quiz=1");
    await expect(tv.locator('[data-design-shell="kinozal"]')).toBeVisible({ timeout: 30_000 });
    const invite = tv.getByTestId("quiz-invite");
    await expect(invite).toBeVisible({ timeout: 15_000 });
    await expect(invite).toContainText("Let's find your taste");
    if (SHOTS) await tv.screenshot({ path: `${SHOTS}/kinozal-invite.png` });
    await press(tv, "Enter");

    // ---- Titles: OK rates with the focused star (8 by default).
    const quiz = tv.getByTestId("taste-quiz");
    await expect(quiz).toHaveAttribute("data-phase", "titles");
    const title = tv.getByTestId("quiz-title");
    await expect(title).toBeVisible({ timeout: 30_000 });
    const id1 = (await title.getAttribute("data-media-id"))!;
    if (SHOTS) await tv.screenshot({ path: `${SHOTS}/kinozal-title.png` });
    await press(tv, "Enter");
    rated.push(id1);
    await expect(title).not.toHaveAttribute("data-media-id", id1);
    const id2 = (await title.getAttribute("data-media-id"))!;
    await press(tv, "ArrowLeft", 2); // 6 stars
    await expect(tv.getByTestId("quiz-stars")).toContainText("6 of 10");
    await press(tv, "Enter");
    rated.push(id2);
    await expect(tv.getByTestId("quiz-progress")).toHaveText("Rated 2 of 20");
    // ▼ to the buttons: «Haven't seen», then «Enough».
    await press(tv, "ArrowDown");
    const id3 = (await title.getAttribute("data-media-id"))!;
    await press(tv, "Enter");
    await expect(title).not.toHaveAttribute("data-media-id", id3);
    await press(tv, "ArrowDown");
    await press(tv, "ArrowRight", 3);
    await expect(tv.locator('[data-action="enough"].is-focused')).toHaveCount(1);
    await press(tv, "Enter");

    // ---- Questions: OK toggles a chip; ▼ to «Next».
    const q = tv.getByTestId("quiz-question");
    await expect(q).toHaveAttribute("data-question", "genres_like");
    await press(tv, "Enter");
    await expect(q.locator('[data-option="28"]')).toHaveAttribute("data-selected", "true");
    if (SHOTS) await tv.screenshot({ path: `${SHOTS}/kinozal-question.png` });
    for (let i = 0; i < 12 && (await tv.getByTestId("quiz-done").count()) === 0; i++) {
      await press(tv, "ArrowDown", 5);
      await press(tv, "Enter");
    }
    await expect(tv.getByTestId("quiz-done")).toBeVisible();
    if (SHOTS) await tv.screenshot({ path: `${SHOTS}/kinozal-done.png` });
    await press(tv, "Enter");
    await expect(quiz).toHaveCount(0);

    // ---- The server has it all.
    await expect
      .poll(async () => (await (await phoneCtx.request.get(`/api/v1/profiles/${pid}/taste-quiz`)).json()).completed_at, { timeout: 10_000 })
      .not.toBeNull();
    const st = await (await phoneCtx.request.get(`/api/v1/profiles/${pid}/taste-quiz`)).json();
    expect(st.rated).toBeGreaterThanOrEqual(2);
    expect(st.answers.genres_like).toContain("28");
    const me = async (id: string) => (await (await phoneCtx.request.get(`/api/v1/media/${id}?lang=en&profile_id=${pid}`)).json()).me?.rating;
    expect(await me(id1)).toBe(8);
    expect(await me(id2)).toBe(6);

    if (SHOTS) {
      await mockBase(tvCtx, "wireframe");
      await tv.goto("/tv/?quiz=1");
      await expect(tv.getByTestId("quiz-invite")).toBeVisible({ timeout: 15_000 });
      await tv.waitForTimeout(500);
      await tv.screenshot({ path: `${SHOTS}/wireframe-invite.png` });
      await press(tv, "Enter");
      await expect(tv.getByTestId("quiz-title")).toBeVisible({ timeout: 30_000 });
      await tv.waitForTimeout(800);
      await tv.screenshot({ path: `${SHOTS}/wireframe-title.png` });
      await press(tv, "ArrowDown");
      await press(tv, "ArrowRight", 3);
      await press(tv, "Enter");
      await press(tv, "ArrowRight");
      await press(tv, "ArrowDown");
      await press(tv, "Enter");
      await tv.waitForTimeout(400);
      await tv.screenshot({ path: `${SHOTS}/wireframe-question.png` });
      await press(tv, "Escape");
    }
  } finally {
    for (const id of rated) await phoneCtx.request.delete(`/api/v1/profiles/${pid}/ratings/${id}`, { headers }).catch(() => undefined);
    await phoneCtx.close();
    await tvCtx.close();
  }
});
