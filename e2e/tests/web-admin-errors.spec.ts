import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
const SHOTS = process.env.E2E_SHOTS ?? "/tmp/pw-errors/shots";

/**
 * Client error logging: errors thrown in the PWA and the TV app are batched
 * to POST /client-errors and show up in Admin → Errors, grouped and counted;
 * resolving a group and hitting the error again marks it regressed.
 */

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(USER);
  await page.getByLabel(/password/i).fill(PASS);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
}

const reported = (page: Page) =>
  page.waitForResponse((r) => r.url().endsWith("/api/v1/client-errors") && r.request().method() === "POST", { timeout: 15_000 });

/** Throw from a timer (window "error") and/or reject a promise (unhandledrejection). */
async function throwInPage(page: Page, message: string, opts: { reject?: string } = {}) {
  await page.evaluate(
    ([msg, rej]) => {
      setTimeout(() => {
        throw new Error(msg);
      }, 0);
      if (rej) void Promise.reject(new Error(rej));
    },
    [message, opts.reject ?? ""] as const,
  );
}

async function adminApi(ctx: BrowserContext, q: string) {
  const r = await ctx.request.get(`/api/v1/admin/client-errors?status=all&q=${encodeURIComponent(q)}`);
  expect(r.ok()).toBeTruthy();
  return (await r.json()) as { items: { id: string; app: string; kind: string; count: number; status: string; regressed: boolean }[]; total: number };
}

async function cleanup(ctx: BrowserContext, q: string) {
  const origin = new URL(test.info().project.use.baseURL ?? "http://localhost:8080").origin;
  const session = await (await ctx.request.get("/api/v1/auth/session")).json();
  for (const g of (await adminApi(ctx, q)).items) {
    await ctx.request.delete(`/api/v1/admin/client-errors/${g.id}`, { headers: { "X-CSRF-Token": session.csrf_token, Origin: origin } });
  }
}

test("web: errors are grouped, counted, resolved and regress", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "en-US" });
  const page = await ctx.newPage();
  const tag = `E2E-${Date.now()}`;
  const boom = `${tag} boom in widget`;
  try {
    await login(page);
    await page.goto("/admin?tab=errors");
    await expect(page.getByTestId("errors-tab")).toBeVisible();

    // An uncaught error and an unhandled rejection → one batch.
    let sent = reported(page);
    await throwInPage(page, boom, { reject: `${tag} rejected promise` });
    expect((await sent).status()).toBe(202);
    // The same error again → the group counts up.
    sent = reported(page);
    await throwInPage(page, boom);
    expect((await sent).status()).toBe(202);

    const api = await adminApi(ctx, tag);
    expect(api.items.map((g) => g.kind).sort()).toEqual(["error", "unhandledrejection"]);

    await page.reload();
    await page.getByTestId("errors-search").fill(tag);
    const rows = page.getByTestId("error-group");
    await expect(rows).toHaveCount(2);
    const row = rows.filter({ hasText: "boom in widget" });
    await expect(row).toHaveAttribute("data-app", "web");
    await expect(row.getByTestId("error-count")).toHaveText("2");
    await expect(rows.filter({ hasText: "rejected promise" })).toHaveAttribute("data-count", "1");

    // Detail drawer: samples with a stack; resolve.
    await row.click();
    const detail = page.getByTestId("error-detail");
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId("error-detail-message")).toContainText(boom);
    await expect(detail.getByTestId("error-sample")).toHaveCount(2);
    await page.screenshot({ path: `${SHOTS}/desktop-detail.png` });
    await detail.getByTestId("error-resolve").click();
    await expect(detail.getByTestId("error-reopen")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(rows).toHaveCount(1); // only unresolved by default

    // It happens again → back in the list, regressed.
    sent = reported(page);
    await throwInPage(page, boom);
    expect((await sent).status()).toBe(202);
    await page.reload();
    await page.getByTestId("errors-search").fill(tag);
    const again = page.getByTestId("error-group").filter({ hasText: "boom in widget" });
    await expect(again).toHaveAttribute("data-regressed", "true");
    await expect(again.getByTestId("error-regressed")).toBeVisible();
    await expect(again.getByTestId("error-count")).toHaveText("3");
    await expect(page.getByTestId("error-group")).toHaveCount(2);
    await page.screenshot({ path: `${SHOTS}/desktop-list.png` });

    // Phone layout (no horizontal scroll), dark and light, en and ru.
    for (const scheme of ["dark", "light"] as const) {
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme, locale: "en-US" });
      const p = await phone.newPage();
      try {
        await login(p);
        if (scheme === "light") await p.evaluate(() => localStorage.setItem("martytv.locale", "ru"));
        await p.goto("/admin?tab=errors");
        await p.getByTestId("errors-search").fill(tag);
        await expect(p.getByTestId("error-group")).toHaveCount(2);
        const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        await p.screenshot({ path: `${SHOTS}/phone-list-${scheme}.png`, fullPage: true });
        await p.getByTestId("error-group").first().click();
        await expect(p.getByTestId("error-detail")).toBeVisible();
        await p.getByTestId("error-sample").first().locator("summary").first().click().catch(() => {});
        await p.screenshot({ path: `${SHOTS}/phone-detail-${scheme}.png` });
      } finally {
        await phone.close();
      }
    }
  } finally {
    await cleanup(ctx, tag);
    await ctx.close();
  }
});

test("tv: an error from the TV app shows up with app=tv", async ({ browser }) => {
  test.setTimeout(120_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
  const phone = await phoneCtx.newPage();
  const tv = await tvCtx.newPage();
  const tag = `E2E-TV-${Date.now()}`;
  let deviceId: string | undefined;
  await login(phone);
  const origin = new URL(phone.url()).origin;
  const session = await (await phoneCtx.request.get("/api/v1/auth/session")).json();
  const headers = { "X-CSRF-Token": session.csrf_token as string, Origin: origin };
  try {
    await tv.goto("/tv/");
    const codeEl = tv.locator("p.font-mono");
    await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const code = (await codeEl.textContent())!.trim();
    await phone.goto(`/pair?code=${code}`);
    const deviceName = `E2E Errors TV ${Date.now()}`;
    await phone.getByLabel(/tv name/i).fill(deviceName);
    await phone.getByRole("button", { name: /connect tv/i }).click();
    await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });
    const devices = await (await phoneCtx.request.get("/api/v1/devices")).json();
    deviceId = devices.items.find((d: { name: string }) => d.name === deviceName).id as string;

    const sent = reported(tv);
    await throwInPage(tv, `${tag} tv crash`);
    const res = await sent;
    expect(res.status()).toBe(202);
    expect(res.request().headers()["authorization"]).toMatch(/^Bearer mtd_/);

    const api = await adminApi(phoneCtx, tag);
    expect(api.items).toHaveLength(1);
    expect(api.items[0]).toMatchObject({ app: "tv", kind: "error", count: 1 });
    const detail = await (await phoneCtx.request.get(`/api/v1/admin/client-errors/${api.items[0].id}`)).json();
    expect(detail.samples[0].device).toMatchObject({ id: deviceId, name: deviceName });

    // Phones: Admin is one tap away from Settings (no bottom-bar item).
    await phone.goto("/settings");
    await phone.getByTestId("settings-admin").click();
    await expect(phone).toHaveURL(/\/admin/);
    await phone.goto("/admin?tab=errors");
    await phone.getByTestId("errors-search").fill(tag);
    await expect(phone.getByTestId("error-group")).toHaveCount(1);
    await expect(phone.getByTestId("error-group")).toHaveAttribute("data-app", "tv");
  } finally {
    await cleanup(phoneCtx, tag);
    if (deviceId) await phoneCtx.request.delete(`/api/v1/devices/${deviceId}`, { headers });
    await phoneCtx.close();
    await tvCtx.close();
  }
});
