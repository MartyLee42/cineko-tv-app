import { expect, test, type Page } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
const PLAIN_USER = "e2e-sysmon-user";
const PLAIN_PASS = "e2e-sysmon-password-123";

/** Admin → Server tab: host load tiles, last-hour charts, tables; admin only. */
test.use({ viewport: { width: 390, height: 844 } });

async function login(page: Page, user = USER, pass = PASS) {
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(user);
  await page.getByLabel(/password/i).fill(pass);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
}

test("admin sees the Server tab with tiles, charts and tables", async ({ page }) => {
  await login(page);
  await page.goto("/admin");
  const history = page.waitForResponse((r) => r.url().includes("/api/v1/admin/system/history") && r.ok());
  await page.getByRole("tab", { name: /server/i }).click();
  await expect(page).toHaveURL(/tab=server/);
  await expect(page.getByRole("tab", { name: /server/i })).toHaveAttribute("aria-selected", "true");

  const tab = page.getByTestId("server-tab");
  await expect(tab).toBeVisible();
  for (const id of ["tile-cpu", "tile-ram", "tile-swap", "tile-load", "tile-net", "tile-uptime"]) {
    await expect(tab.getByTestId(id)).toBeVisible();
  }
  await expect(tab.getByTestId("tile-disk").first()).toBeVisible();
  await expect(tab.getByTestId("tile-ram")).toContainText(/of/);
  await expect(page.getByTestId("server-scope")).toHaveText(/whole server|api container/i);

  const h = await (await history).json();
  expect(h.interval_seconds).toBe(10);
  expect(Array.isArray(h.samples)).toBeTruthy();

  for (const id of ["chart-cpu", "chart-ram", "chart-load", "chart-net", "chart-streams"]) {
    const chart = page.getByTestId(id);
    await expect(chart).toBeVisible();
    await expect(chart.locator("svg[role=img]")).toHaveCount(1);
  }
  // Axis labels.
  await expect(page.getByTestId("chart-cpu")).toContainText("100%");
  await expect(page.getByTestId("chart-cpu")).toContainText(/now/);

  await expect(page.getByTestId("processes-table").locator("tbody tr").first()).toBeVisible();
  await expect(page.getByTestId("app-panel")).toBeVisible();

  // Polls while open.
  const next = await page.waitForResponse((r) => r.url().endsWith("/api/v1/admin/system") && r.ok(), { timeout: 12_000 });
  const st = await next.json();
  expect(st.memory.total).toBeGreaterThan(0);
  expect(["ok", "unavailable"]).toContain(st.hostmon);
  if (st.hostmon !== "ok") await expect(page.getByTestId("hostmon-missing")).toBeVisible();

  // Deep link works and Overview is the default.
  await page.goto("/admin?tab=server");
  await expect(page.getByTestId("server-tab")).toBeVisible();
  await page.getByRole("tab", { name: /overview/i }).click();
  await expect(page.getByTestId("server-tab")).toHaveCount(0);
  await expect(page).not.toHaveURL(/tab=server/);
});

test("non-admins can't see the Server tab or its API", async ({ page, browser }) => {
  await login(page);
  const req = page.context().request;
  const session = await (await req.get("/api/v1/auth/session")).json();
  const headers = { "X-CSRF-Token": session.csrf_token as string, Origin: new URL(page.url()).origin };
  const created = await req.post("/api/v1/admin/users", { data: { username: PLAIN_USER, password: PLAIN_PASS, role: "user" }, headers });
  expect([201, 409, 422]).toContain(created.status());

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  try {
    await login(p, PLAIN_USER, PLAIN_PASS);
    expect((await p.context().request.get("/api/v1/admin/system")).status()).toBe(403);
    expect((await p.context().request.get("/api/v1/admin/system/history")).status()).toBe(403);
    await p.goto("/admin?tab=server");
    await expect(p).toHaveURL(/\/$/);
    await expect(p.getByTestId("server-tab")).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});
