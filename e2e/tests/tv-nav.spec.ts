import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

type Design = "kinozal" | "terminal" | "projector" | "wireframe" | "cyberpunk" | "deco" | "retro80" | "retro90" | "popart" | "constructivism";
/** Designs on the Кинозал rail skeleton (menu on the left). */
const rail = (d: Design) => d === "kinozal" || d === "deco" || d === "retro80";
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function press(tv: Page, key: string, times = 1) {
  for (let i = 0; i < times; i++) {
    await tv.keyboard.press(key);
    await tv.waitForTimeout(170);
  }
}

async function mockBackend(ctx: BrowserContext, design: Design) {
  await ctx.unrouteAll({ behavior: "ignoreErrors" });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
    if (route.request().method() !== "GET") return json(route, {});
    const res = await route.fetch().catch(() => null);
    const body = res && res.ok() ? await res.json() : {};
    return json(route, { ...body, design, theme: "dark", onboarding_completed: true });
  });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, (route) => json(route, { items: [] }));
  await ctx.route(/\/api\/v1\/recommendations\/inbox/, (route) => json(route, { items: [], unseen: 0 }));
  await ctx.route(/\/api\/v1\/messages(\?.*)?$/, (route) => json(route, { items: [], unread: 0 }));
  // No «Для вас» rows: Home starts on its catalog rows (trending).
  await ctx.route(/\/api\/v1\/foryou\/rows/, (route) => json(route, { profile_id: "p", generated_at: null, stale: false, cold_start: true, rows: [] }));
}

const SCREENS: { id: string; ready: (tv: Page) => ReturnType<Page["locator"]> }[] = [
  { id: "movies", ready: (tv) => tv.locator("[data-focus-key^=b-] [data-card-id]").first() },
  { id: "series", ready: (tv) => tv.locator("[data-focus-key^=b-] [data-card-id]").first() },
  { id: "search", ready: (tv) => tv.getByText("Search movies and series") },
  { id: "explore", ready: (tv) => tv.getByTestId("explore") },
  { id: "surprise", ready: (tv) => tv.getByTestId("surprise") },
  { id: "ask", ready: (tv) => tv.getByTestId("ask") },
  { id: "history", ready: (tv) => tv.getByTestId("history") },
  { id: "mine", ready: (tv) => tv.getByTestId("mine") },
  { id: "messages", ready: (tv) => tv.getByTestId("messages") },
];

const homeVisible = (tv: Page) => expect(tv.locator("[data-row=trending]")).toBeVisible({ timeout: 20_000 });

/** Moves focus from the content into the menu / tab bar. */
async function intoMenu(tv: Page, design: Design) {

  const key = rail(design) ? "ArrowLeft" : "ArrowUp";
  const inMenu = () => tv.locator('nav [data-nav-focused="1"]').count();
  // A screen may park focus on its menu item itself (nothing to focus); give it a moment.
  await expect.poll(async () => (await inMenu()) + (await tv.locator(".is-focused").count())).toBeGreaterThan(0);
  for (let i = 0; i < 12 && !(await inMenu()); i++) await press(tv, key);
  await expect(tv.locator('nav [data-nav-focused="1"]'), `${design}: focus reaches the menu`).toHaveCount(1);
}

/** Within the menu: steps to `id` and presses OK. */
async function pick(tv: Page, design: Design, id: string) {
  const order = await tv.locator("nav [data-menu]").evaluateAll((els) => els.map((e) => e.getAttribute("data-menu")));
  // Walk until the target is focused (the menu grows with new tabs); the cap only stops a stuck walk.
  for (let i = 0; i < order.length * 2 + 10; i++) {
    const cur = await tv.locator('nav [data-nav-focused="1"]').getAttribute("data-menu");
    if (cur === id) break;
    const forward = order.indexOf(id) > order.indexOf(cur);
    await press(tv, rail(design) ? (forward ? "ArrowDown" : "ArrowUp") : forward ? "ArrowRight" : "ArrowLeft");
  }
  await expect(tv.locator(`nav [data-menu="${id}"]`)).toHaveAttribute("data-nav-focused", "1");
  await press(tv, "Enter");
}

/**
 * Every design: each top-level screen is reachable from the menu / tab bar,
 * and Home comes back both via the menu («Главная») and via Back. Settings
 * opens from the menu and Back closes it.
 */
test("TV navigation: top-level screens and back to Home in every design (all eight)", async ({ browser }) => {
  test.setTimeout(900_000); // 6 designs × 9 screens; the menus grew with «Видео»
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
  const profiles = await (await phoneCtx.request.get("/api/v1/profiles")).json();
  if (profiles.items.length === 0) {
    expect((await phoneCtx.request.post("/api/v1/profiles", { data: { name: "E2E", color: "#6366f1" }, headers: { "X-CSRF-Token": session.csrf_token, Origin: origin } })).ok()).toBeTruthy();
  }

  await mockBackend(tvCtx, "kinozal");
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Nav TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  try {
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");

    for (const design of ["kinozal", "terminal", "projector", "wireframe", "cyberpunk", "deco", "retro80", "retro90", "popart", "constructivism"] as Design[]) {
      await mockBackend(tvCtx, design);
      await tv.reload();
      await expect(tv.locator(`[data-design-skin="${design}"]`)).toBeVisible({ timeout: 30_000 });
      await homeVisible(tv);

      for (const s of SCREENS) {
        // Menu → the screen; content → menu → «Home».
        await intoMenu(tv, design);
        await pick(tv, design, s.id);
        await expect(s.ready(tv), `${design}: ${s.id} opens`).toBeVisible({ timeout: 20_000 });
        await tv.waitForTimeout(400);
        await intoMenu(tv, design);
        await pick(tv, design, "home");
        await homeVisible(tv);
        // Menu → the screen; Back → Home.
        await intoMenu(tv, design);
        await pick(tv, design, s.id);
        await expect(s.ready(tv)).toBeVisible({ timeout: 20_000 });
        await tv.waitForTimeout(400);
        // Back from the content first jumps to the menu, a second Back goes Home.
        await press(tv, "Escape");
        await expect(tv.locator('nav [data-nav-focused="1"]')).toHaveCount(1);
        await press(tv, "Escape");
        await homeVisible(tv);
      }

      // Fast way up. Home: 5 rows down → Back → the menu, page back at the top (the first row on screen).
      const focusKey = () => tv.evaluate(() => (window as unknown as { __focusKey: () => string }).__focusKey());
      await intoMenu(tv, design);
      await pick(tv, design, "home");
      await expect.poll(focusKey).toMatch(/^(row-|hero-)/);
      if ((await focusKey()).startsWith("hero-")) await press(tv, "ArrowDown");
      await press(tv, "ArrowDown", 5);
      await expect.poll(focusKey).not.toMatch(/^row-trending-/);
      await press(tv, "Escape");
      await expect.poll(focusKey).toBe("menu-home");
      await tv.waitForTimeout(700);
      const firstRow = (await tv.locator("[data-row=trending]").boundingBox())!;
      expect(firstRow.y, `${design}: first row back on screen`).toBeGreaterThan(0);
      await expect(tv.locator('nav [data-nav-focused="1"]')).toHaveCount(1);
      // Browse: 5 grid rows down → Back → the menu, page at the top; Channel▲ (PageUp) does the same.
      await pick(tv, design, "movies");
      await expect(tv.locator("[data-focus-key^=b-] [data-card-id]").first()).toBeVisible({ timeout: 20_000 });
      await expect.poll(focusKey).toMatch(/^b-/);
      for (const key of ["Escape", "PageUp"]) {
        if (!(await focusKey()).startsWith("b-")) {
          // From the menu back into the grid.
          await press(tv, rail(design) ? "ArrowRight" : "ArrowDown", 3);
        }
        await expect.poll(focusKey).toMatch(/^b-/);
        await press(tv, "ArrowDown", 5);
        await press(tv, key);
        await expect(tv.locator('nav [data-nav-focused="1"]'), `${design}: ${key} → menu`).toHaveCount(1);
        await tv.waitForTimeout(400);
        const title = (await tv.locator("[data-design-shell] h1").first().boundingBox())!;
        expect(title.y, `${design}: ${key} → page at the top`).toBeGreaterThan(0);
      }
      await press(tv, "Escape");
      await homeVisible(tv);

      // Settings: opens from the menu, Back closes it; Home is still there.
      await intoMenu(tv, design);
      await pick(tv, design, "settings");
      await expect(tv.getByTestId("tv-settings")).toBeVisible();
      await press(tv, "Escape");
      await expect(tv.getByTestId("tv-settings")).toHaveCount(0);
      await homeVisible(tv);

      // «Home» on Home itself puts focus back into the rows; Details → Back → Home.
      await intoMenu(tv, design);
      await pick(tv, design, "home");
      await expect.poll(() => tv.evaluate(() => (window as unknown as { __focusKey: () => string }).__focusKey())).toMatch(/^(row-|hero-)/);
      await press(tv, "Enter");
      await expect(tv.locator("[data-media-id] h1")).not.toBeEmpty({ timeout: 20_000 });
      await press(tv, "Escape");
      await homeVisible(tv);
    }
  } finally {
    await phone.goto("/devices");
    const card = phone.locator("section", { hasText: deviceName });
    phone.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: /unpair/i }).click();
    await expect(card).toHaveCount(0);
  }
});

/**
 * The menu-skip reporter (remote/navTrace.ts) on a tab bar: Right then OK
 * quickly is not a "skip" (it was reported before), while a duplicate arrow
 * Right 30 ms later is absorbed by the focus engine's throttle, and one 100 ms
 * later (too fast for a person) is reported as a duplicate, with the presses
 * readable (the server blanks fields named like "keys") and how long focus took.
 */
test("TV menu-skip reporter: no false alarms, duplicates reported", async ({ browser }) => {
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
  const skips = () => tv.evaluate(() => ((window as unknown as { __martytvNavSkips?: Record<string, unknown>[] }).__martytvNavSkips ?? []));
  await mockBackend(tvCtx, "projector");
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Skip TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });
  try {
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");
    await homeVisible(tv);
    await intoMenu(tv, "projector");
    // Walk to «Home» first.
    const order = await tv.locator("nav [data-menu]").evaluateAll((els) => els.map((e) => e.getAttribute("data-menu")));
    for (let i = 0; i < 20 && (await tv.locator('nav [data-nav-focused="1"]').getAttribute("data-menu")) !== "home"; i++) await press(tv, "ArrowLeft");
    const at = (id: string | null) => order.indexOf(id);

    // Right, then OK at once: lands in a screen's content — not a skip.
    await tv.keyboard.press("ArrowRight");
    await tv.keyboard.press("Enter");
    await tv.waitForTimeout(800);
    expect(await skips(), "Right + OK is not reported").toHaveLength(0);

    // Back to the bar. A duplicate Right 30 ms apart is absorbed by the focus
    // engine's 80 ms throttle: one tab, no report.
    await intoMenu(tv, "projector");
    const doubleRight = (gap: number) =>
      tv.evaluate((g) => {
        const fire = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", keyCode: 39, bubbles: true } as KeyboardEventInit));
        fire();
        setTimeout(fire, g);
      }, gap);
    const start = await tv.locator('nav [data-nav-focused="1"]').getAttribute("data-menu");
    await doubleRight(30);
    await tv.waitForTimeout(800);
    expect(at(await tv.locator('nav [data-nav-focused="1"]').getAttribute("data-menu"))).toBe(at(start) + 1);
    expect(await skips(), "a 30 ms duplicate is absorbed").toHaveLength(0);
    // 100 ms apart (past the throttle, still too fast for a person): two tabs → reported as a duplicate.
    const before = await tv.locator('nav [data-nav-focused="1"]').getAttribute("data-menu");
    await doubleRight(100);
    await expect.poll(async () => (await skips()).length).toBe(1);
    const extra = (await skips())[0]!;
    expect(extra.duplicate_event).toBe(true);
    expect(String(extra.presses)).toContain("ArrowRight/39");
    expect(String(extra.presses)).not.toContain("[redacted]");
    expect(typeof extra.moved_after_ms === "number" || extra.moved_after_ms === null).toBe(true);
    expect(at(String(extra.from).replace("menu-", ""))).toBe(at(before));
  } finally {
    const s = await (await phoneCtx.request.get("/api/v1/auth/session")).json();
    const devs = await (await phoneCtx.request.get("/api/v1/devices")).json();
    const dev = devs.items.find((d: { name: string }) => d.name === deviceName);
    if (dev) await phoneCtx.request.delete(`/api/v1/devices/${dev.id}`, { headers: { "X-CSRF-Token": s.csrf_token, Origin: new URL(phone.url()).origin } });
    await phoneCtx.close();
    await tvCtx.close();
  }
});
