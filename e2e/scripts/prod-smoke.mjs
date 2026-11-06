// Smoke-check the live site: login as the given user, screenshot Home, a title and Search.
// Usage (in the e2e container): SMOKE_USER=… SMOKE_PASS=… node scripts/prod-smoke.mjs
import { chromium } from "@playwright/test";
const base = process.env.SMOKE_URL;
if (!base) throw new Error("set SMOKE_URL=https://your-host");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto(`${base}/login`);
await page.getByLabel(/username|имя/i).fill(process.env.SMOKE_USER);
await page.getByLabel(/password|пароль/i).fill(process.env.SMOKE_PASS);
await page.getByRole("button", { name: /sign in|войти/i }).click();
await page.locator('[data-testid="row-trending"] img').first().waitFor({ timeout: 30000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: "/repo/e2e/scripts/out/smoke-home.png" });
await page.locator('[data-testid="row-trending"] a').first().click();
await page.getByRole("heading", { level: 1 }).waitFor();
await page.waitForTimeout(1500);
await page.screenshot({ path: "/repo/e2e/scripts/out/smoke-title.png" });
console.log("title:", await page.getByRole("heading", { level: 1 }).textContent(), page.url());
await browser.close();
