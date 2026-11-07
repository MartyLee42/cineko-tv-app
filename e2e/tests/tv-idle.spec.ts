import { expect, test, type BrowserContext, type Route } from "@playwright/test";
import { quietHome } from "./quietHome";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

async function settled(ctx: BrowserContext) {
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
    if (route.request().method() !== "GET") return json(route, {});
    const res = await route.fetch().catch(() => null);
    const body = res && res.ok() ? await res.json() : {};
    return json(route, { ...body, design: "kinozal", theme: "dark", onboarding_completed: true, seasonal_effects: "off" });
  });
  await quietHome(ctx);
}

/**
 * «Заставка» → DVD: after 10 idle minutes on Home the still logo bounces
 * edge to edge (touching each wall) at one fixed 45° angle; a key wakes it.
 */
test("TV screensaver: the DVD logo reaches every edge at a fixed angle", async ({ browser }) => {
  test.setTimeout(180_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: "en-US" });
  const phone = await phoneCtx.newPage();
  const tv = await tvCtx.newPage();
  try {
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

    await settled(tvCtx);
    await tv.goto("/tv/");
    const codeEl = tv.locator("p.font-mono");
    await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const code = (await codeEl.textContent())!.trim();
    await phone.goto(`/pair?code=${code}`);
    await phone.getByLabel(/tv name/i).fill(`E2E Idle TV ${Date.now()}`);
    await phone.getByRole("button", { name: /connect tv/i }).click();
    await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await tv.keyboard.press("Enter");

    // This TV picked the DVD screensaver; a controllable clock from the start.
    await tv.evaluate(() => localStorage.setItem("martytv.screensaver", "dvd"));
    await tv.clock.install();
    await tv.reload();
    await expect(tv.locator("nav [data-menu]").first()).toBeVisible({ timeout: 30_000 });

    await tv.clock.fastForward("10:30");
    const saver = tv.getByTestId("screensaver");
    await expect(saver).toBeVisible();
    await expect(saver).toHaveAttribute("data-saver", "dvd");
    const logo = tv.getByTestId("dvd-logo");
    // A still picture: nothing animates inside it.
    expect(await logo.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);

    // ~40 s of bouncing: the box touches all four walls; between bounces it
    // moves as far across as down (one angle, never changing).
    let minX = 1e9, minY = 1e9, maxR = 0, maxB = 0;
    let prev = await logo.boundingBox();
    for (let i = 0; i < 400; i++) {
      await tv.clock.runFor(100);
      const b = (await logo.boundingBox())!;
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxR = Math.max(maxR, b.x + b.width);
      maxB = Math.max(maxB, b.y + b.height);
      const dx = Math.abs(b.x - prev!.x);
      const dy = Math.abs(b.y - prev!.y);
      // A bounce inside the 100 ms step mixes two directions: skip steps near a wall (one step's travel).
      const near = (r: { x: number; y: number; width: number; height: number }) => r.x <= 20 || r.y <= 20 || r.x + r.width >= 1900 || r.y + r.height >= 1060;
      const wall = near(b) || near(prev!);
      if (!wall && dx + dy > 0) expect(Math.abs(dx - dy), `step ${i}: dx ${dx} dy ${dy}`).toBeLessThanOrEqual(2);
      prev = b;
    }
    // Sampled every 100 ms (≤ 15 px of travel): the box reaches each wall.
    expect(minX).toBeLessThanOrEqual(15);
    expect(minY).toBeLessThanOrEqual(15);
    expect(maxR).toBeGreaterThanOrEqual(1905);
    expect(maxB).toBeGreaterThanOrEqual(1065);
    // …and what's drawn fills the box (the old logo sat small in the middle of it).
    const ink = await logo.evaluate((el) => {
      const svg = el.querySelector("svg")!;
      const box = svg.getBoundingClientRect();
      const ink = (svg as SVGGraphicsElement).getBBox();
      return { w: ink.width / 400, h: ink.height / 180, boxW: box.width, boxH: box.height };
    });
    expect(ink.w, "ink width share").toBeGreaterThan(0.97);
    expect(ink.h, "ink height share").toBeGreaterThan(0.9);
    await tv.screenshot({ path: "test-results/tv-idle-dvd.png" });

    // A key wakes it (and goes no further).
    await tv.keyboard.press("ArrowDown");
    await expect(saver).toHaveCount(0);
  } finally {
    await phoneCtx.close();
    await tvCtx.close();
  }
});
