import { expect, test } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

// Scrolled to the far right of a Home row, the cards to the left of the focus
// stay drawn (the row used to render only 4 before the focus: 5 cards on screen).
test("TV: the end of a row keeps the screen full of cards", async ({ browser }) => {
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
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const name = `E2E RowEnd TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(name);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });
  try {
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await tv.keyboard.press("Enter");
    const row = tv.locator("[data-row=trending]");
    await expect(row).toBeVisible({ timeout: 30_000 });
    // Into the trending row, then all the way right.
    for (let i = 0; i < 8 && !(await row.locator(".is-focused").count()); i++) {
      await tv.keyboard.press("ArrowDown");
      await tv.waitForTimeout(200);
    }
    await expect(row.locator(".is-focused").first()).toBeVisible();
    for (let i = 0; i < 25; i++) {
      await tv.keyboard.press("ArrowRight");
      await tv.waitForTimeout(140);
    }
    await tv.waitForTimeout(600);
    // Cards whose box is on screen.
    const onScreen = await row.locator("[data-card-id]").evaluateAll((els) =>
      els.filter((e) => {
        const r = e.getBoundingClientRect();
        return r.right > 0 && r.left < window.innerWidth && r.width > 0;
      }).length,
    );
    expect(onScreen, "cards visible at the end of the row").toBeGreaterThanOrEqual(6);
  } finally {
    const s = await (await phoneCtx.request.get("/api/v1/auth/session")).json();
    const devs = await (await phoneCtx.request.get("/api/v1/devices")).json();
    const dev = devs.items.find((d: { name: string }) => d.name === name);
    if (dev) await phoneCtx.request.delete(`/api/v1/devices/${dev.id}`, { headers: { "X-CSRF-Token": s.csrf_token, Origin: new URL(phone.url()).origin } });
    await phoneCtx.close();
    await tvCtx.close();
  }
});
