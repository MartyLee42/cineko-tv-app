import { expect, test, type Browser, type Page } from "@playwright/test";

const ADMIN = process.env.E2E_USER ?? "e2e-admin";
const ADMIN_PASS = process.env.E2E_PASS ?? "e2e-password-123";
const X = "e2e-family-x";
const Y = "e2e-family-y";
const PASS = "e2e-family-password-1";
// Optional: directory for review screenshots.
const SHOTS = process.env.FAMILY_SHOTS;

/**
 * «Семья советует» end to end: user X turns on «Share with family» in
 * Settings and rates two titles ★9/★10 → user Y (another account) sees the
 * «Family picks» row on Home with X's avatar and "Natasha ★9", the
 * «Family ratings» line on the title page, and the same row on a paired TV
 * with the avatar chip. Sharing off → the row is gone. Both accounts are
 * disabled again at the end (disabled accounts never share).
 */

async function login(page: Page, user: string, pass: string) {
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(user);
  await page.getByLabel(/password/i).fill(pass);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
}

async function csrf(page: Page) {
  const req = page.context().request;
  const session = await (await req.get("/api/v1/auth/session")).json();
  return { req, session, headers: { "X-CSRF-Token": session.csrf_token as string, Origin: new URL(page.url()).origin } };
}

/** Signs in as user with exactly one named profile (made active). */
async function userPage(browser: Browser, user: string, name: string, color: string, viewport: { width: number; height: number }) {
  const ctx = await browser.newContext({ viewport, locale: "en-US" });
  const page = await ctx.newPage();
  await login(page, user, PASS);
  const { req, session, headers } = await csrf(page);
  let profiles = (await (await req.get("/api/v1/profiles")).json()).items;
  if (!profiles.length) {
    expect((await req.post("/api/v1/profiles", { data: { name, color }, headers })).ok()).toBeTruthy();
    profiles = (await (await req.get("/api/v1/profiles")).json()).items;
  }
  const pid = profiles[0].id as string;
  await req.patch(`/api/v1/profiles/${pid}`, { data: { name, color }, headers });
  // Clean slate: English UI, no onboarding, nothing shared yet.
  await req.put(`/api/v1/profiles/${pid}/settings`, { data: { onboarding_completed: true, share_with_family: false, show_family: true }, headers });
  await page.evaluate(([u, p]) => localStorage.setItem(`martytv.active_profile.${u}`, p), [session.user.id, pid]);
  return { ctx, page, req, headers, pid };
}

test("family sharing: X shares and rates, Y sees «Family picks» on web and TV", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await login(page, ADMIN, ADMIN_PASS);
  const admin = await csrf(page);
  const users = async () => (await (await admin.req.get("/api/v1/admin/users")).json()).items as { id: string; username: string }[];
  for (const username of [X, Y]) {
    const created = await admin.req.post("/api/v1/admin/users", { data: { username, password: PASS, role: "user" }, headers: admin.headers });
    expect([201, 409, 422]).toContain(created.status());
  }
  const ids = Object.fromEntries((await users()).filter((u) => u.username === X || u.username === Y).map((u) => [u.username, u.id]));
  for (const id of Object.values(ids)) await admin.req.patch(`/api/v1/admin/users/${id}`, { data: { disabled: false }, headers: admin.headers });

  // Two real titles from the catalog.
  const home = await (await admin.req.get("/api/v1/catalog/home?lang=en")).json();
  const pool = (home.rows as { items: { id: string; title: string; kind: string }[] }[]).flatMap((r) => r.items).filter((m) => m.kind === "movie");
  const [a, b] = [pool[0]!, pool.find((m) => m.id !== pool[0]!.id)!];
  expect(a && b).toBeTruthy();

  const x = await userPage(browser, X, "Natasha", "#e11d48", { width: 1280, height: 860 });
  const y = await userPage(browser, Y, "Robert", "#0ea5e9", { width: 1280, height: 900 });
  let deviceName: string | null = null;
  try {
    // Y hasn't seen them (leftovers of earlier runs removed).
    for (const m of [a, b]) {
      await y.req.delete(`/api/v1/profiles/${y.pid}/ratings/${m.id}`, { headers: y.headers });
      await y.req.post("/api/v1/foryou/feedback", { data: { profile_id: y.pid, media_id: m.id, action: "undismiss" }, headers: y.headers });
    }
    // Sharing off: no family row for Y.
    const before = await (await y.req.get(`/api/v1/profiles/${y.pid}/family?lang=en`)).json();
    expect(before.items.filter((i: { why: { people: { name: string }[] } }) => i.why.people.some((p) => p.name === "Natasha"))).toHaveLength(0);

    // X: Settings → «Share with family» (off by default) → on.
    await x.page.goto("/settings");
    const shareToggle = x.page.getByTestId("setting-share-family");
    await expect(shareToggle).toHaveAttribute("aria-checked", "false");
    await expect(x.page.getByTestId("setting-show-family")).toHaveAttribute("aria-checked", "true");
    await shareToggle.click();
    await expect(shareToggle).toHaveAttribute("aria-checked", "true");
    await expect(x.page.getByTestId("settings-saved")).toContainText(/saved/i);
    // X rates two titles.
    expect((await x.req.put(`/api/v1/profiles/${x.pid}/ratings/${a.id}`, { data: { rating: 9 }, headers: x.headers })).status()).toBe(204);
    expect((await x.req.put(`/api/v1/profiles/${x.pid}/ratings/${b.id}`, { data: { rating: 10 }, headers: x.headers })).status()).toBe(204);

    // Y: Home → «Family picks» with X's avatar and the why.
    await y.page.goto("/");
    const row = y.page.getByTestId("foryou-row-family");
    await expect(row).toBeVisible({ timeout: 45_000 });
    await expect(row.getByRole("heading", { name: "Family picks" })).toBeVisible();
    const card = row.locator(`[data-media-id="${a.id}"]`);
    await expect(card).toHaveCount(1);
    await expect(row.getByTestId("family-why").filter({ hasText: "Natasha ★9" })).toHaveCount(1);
    await expect(row.getByTestId("family-why").filter({ hasText: "Natasha ★10" })).toHaveCount(1);
    if (SHOTS) {
      await row.scrollIntoViewIfNeeded();
      await y.page.screenshot({ path: `${SHOTS}/home-family.png` });
    }

    // Title page: «Family ratings».
    await y.page.goto(`/title/${a.id}`);
    await expect(y.page.getByTestId("title-family")).toContainText("Natasha ★9", { timeout: 20_000 });

    // TV for Y: the same row with the avatar chip.
    const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: "en-US" });
    const tv = await tvCtx.newPage();
    await tv.goto("/tv/");
    const codeEl = tv.locator("p.font-mono");
    await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const code = (await codeEl.textContent())!.trim();
    deviceName = `E2E Family TV ${Date.now()}`;
    await y.page.goto(`/pair?code=${code}`);
    await y.page.getByLabel(/tv name/i).fill(deviceName);
    await y.page.getByRole("button", { name: /connect tv/i }).click();
    await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await tv.keyboard.press("Enter");
    const tvRow = tv.locator('[data-row="fy-family"]');
    await expect(tvRow).toBeVisible({ timeout: 45_000 });
    await expect(tvRow).toContainText("Family picks");
    await expect(tvRow.locator('[data-family-from="Natasha"]').first()).toBeVisible();
    if (SHOTS) await tv.screenshot({ path: `${SHOTS}/tv-family.png` });
    await tvCtx.close();

    // X stops sharing → gone for Y.
    await x.page.goto("/settings");
    await x.page.getByTestId("setting-share-family").click();
    await expect(x.page.getByTestId("setting-share-family")).toHaveAttribute("aria-checked", "false");
    const after = await (await y.req.get(`/api/v1/profiles/${y.pid}/family?lang=en`)).json();
    expect(after.members.some((m: { name: string }) => m.name === "Natasha")).toBe(false);
  } finally {
    await x.req.put(`/api/v1/profiles/${x.pid}/settings`, { data: { share_with_family: false }, headers: x.headers });
    for (const m of [a, b]) await x.req.delete(`/api/v1/profiles/${x.pid}/ratings/${m.id}`, { headers: x.headers });
    if (deviceName) {
      await y.page.goto("/devices");
      const dev = y.page.locator("section", { hasText: deviceName });
      if (await dev.count()) {
        y.page.once("dialog", (d) => d.accept());
        await dev.getByRole("button", { name: /unpair/i }).click();
        await expect(dev).toHaveCount(0);
      }
    }
    await x.ctx.close();
    await y.ctx.close();
    for (const id of Object.values(ids)) await admin.req.patch(`/api/v1/admin/users/${id}`, { data: { disabled: true }, headers: admin.headers });
  }
});
