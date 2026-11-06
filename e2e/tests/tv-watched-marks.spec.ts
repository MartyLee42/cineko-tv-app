import { expect, test } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

// TV posters mark watched (✓) and favourite (♥) titles like the web, top-left
// (the rating owns the top-right), so the rating never covers them.
test("TV: watched ✓ and favourite ♥ on poster cards", async ({ browser }) => {
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
  const pid = (await (await phoneCtx.request.get("/api/v1/profiles")).json()).items[0].id as string;
  const home = await (await phoneCtx.request.get(`/api/v1/catalog/home?lang=en&profile_id=${pid}`)).json();
  const item = home.rows.find((r: { key: string }) => r.key === "trending").items[0] as { id: string; me?: { completed: boolean; favorite: boolean } };
  const was = { completed: !!item.me?.completed, favorite: !!item.me?.favorite };
  expect((await phoneCtx.request.put(`/api/v1/media/${item.id}/watched?lang=en`, { headers, data: { profile_id: pid, watched: true } })).ok()).toBeTruthy();
  expect((await phoneCtx.request.put(`/api/v1/profiles/${pid}/lists/favorites/${item.id}`, { headers })).ok()).toBeTruthy();

  // «Для вас» rows (family, «Подборка»…) vary with live data and would push «trending» out of Home's render window.
  await tvCtx.route(/\/api\/v1\/foryou\/rows/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ profile_id: "p", generated_at: null, stale: false, cold_start: true, rows: [] }) }),
  );
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const name = `E2E Marks TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(name);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });
  try {
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await tv.keyboard.press("Enter");
    const card = tv.locator(`[data-card-id="${item.id}"]`).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    const check = card.locator("[data-watched]");
    await expect(check).toBeVisible();
    await expect(card.locator("[data-favorite]")).toBeVisible();
    // Not under the rating badge: the marks sit on the left half of the card.
    const c = (await card.boundingBox())!;
    const b = (await check.boundingBox())!;
    expect(b.x + b.width / 2).toBeLessThan(c.x + c.width / 2);
  } finally {
    if (!was.completed) await phoneCtx.request.put(`/api/v1/media/${item.id}/watched?lang=en`, { headers, data: { profile_id: pid, watched: false } });
    if (!was.favorite) await phoneCtx.request.delete(`/api/v1/profiles/${pid}/lists/favorites/${item.id}`, { headers });
    const devs = await (await phoneCtx.request.get("/api/v1/devices")).json();
    const dev = devs.items.find((d: { name: string }) => d.name === name);
    if (dev) await phoneCtx.request.delete(`/api/v1/devices/${dev.id}`, { headers });
    await phoneCtx.close();
    await tvCtx.close();
  }
});
