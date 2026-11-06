import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { quietHome } from "./quietHome";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

interface Ack {
  id: string;
  ok: boolean;
  error?: string;
  result?: Record<string, unknown>;
}

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

const focusedCard = (tv: Page) => tv.locator("[data-focus-key]:has(.is-focused) [data-card-id]");

async function focusedCardId(tv: Page) {
  await expect(focusedCard(tv)).toHaveCount(1);
  return (await focusedCard(tv).getAttribute("data-card-id"))!;
}

/** Sends a command from the phone (cookie session + CSRF), like the PWA does. */
async function sendCommand(phone: Page, deviceId: string, body: { id?: string; type: string; payload?: unknown }): Promise<Ack> {
  return phone.evaluate(
    async ({ deviceId, body }) => {
      const session = await (await fetch("/api/v1/auth/session")).json();
      const r = await fetch(`/api/v1/devices/${deviceId}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrf_token },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`commands: HTTP ${r.status} ${await r.text()}`);
      return r.json();
    },
    { deviceId, body },
  );
}

async function firstResult(phone: Page, q: string, kind: "movie" | "series"): Promise<string> {
  const r = await phone.request.get(`/api/v1/catalog/search?q=${encodeURIComponent(q)}&kind=${kind}&lang=en`);
  expect(r.ok()).toBeTruthy();
  const page = await r.json();
  expect(page.items.length).toBeGreaterThan(0);
  return page.items[0].id as string;
}

/**
 * Phase 3 TV acceptance: a phone sends media.open to a paired TV, which opens
 * that title's Details without reloading, acks with its new state, shows who
 * opened it, returns to the previous screen on Back, preselects a series'
 * season, and queues a title sent while the profile picker is showing.
 */
test("TV executes commands sent from the phone", async ({ browser }) => {
  test.setTimeout(150_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
  await quietHome(tvCtx);
  await isolateWatch(tvCtx);
  const phone = await phoneCtx.newPage();
  const tv = await tvCtx.newPage();

  await phone.goto("/login");
  await phone.getByLabel(/username/i).fill(USER);
  await phone.getByLabel(/password/i).fill(PASS);
  await phone.getByRole("button", { name: /sign in/i }).click();
  await expect(phone.getByRole("heading", { name: /welcome/i })).toBeVisible();

  // The TV needs a profile to show the catalog.
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

  const movieId = await firstResult(phone, "The Matrix", "movie");
  const seriesId = await firstResult(phone, "Breaking Bad", "series");

  // Pair the TV.
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Remote TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  try {
    const devices = await (await phoneCtx.request.get("/api/v1/devices")).json();
    const device = devices.items.find((d: { name: string }) => d.name === deviceName);
    expect(device).toBeTruthy();
    const deviceId = device.id as string;

    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");
    await expect(tv.getByText("Trending this week")).toBeVisible({ timeout: 30_000 });
    await press(tv, "ArrowRight");
    const before = await focusedCardId(tv);

    // No reload may happen: this marker would be lost.
    await tv.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
    const details = tv.locator("[data-media-id]");

    // --- media.open a movie from Home.
    const openId = `e2e-open-${Date.now()}`;
    const ack = await sendCommand(phone, deviceId, { id: openId, type: "media.open", payload: { media_id: movieId } });
    expect(ack.ok, JSON.stringify(ack)).toBe(true);
    expect(ack.result).toMatchObject({ screen: "details", media_id: movieId, playback: null });
    await expect(details).toHaveAttribute("data-media-id", movieId);
    await expect(tv.locator("[data-media-id] h1")).not.toBeEmpty({ timeout: 20_000 });
    await expect(tv.getByTestId("tv-toast")).toContainText(/opened by/i);
    // Focus lands on the main action.
    await expect(tv.locator("[data-media-id] .is-focused")).toContainText(/play/i);
    expect(await tv.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);

    // The reported state matches (title known once Details has loaded).
    const title = (await tv.locator("[data-media-id] h1").textContent())!.trim();
    await expect
      .poll(async () => (await sendCommand(phone, deviceId, { type: "device.request_state" })).result)
      .toMatchObject({ screen: "details", media_id: movieId, kind: "movie", title });
    await expect
      .poll(async () => (await (await phoneCtx.request.get(`/api/v1/devices/${deviceId}/state`)).json()).state)
      .toMatchObject({ screen: "details", media_id: movieId, title });

    // Back returns to Home, on the same card.
    await press(tv, "Escape");
    await expect(details).toHaveCount(0);
    await expect.poll(() => focusedCardId(tv)).toBe(before);

    // A retry of the same command id is not executed again.
    const again = await sendCommand(phone, deviceId, { id: openId, type: "media.open", payload: { media_id: movieId } });
    expect(again.ok).toBe(true);
    await tv.waitForTimeout(800);
    await expect(details).toHaveCount(0);

    // --- A series with season 2 preselected.
    const sAck = await sendCommand(phone, deviceId, { type: "media.open", payload: { media_id: seriesId, season_number: 2 } });
    expect(sAck.ok, JSON.stringify(sAck)).toBe(true);
    await expect(details).toHaveAttribute("data-media-id", seriesId);
    const season2 = tv.locator("[data-media-id] .tv-chip", { hasText: /^Season 2$/ });
    await expect(season2).toHaveClass(/bg-accent/, { timeout: 20_000 });
    await expect
      .poll(async () => (await sendCommand(phone, deviceId, { type: "device.request_state" })).result)
      .toMatchObject({ screen: "details", media_id: seriesId, kind: "series", season_number: 2 });

    // Playback commands are covered by tv-player.spec.ts (with a mocked stream,
    // so no torrent is added to the real TorrServer).

    await press(tv, "Escape");
    await expect(details).toHaveCount(0);

    // --- Sent while the profile picker is showing: queued, opened after picking.
    await tv.locator("nav [role=button]").last().click();
    await expect(picker).toBeVisible();
    const qAck = await sendCommand(phone, deviceId, { type: "media.open", payload: { media_id: movieId } });
    expect(qAck).toMatchObject({ ok: true, result: { queued: true } });
    await expect(details).toHaveCount(0);
    await expect(tv.getByTestId("tv-toast")).toContainText(/choose a profile/i);
    await press(tv, "Enter");
    await expect(details).toHaveAttribute("data-media-id", movieId);
    await press(tv, "Escape");
    await expect(details).toHaveCount(0);
    await expect(tv.getByText("Trending this week")).toBeVisible();
  } finally {
    await phone.goto("/devices");
    const card = phone.locator("section", { hasText: deviceName });
    phone.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: /unpair/i }).click();
    await expect(card).toHaveCount(0);
  }
});
