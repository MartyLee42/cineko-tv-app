import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// The e2e admin is a super_admin: `make e2e` runs
//   martytv admin set-role --username e2e-admin --role super_admin
const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

async function login(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(username);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
}

async function csrfHeaders(page: Page) {
  const session = await (await page.request.get("/api/v1/auth/session")).json();
  return { session, headers: { "X-CSRF-Token": session.csrf_token as string, Origin: new URL(page.url()).origin } };
}

async function adminDevices(req: APIRequestContext) {
  return (await (await req.get("/api/v1/admin/devices")).json()).items as { id: string; name: string; owner_username: string; online: boolean }[];
}

test("super admin sees every TV and connection request, rejects one and assigns another to a user", async ({ page, browser }) => {
  await login(page, USER, PASS);
  const { session, headers } = await csrfHeaders(page);
  expect(session.user.role, "run `martytv admin set-role --username e2e-admin --role super_admin` (make e2e does)").toBe("super_admin");

  // A regular user to give the TV to.
  const stamp = Date.now();
  const owner = `e2e-tvowner-${stamp}`;
  const created = await page.request.post("/api/v1/admin/users", { data: { username: owner, password: "tv-owner-password-1", role: "user" }, headers });
  expect(created.ok()).toBeTruthy();
  const ownerId = (await created.json()).id as string;

  // A pending request opened via the API (another person's TV), to reject.
  const apiReq = await (
    await page.request.post("/api/v1/pairing", { data: { device_name: `E2E Reject ${stamp}`, platform: "tizen" }, headers: { Origin: headers.Origin } })
  ).json();

  // A real TV page waiting with its code, to accept and assign.
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const tv = await tvCtx.newPage();
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();

  // Phone-sized admin page, «Устройства» tab.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin");
  await page.getByRole("tab", { name: /^devices$/i }).click();
  await expect(page).toHaveURL(/tab=devices/);

  // Reject the API request: it shows pending with a countdown, then «Rejected».
  const rejectRow = page.locator('[data-testid="admin-pairing"]', { hasText: apiReq.user_code });
  await expect(rejectRow).toHaveAttribute("data-status", "pending");
  await expect(rejectRow.getByTestId("pairing-countdown")).toHaveText(/\d+:\d\d/);
  page.once("dialog", (d) => void d.accept());
  await rejectRow.getByRole("button", { name: /^reject$/i }).click();
  await expect(rejectRow).toHaveAttribute("data-status", "denied");
  const st = await (await page.request.get(`/api/v1/pairing/${apiReq.pairing_id}`, { headers: { Authorization: `Pairing ${apiReq.poll_secret}` } })).json();
  expect(st.status).toBe("denied");

  // Accept the TV page's request for the new user, under a new name.
  const tvRow = page.locator('[data-testid="admin-pairing"]', { hasText: code });
  await expect(tvRow).toHaveAttribute("data-status", "pending");
  await tvRow.getByTestId("pairing-approve").click();
  const sheet = page.getByTestId("approve-sheet");
  await sheet.getByTestId("approve-user").selectOption(ownerId);
  const tvName = `E2E Assigned ${stamp}`;
  await sheet.getByTestId("approve-name").fill(tvName);
  await sheet.getByTestId("approve-confirm").click();
  await expect(sheet).toHaveCount(0);

  // The TV collects its credential and leaves the pairing screen…
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });
  // …and shows up (live) under its new owner, online.
  const card = page.locator('[data-testid="admin-device"]', { hasText: tvName });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText(/^online$/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid="admin-device-owner"]', { has: card })).toContainText(owner);
  const dev = (await adminDevices(page.request)).find((d) => d.name === tvName);
  expect(dev?.owner_username).toBe(owner);

  // The owner sees it in their own Devices list.
  const ownerCtx = await browser.newContext();
  const ownerLogin = await ownerCtx.request.post("/api/v1/auth/login", { data: { username: owner, password: "tv-owner-password-1" }, headers: { Origin: headers.Origin } });
  expect(ownerLogin.ok()).toBeTruthy();
  const ownDevices = (await (await ownerCtx.request.get("/api/v1/devices")).json()).items as { id: string; access: string }[];
  expect(ownDevices.find((d) => d.id === dev!.id)?.access).toBe("owner");
  await ownerCtx.close();

  // Delete it from the admin page: gone for everyone.
  page.once("dialog", (d) => void d.accept());
  await card.getByRole("button", { name: /^delete$/i }).click();
  await expect(card).toHaveCount(0);

  await tvCtx.close();
  // Clean up the test user.
  await page.request.patch(`/api/v1/admin/users/${ownerId}`, { data: { disabled: true }, headers });
});

test("a plain admin has no Devices tab and can't grant admin", async ({ page, browser }) => {
  await login(page, USER, PASS);
  const { headers } = await csrfHeaders(page);
  const name = `e2e-plainadmin-${Date.now()}`;
  const created = await page.request.post("/api/v1/admin/users", { data: { username: name, password: "plain-admin-password-1", role: "admin" }, headers });
  expect(created.ok()).toBeTruthy();
  const id = (await created.json()).id as string;

  // Super admin's own badge.
  await page.goto("/admin");
  await expect(page.getByTestId("self-role")).toHaveText(/super admin/i);

  const ctx = await browser.newContext();
  const admin = await ctx.newPage();
  await login(admin, name, "plain-admin-password-1");
  await admin.goto("/admin");
  await expect(admin.getByRole("tab", { name: /^server$/i })).toBeVisible();
  await expect(admin.getByRole("tab", { name: /^devices$/i })).toHaveCount(0);
  await admin.goto("/admin?tab=devices");
  await expect(admin.getByRole("tab", { name: /^overview$/i })).toHaveAttribute("aria-selected", "true");
  expect((await admin.request.get("/api/v1/admin/devices")).status()).toBe(403);
  expect((await admin.request.get("/api/v1/admin/pairing")).status()).toBe(403);
  // Role selects are locked and the super admin option isn't offered.
  const superRow = admin.locator("li", { hasText: USER }).first();
  await expect(superRow.getByTestId("user-role")).toBeDisabled();
  await expect(superRow.getByRole("button", { name: /reset password/i })).toHaveCount(0);
  await ctx.close();

  await page.request.patch(`/api/v1/admin/users/${id}`, { data: { disabled: true }, headers });
});
