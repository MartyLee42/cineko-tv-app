import { expect, test, type Page } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

async function press(tv: Page, key: string, times = 1) {
  for (let i = 0; i < times; i++) {
    await tv.keyboard.press(key);
    await tv.waitForTimeout(160);
  }
}
const focused = (l: ReturnType<Page["locator"]>) => l.evaluate((el) => /is-focused/.test(el.className) || el.getAttribute("data-nav-focused") === "1").catch(() => false);

test("TV Settings → «About this TV»: resolution, scale and formats; Back closes", async ({ browser }) => {
  test.setTimeout(120_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
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
  const profiles = await (await phoneCtx.request.get("/api/v1/profiles")).json();
  for (const p of profiles.items as { id: string }[])
    await phoneCtx.request.put(`/api/v1/profiles/${p.id}/settings`, { data: { onboarding_completed: true, design: "kinozal" }, headers });

  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  await phone.goto(`/pair?code=${(await codeEl.textContent())!.trim()}`);
  const deviceName = `E2E Info TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(codeEl).toHaveCount(0, { timeout: 15_000 });
  try {
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");
    // Rail → walk down to Settings.
    await press(tv, "ArrowLeft");
    const menuSettings = tv.locator("nav [data-menu=settings]");
    for (let i = 0; i < 16 && !(await focused(menuSettings)); i++) await press(tv, "ArrowDown");
    await press(tv, "Enter");
    const settings = tv.getByTestId("tv-settings");
    await expect(settings).toBeVisible();
    const about = settings.locator("[data-action=about]");
    for (let i = 0; i < 80 && !(await focused(about)); i++) await press(tv, "ArrowDown");
    await expect(about).toHaveClass(/is-focused/);
    await press(tv, "Enter");
    const info = tv.getByTestId("tv-device-info");
    await expect(info).toContainText("About this TV");
    await expect(info).toContainText(/\d+×\d+/);
    await expect(info).toContainText(/UI scale \d+%/);
    await expect(info.locator('[data-codec="H.264"]')).toHaveCount(1);
    await press(tv, "Escape");
    await expect(info).toHaveCount(0);
    await expect(settings).toBeVisible();
  } finally {
    const devices = await (await phoneCtx.request.get("/api/v1/devices")).json();
    const d = devices.items.find((x: { name: string }) => x.name === deviceName);
    if (d) await phoneCtx.request.delete(`/api/v1/devices/${d.id}`, { headers });
    await phoneCtx.close();
    await tvCtx.close();
  }
});
