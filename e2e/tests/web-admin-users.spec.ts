import { expect, test } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

test("admin changes another user's role (with confirmation), never their own", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(USER);
  await page.getByLabel(/password/i).fill(PASS);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();

  // A throwaway user to promote/demote.
  const origin = new URL(page.url()).origin;
  const session = await (await page.request.get("/api/v1/auth/session")).json();
  const headers = { "X-CSRF-Token": session.csrf_token, Origin: origin };
  const name = `e2e-role-${Date.now()}`;
  const created = await page.request.post("/api/v1/admin/users", { data: { username: name, password: "role-test-password-1", role: "user" }, headers });
  expect(created.ok()).toBeTruthy();

  await page.goto("/admin");
  const row = page.locator("li", { hasText: name });
  const select = row.getByTestId("user-role");
  await expect(select).toHaveValue("user");

  // Promote: confirm → saved.
  page.once("dialog", (d) => void d.accept());
  await select.selectOption("admin");
  await expect.poll(async () => (await (await page.request.get("/api/v1/admin/users")).json()).items.find((u: { username: string }) => u.username === name)?.role).toBe("admin");

  // Demote, but cancel the confirmation → unchanged.
  page.once("dialog", (d) => void d.dismiss());
  await select.selectOption("user");
  await expect(select).toHaveValue("admin");

  // Demote for real.
  page.once("dialog", (d) => void d.accept());
  await select.selectOption("user");
  await expect.poll(async () => (await (await page.request.get("/api/v1/admin/users")).json()).items.find((u: { username: string }) => u.username === name)?.role).toBe("user");

  // Your own row has no role select (no self-demotion from the UI).
  await expect(page.locator("li", { hasText: USER }).first().getByTestId("user-role")).toHaveCount(0);

  // Clean up: disable the test user.
  const id = (await (await page.request.get("/api/v1/admin/users")).json()).items.find((u: { username: string }) => u.username === name).id;
  await page.request.patch(`/api/v1/admin/users/${id}`, { data: { disabled: true }, headers });
});
