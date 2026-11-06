// TV health («Состояние»): a TV posts a sample with its own credential, the
// owner's Devices page shows it (bad values flagged, with a hint), the TV's
// Settings has the on/off switch (default on) and «About this TV» shows the
// local values.
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

test("TV health: posted by the TV, shown on Devices; switch and local values on the TV", async ({ browser }) => {
  test.setTimeout(150_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US" });
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
  const deviceName = `E2E Health TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(codeEl).toHaveCount(0, { timeout: 15_000 });
  try {
    // The TV's own credential posts a struggling sample (users can't).
    const cred = await tv.evaluate(() => localStorage.getItem("martytv.device_credential"));
    expect(cred).toBeTruthy();
    const sample = { reason: "playback", fps: 22, lag_ms: 140, heap_used_mb: 182, heap_limit_mb: 1024, device_memory_gb: 2, cores: 4, dropped_frames: 12, total_frames: 3000 };
    const post = await tvCtx.request.post("/api/v1/devices/me/health", { data: sample, headers: { Authorization: `Bearer ${cred}` } });
    expect(post.status()).toBe(201);
    expect((await phoneCtx.request.post("/api/v1/devices/me/health", { data: sample, headers })).status()).toBe(403);

    await phone.goto("/devices");
    const card = phone.locator("section", { hasText: deviceName }).getByTestId("device-health");
    await expect(card).toHaveAttribute("data-state", "ok");
    await expect(card).toContainText("App memory 182 / 1024 MB");
    await expect(card).toContainText("4 cores");
    await expect(card.locator('[data-health="fps"][data-bad="1"]')).toContainText("22 fps");
    await expect(card.locator('[data-health="lag"][data-bad="1"]')).toBeVisible();
    await expect(card).toContainText(/struggling/);

    // TV: Settings → the switch (on by default) and «About this TV».
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");
    await press(tv, "ArrowLeft");
    const menuSettings = tv.locator("nav [data-menu=settings]");
    for (let i = 0; i < 16 && !(await focused(menuSettings)); i++) await press(tv, "ArrowDown");
    await press(tv, "Enter");
    const settings = tv.getByTestId("tv-settings");
    await expect(settings).toBeVisible();
    const about = settings.locator("[data-action=about]");
    for (let i = 0; i < 44 && !(await focused(about)); i++) await press(tv, "ArrowDown");
    await expect(settings.locator('[data-setting="health-report"]')).toHaveAttribute("data-value", "true");
    await press(tv, "Enter");
    const row = tv.getByTestId("tv-device-health");
    await expect(row).toContainText("Health now");
    await expect(row).not.toContainText("Measuring", { timeout: 8_000 });
    await press(tv, "Escape");
  } finally {
    const devices = await (await phoneCtx.request.get("/api/v1/devices")).json();
    const d = devices.items.find((x: { name: string }) => x.name === deviceName);
    if (d) await phoneCtx.request.delete(`/api/v1/devices/${d.id}`, { headers });
    await phoneCtx.close();
    await tvCtx.close();
  }
});
