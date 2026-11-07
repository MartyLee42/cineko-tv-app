// Plain HTTP (a LAN install): browsers give Cache Storage / service workers to
// secure origins only, so «Скачать на устройство» can't work — the PWA must say
// why instead of hiding the feature (web-device-downloads.spec.ts: the rest).
import { expect, test } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
const ORIGIN = new URL(process.env.E2E_BASE_URL ?? "http://localhost:8080").origin;

test.use({ viewport: { width: 390, height: 844 }, locale: "ru-RU" });
test.skip(/^https:|^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(ORIGIN), "a secure origin");

test("explains that saving to the device needs HTTPS", async ({ page }) => {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => localStorage.setItem("martytv.locale", "ru"));
  await page.reload();
  await page.getByLabel(/username|имя пользователя|логин/i).fill(USER);
  await page.getByLabel(/password|пароль/i).fill(PASS);
  await page.getByRole("button", { name: /sign in|войти/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await page.goto("/downloads");
  await expect(page.getByTestId("device-unsupported")).toContainText("только по HTTPS");
});
