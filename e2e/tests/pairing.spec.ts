import { expect, test } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

/**
 * Phase 1 acceptance test: a user logs into the PWA, pairs a TV via its
 * code, sees it online, sends it a message, and the TV reconnects by itself
 * after a restart.
 */
test("pair a TV from the phone and see it online", async ({ browser }) => {
  // Separate browser contexts = separate devices (no shared cookies).
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
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

  // Same URL the QR code encodes.
  await phone.goto(`/pair?code=${code}`);
  await expect(phone.getByText(code)).toBeVisible();
  const deviceName = `E2E TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(phone.getByText(/your tv will connect/i)).toBeVisible();

  // TV finishes pairing on its own and leaves the pairing screen.
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  await phone.goto("/devices");
  const card = phone.locator("section", { hasText: deviceName });
  await expect(card.getByText(/^online/i)).toBeVisible({ timeout: 15_000 });

  // Phone → TV command round trip (needs a profile chosen or not: works on any screen).
  await card.getByRole("button", { name: /send test message/i }).click();
  await expect(card.getByText(/message shown on tv/i)).toBeVisible();
  await expect(tv.getByText(/hello from martytv/i)).toBeVisible();

  // Restart the TV app: it reconnects with its stored credential, no pairing.
  await tv.reload();
  await expect(tv.locator("p.font-mono")).toHaveCount(0);
  await expect(card.getByText(/^online/i)).toBeVisible({ timeout: 15_000 });

  // Clean up: unpair so reruns start fresh.
  phone.once("dialog", (d) => d.accept());
  await card.getByRole("button", { name: /unpair/i }).click();
  await expect(card).toHaveCount(0);
});
