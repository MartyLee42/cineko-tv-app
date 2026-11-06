import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
const CLIP = readFileSync(new URL("../fixtures/clip.webm", import.meta.url));

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** Hermetic Home with the given seasonal_effects (and the admin switch on/off). */
async function mockBackend(ctx: BrowserContext, seasonal: "on" | "calm" | "off", admin = true) {
  await ctx.unrouteAll({ behavior: "ignoreErrors" });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
    if (route.request().method() !== "GET") return json(route, {});
    const res = await route.fetch().catch(() => null);
    const body = res && res.ok() ? await res.json() : {};
    return json(route, { ...body, design: "kinozal", theme: "dark", onboarding_completed: true, seasonal_effects: seasonal });
  });
  await ctx.route(/\/api\/v1\/status$/, async (route) => {
    const res = await route.fetch().catch(() => null);
    const body = res && res.ok() ? await res.json() : {};
    return json(route, { ...body, seasonal_effects: admin });
  });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, (route) => json(route, { items: [] }));
  await ctx.route(/\/api\/v1\/recommendations\/inbox/, (route) => json(route, { items: [], unseen: 0 }));
  // «Для вас» rows sit above Trending when other specs left recommendations for this profile.
  await ctx.route(/\/api\/v1\/foryou\/rows/, (route) => json(route, { rows: [], cold_start: false }));
  await ctx.route(/\/api\/v1\/messages(\?.*)?$/, (route) => json(route, { items: [], unread: 0 }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/progress/, (route) => json(route, { media_id: "x", kind: "movie", movie: null, episodes: [], seasons: [], next_up: null }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/(releases|online)/, (route) => json(route, { items: [], providers: [], searched_at: new Date().toISOString(), cached: true, indexer_errors: [] }));
  await ctx.route(/\/__season-clip\.webm$/, (route) => route.fulfill({ status: 200, headers: { "Content-Type": "video/webm" }, body: CLIP }));
}

// The layer only (Details' season chips also carry data-season).
const layer = (tv: Page) => tv.locator("[data-season][data-season-mode]");
const homeVisible = (tv: Page) => expect(tv.locator("[data-row=trending]")).toBeVisible({ timeout: 30_000 });
/** Running CSS animations inside the season layer. */
const runningAnimations = (tv: Page) =>
  tv.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && (a.effect as KeyframeEffect | null)?.target instanceof Element && !!((a.effect as KeyframeEffect).target as Element).closest(".mt-ss")).length);

/**
 * Holiday animations on the TV: ?season= forces a season on Home (≤ 18
 * particles, transform/opacity only, under the menu); none on Details or
 * while a video plays; calm (profile setting or this TV's calm motion)
 * draws still decorations; off and the admin switch hide it.
 */
test("TV seasons: Home layer, hidden on Details and during playback, calm is static, off hides", async ({ browser }) => {
  test.setTimeout(240_000);
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

  await mockBackend(tvCtx, "on");
  await tv.goto("/tv/?season=newyear");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  await phone.getByLabel(/tv name/i).fill(`E2E Seasons TV ${Date.now()}`);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  try {
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await tv.keyboard.press("Enter");
    await homeVisible(tv);

    // --- Home: the layer, its garland, the mascot's hat and the greeting; pointer-events off; under the menu.
    await expect(layer(tv)).toHaveAttribute("data-season", "newyear");
    await expect(layer(tv)).toHaveAttribute("data-season-mode", "full");
    const particles = await tv.locator(".mt-ss-p").count();
    expect(particles).toBeGreaterThan(0);
    expect(particles + (await tv.locator(".mt-ss-star").count())).toBeLessThanOrEqual(18);
    await expect(tv.locator(".mt-ss-garland")).toHaveCount(1);
    await expect(tv.locator("nav [data-hat=santa]")).toHaveCount(1);
    await expect(tv.getByTestId("season-greeting")).toContainText("Happy New Year!");
    expect(await layer(tv).evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
    // Only transform / opacity are animated.
    const props = await tv.evaluate(() =>
      [
        ...new Set(
          document
            .getAnimations()
            .filter((a) => ((a.effect as KeyframeEffect | null)?.target as Element | null)?.closest?.(".mt-ss"))
            .flatMap((a) => (a.effect as KeyframeEffect).getKeyframes().flatMap((k) => Object.keys(k))),
        ),
      ].filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k)),
    );
    for (const p of props) expect(["transform", "opacity"], `animated property ${p}`).toContain(p);
    // The greeting goes on a key press and is not shown again on this device.
    await tv.keyboard.press("ArrowDown");
    await expect(tv.getByTestId("season-greeting")).toHaveCount(0);

    // --- Details: no layer; Back: it returns.
    const fk = () => tv.evaluate(() => (window as unknown as { __focusKey: () => string }).__focusKey());
    await expect.poll(fk).toMatch(/^row-popular/);
    await tv.waitForTimeout(600); // the row scroll settles before the next key
    await tv.keyboard.press("ArrowUp");
    await expect.poll(fk).toMatch(/^row-trending-/);
    await tv.waitForTimeout(600);
    await tv.keyboard.press("Enter");
    await expect(tv.locator("[data-media-id] h1")).not.toBeEmpty({ timeout: 20_000 });
    await expect(layer(tv)).toHaveCount(0);
    await tv.keyboard.press("Escape");
    await homeVisible(tv);
    await expect(layer(tv)).toHaveCount(1);

    // --- A playing video hides it (the player replaces the catalog anyway); paused, it's back.
    await tv.evaluate(async () => {
      const v = document.createElement("video");
      v.id = "season-test-video";
      v.muted = true;
      v.src = "/__season-clip.webm";
      v.style.cssText = "position:fixed;left:0;top:0;width:64px;height:36px";
      document.body.appendChild(v);
      await v.play();
    });
    await expect(layer(tv)).toHaveCount(0);
    await tv.evaluate(() => (document.getElementById("season-test-video") as HTMLVideoElement).pause());
    await expect(layer(tv)).toHaveCount(1);
    await tv.evaluate(() => document.getElementById("season-test-video")!.remove());

    // --- Calm (profile setting): still decorations, nothing animates.
    await mockBackend(tvCtx, "calm");
    await tv.reload();
    await homeVisible(tv);
    await expect(layer(tv)).toHaveAttribute("data-season-mode", "static");
    await expect(tv.locator(".mt-ss-p")).toHaveCount(0);
    await expect(tv.locator(".mt-ss-dot").first()).toBeVisible();
    expect(await runningAnimations(tv)).toBe(0);
    await expect(tv.getByTestId("season-greeting")).toHaveCount(0); // once per season per device

    // --- This TV's calm motion (device-local) also makes it still.
    await mockBackend(tvCtx, "on");
    await tv.evaluate(() => localStorage.setItem("martytv.calm_motion", "1"));
    await tv.reload();
    await homeVisible(tv);
    await expect(layer(tv)).toHaveAttribute("data-season-mode", "static");
    expect(await runningAnimations(tv)).toBe(0);
    await tv.evaluate(() => localStorage.removeItem("martytv.calm_motion"));

    // --- 9 May: ribbon + still badge, no particles.
    await tv.goto("/tv/?season=victory");
    await homeVisible(tv);
    await expect(layer(tv)).toHaveAttribute("data-season-mode", "static");
    await expect(tv.getByTestId("season-victory-badge")).toBeVisible();
    await expect(tv.locator(".mt-ss-ribbon")).toHaveCount(1);
    await expect(tv.locator(".mt-ss-p, .mt-ss-dot")).toHaveCount(0);

    // --- Off, the admin switch, and ?season=off hide it.
    await mockBackend(tvCtx, "off");
    await tv.goto("/tv/?season=newyear");
    await homeVisible(tv);
    await expect(layer(tv)).toHaveCount(0);
    await mockBackend(tvCtx, "on", false);
    await tv.reload();
    await homeVisible(tv);
    await expect(layer(tv)).toHaveCount(0);
    await mockBackend(tvCtx, "on");
    await tv.goto("/tv/?season=off");
    await homeVisible(tv);
    await expect(layer(tv)).toHaveCount(0);
  } finally {
    // Unpair this TV (keep the account's device list tidy).
    await tvCtx.unrouteAll({ behavior: "ignoreErrors" });
    const devices = await (await phoneCtx.request.get("/api/v1/devices")).json();
    for (const d of devices.items.filter((x: { name: string }) => x.name.startsWith("E2E Seasons TV"))) {
      await phoneCtx.request.delete(`/api/v1/devices/${d.id}`, { headers: { "X-CSRF-Token": session.csrf_token, Origin: origin } });
    }
  }
});
