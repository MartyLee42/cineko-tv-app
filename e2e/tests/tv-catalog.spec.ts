import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

/** Keyboard layout of the TV's on-screen keyboard (EN), 7 keys per row. */
const EN_KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
const KB_COLS = 7;

/** Presses a key and gives the spatial navigation (throttled) time to settle. */
/**
 * Phase 5: keep this run independent of the profile's watch state and
 * settings: no first-run guide, no "Continue watching" row, and playback
 * sessions/progress are not recorded on the real profile.
 */
async function isolateWatch(ctx: BrowserContext) {
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch().catch(() => null);
    const body = res && res.ok() ? await res.json() : {};
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...body, onboarding_completed: true }) });
  });
  const ok = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, (route) => ok(route, { items: [] }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/progress/, (route) => ok(route, { media_id: "x", kind: "movie", movie: null, episodes: [], seasons: [], next_up: null }));
  await ctx.route(/\/api\/v1\/playback\/sessions(\?.*)?$/, (route) =>
    ok(route, { id: "5e550000-0000-4000-8000-00000000ffff", resume_position_seconds: null, progress: null, report_token: "x" }, 201),
  );
  await ctx.route(/\/api\/v1\/playback\/sessions\/[^/]+\/progress/, (route) => ok(route, { accepted: true, progress: null }));
  await ctx.route(/\/api\/v1\/messages(\?.*)?$/, (route) => ok(route, { items: [], unread: 0 }));
}

async function press(tv: Page, key: string, times = 1) {
  for (let i = 0; i < times; i++) {
    await tv.keyboard.press(key);
    await tv.waitForTimeout(160);
  }
}

/** The card (row/grid slot) that currently has focus. */
const focusedCard = (tv: Page) => tv.locator("[data-focus-key]:has(.is-focused) [data-card-id]");

async function focusedCardId(tv: Page) {
  await expect(focusedCard(tv)).toHaveCount(1);
  return (await focusedCard(tv).getAttribute("data-card-id"))!;
}

/** Types on the on-screen keyboard with arrows + OK, starting from "A". */
async function typeOnScreen(tv: Page, text: string) {
  let pos = 0;
  for (const ch of text) {
    const i = EN_KEYS.indexOf(ch);
    const dr = Math.floor(i / KB_COLS) - Math.floor(pos / KB_COLS);
    const dc = (i % KB_COLS) - (pos % KB_COLS);
    await press(tv, dr > 0 ? "ArrowDown" : "ArrowUp", Math.abs(dr));
    await press(tv, dc > 0 ? "ArrowRight" : "ArrowLeft", Math.abs(dc));
    await press(tv, "Enter");
    pos = i;
  }
}

/**
 * Phase 2 TV acceptance: a paired TV shows catalog rows, moves focus with the
 * remote, opens Details for the focused card, restores focus on Back, searches
 * with the on-screen keyboard, and shows the same title as the phone.
 */
test("TV catalog: rows, details, focus restore, search, same title on phone", async ({ browser }) => {
  test.setTimeout(150_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
  await isolateWatch(tvCtx);
  // «Для вас» rows (family, «Подборка»…) vary with live data and would push the catalog rows out of Home's render window.
  await tvCtx.route(/\/api\/v1\/foryou\/rows/, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ profile_id: "p", generated_at: null, stale: false, cold_start: true, rows: [] }) }),
  );
  const phone = await phoneCtx.newPage();
  const tv = await tvCtx.newPage();

  await phone.goto("/login");
  await phone.getByLabel(/username/i).fill(USER);
  await phone.getByLabel(/password/i).fill(PASS);
  await phone.getByRole("button", { name: /sign in/i }).click();
  await expect(phone.getByRole("heading", { name: /welcome/i })).toBeVisible();

  // The TV needs a profile to reach Home.
  const origin = new URL(phone.url()).origin;
  const session = await (await phoneCtx.request.get("/api/v1/auth/session")).json();
  const profiles = await (await phoneCtx.request.get("/api/v1/profiles")).json();
  if (profiles.items.length === 0) {
    const r = await phoneCtx.request.post("/api/v1/profiles", {
      data: { name: "E2E", color: "#6366f1" },
      headers: { "X-CSRF-Token": session.csrf_token, Origin: origin },
    });
    expect(r.ok()).toBeTruthy();
  }

  // Pair the TV.
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Catalog TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  try {
    // Profile picker (no default profile yet): OK picks the focused one.
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");

    // Home: rows with cards, the first card focused.
    await expect(tv.getByText("Trending this week")).toBeVisible({ timeout: 30_000 });
    const first = await focusedCardId(tv);

    // Remote navigation: right moves within the row, down to the next row.
    await press(tv, "ArrowRight");
    const second = await focusedCardId(tv);
    expect(second).not.toBe(first);
    // Rows are compared by their own id (several «Для вас» rows share the "fy-" card key prefix).
    const focusedRow = () => tv.locator("[data-row]:has(.is-focused)").last().getAttribute("data-row");
    const rowBefore = await focusedRow();
    await press(tv, "ArrowDown");
    await press(tv, "ArrowRight");
    const rowAfter = await focusedRow();
    expect(rowAfter).toBeTruthy();
    expect(rowAfter).not.toBe(rowBefore);
    const opened = await focusedCardId(tv);

    // OK opens Details for exactly that title.
    await press(tv, "Enter");
    const details = tv.locator("[data-media-id]");
    await expect(details).toHaveAttribute("data-media-id", opened);
    await expect(tv.locator("[data-media-id] h1")).not.toBeEmpty({ timeout: 20_000 });

    // Back returns to Home with focus on the same card.
    await press(tv, "Escape");
    await expect(details).toHaveCount(0);
    await expect.poll(() => focusedCardId(tv)).toBe(opened);

    // Search via the side menu and the on-screen keyboard.
    for (let i = 0; i < 6 && !(await tv.locator("nav .bg-text").count()); i++) await press(tv, "ArrowLeft");
    await expect(tv.locator("nav").getByText("Home")).toBeVisible();
    // Search sits above Home in the rail.
    await press(tv, "ArrowUp");
    await expect(tv.locator("nav [data-menu=search]")).toHaveAttribute("data-nav-focused", "1");
    await press(tv, "Enter");
    await expect(tv.getByText("Search movies and series")).toBeVisible();
    await typeOnScreen(tv, "MATRIX");
    await expect(tv.getByText("MATRIX", { exact: true })).toBeVisible();
    await expect(tv.locator("[data-card-id]").first()).toBeVisible({ timeout: 20_000 });
    await expect(tv.getByText(/^The Matrix$/).first()).toBeVisible();

    // Into the results (rightmost key column → grid), open the first result.
    await press(tv, "ArrowRight", KB_COLS);
    const result = await focusedCardId(tv);
    await press(tv, "Enter");
    await expect(details).toHaveAttribute("data-media-id", result);
    const tvTitle = tv.locator("[data-media-id] h1");
    await expect(tvTitle).not.toBeEmpty({ timeout: 20_000 });

    // Acceptance: the phone opens the same internal id and shows the same title.
    await phone.goto(`/title/${result}`);
    const phoneTitle = phone.getByRole("heading", { level: 1 });
    await expect(phoneTitle).not.toBeEmpty({ timeout: 20_000 });
    expect((await phoneTitle.textContent())!.trim()).toBe((await tvTitle.textContent())!.trim());
  } finally {
    // Clean up: unpair so reruns start fresh.
    await phone.goto("/devices");
    const card = phone.locator("section", { hasText: deviceName });
    phone.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: /unpair/i }).click();
    await expect(card).toHaveCount(0);
  }
});
