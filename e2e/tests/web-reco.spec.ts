import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

const ADMIN = process.env.E2E_USER ?? "e2e-admin";
const ADMIN_PASS = process.env.E2E_PASS ?? "e2e-password-123";
const ALICE = "e2e-reco-alice";
const BOB = "e2e-reco-bob";
const PASS = "e2e-reco-password-1";
// Optional: directory for review screenshots (phone + desktop).
const SHOTS = process.env.RECO_SHOTS;

/**
 * «Посоветовать» end to end: alice recommends a title to bob with a note →
 * bob gets a live toast, sees the Home row and the inbox with the note →
 * reacts 👍 → alice's "You recommended" tab shows the reaction.
 */

async function login(page: Page, user: string, pass: string) {
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(user);
  await page.getByLabel(/password/i).fill(pass);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
}

async function csrf(page: Page) {
  const req = page.context().request;
  const session = await (await req.get("/api/v1/auth/session")).json();
  return { req, session, headers: { "X-CSRF-Token": session.csrf_token as string, Origin: new URL(page.url()).origin } };
}

/** Signs in as user (created by the admin if needed) with one active profile. */
async function userPage(browser: Browser, user: string, color: string, viewport: { width: number; height: number }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await login(page, user, PASS);
  const { req, session, headers } = await csrf(page);
  const short = user.replace("e2e-reco-", "");
  const name = short[0]!.toUpperCase() + short.slice(1);
  let profiles = (await (await req.get("/api/v1/profiles")).json()).items;
  if (!profiles.length) {
    expect((await req.post("/api/v1/profiles", { data: { name, color }, headers })).ok()).toBeTruthy();
    profiles = (await (await req.get("/api/v1/profiles")).json()).items;
  }
  // Recommendations show the sender's profile name/colour.
  await req.patch(`/api/v1/profiles/${profiles[0].id}`, { data: { name, color }, headers });
  await page.evaluate(([u, p]) => localStorage.setItem(`martytv.active_profile.${u}`, p), [session.user.id, profiles[0].id]);
  return { ctx, page, req, headers, userId: session.user.id as string };
}

/** Removes leftovers of previous runs (bob's inbox, alice's sent). */
async function clean(req: APIRequestContext, headers: Record<string, string>, path: "inbox" | "sent") {
  const res = await (await req.get(`/api/v1/recommendations/${path}`)).json();
  for (const r of res.items as { id: string }[]) await req.delete(`/api/v1/recommendations/${r.id}`, { headers });
}

test("alice recommends a title to bob; bob reacts; alice sees the reaction", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await login(page, ADMIN, ADMIN_PASS);
  const admin = await csrf(page);
  for (const username of [ALICE, BOB]) {
    const created = await admin.req.post("/api/v1/admin/users", { data: { username, password: PASS, role: "user" }, headers: admin.headers });
    expect([201, 409, 422]).toContain(created.status());
  }
  const search = await (await admin.req.get(`/api/v1/catalog/search?q=${encodeURIComponent("Inception")}&kind=movie&lang=en`)).json();
  const movie = search.items[0] as { id: string; title: string };
  expect(movie).toBeTruthy();

  const alice = await userPage(browser, ALICE, "#e11d48", { width: 1280, height: 860 });
  const bob = await userPage(browser, BOB, "#0ea5e9", { width: 390, height: 844 });
  try {
    await clean(alice.req, alice.headers, "sent");
    await clean(bob.req, bob.headers, "inbox");

    // Bob waits on Home (realtime socket open); no recommendations row yet.
    await bob.page.goto("/");
    await expect(bob.page.getByRole("heading", { name: /welcome/i })).toBeVisible();
    await expect(bob.page.getByTestId("row-reco")).toHaveCount(0);

    // Alice: title page → Recommend → pick bob → note → send.
    await alice.page.goto(`/title/${movie.id}`);
    await expect(alice.page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 20_000 });
    await alice.page.getByTestId("recommend-button").click();
    const sheet = alice.page.getByTestId("recommend-sheet");
    await expect(sheet).toBeVisible();
    const bobChip = sheet.getByTestId("reco-person").filter({ hasText: BOB });
    await bobChip.click();
    await expect(bobChip).toHaveAttribute("aria-pressed", "true");
    await sheet.getByTestId("reco-note").fill("Watch it with headphones!");
    await expect(sheet.getByTestId("reco-send")).toBeEnabled();
    if (SHOTS) {
      await alice.page.waitForTimeout(300); // button transition
      await alice.page.screenshot({ path: `${SHOTS}/sheet-desktop.png` });
    }
    const sent = alice.page.waitForResponse((r) => r.url().includes("/api/v1/recommendations") && r.request().method() === "POST");
    await sheet.getByTestId("reco-send").click();
    expect((await sent).status()).toBe(201);
    await expect(alice.page.getByTestId("reco-sent-toast")).toContainText(BOB);
    await expect(sheet).toHaveCount(0);

    // Bob: live toast, header badge, Home row with "1 new" and the note.
    await expect(bob.page.getByTestId("reco-toast")).toContainText(movie.title, { timeout: 15_000 });
    await expect(bob.page.getByTestId("reco-badge")).toHaveText("1");
    const row = bob.page.getByTestId("row-reco");
    await expect(row).toBeVisible();
    await expect(row.getByTestId("reco-row-new")).toHaveText(/1 new/);
    await expect(row.getByTestId("reco-row-card").first()).toContainText("Watch it with headphones!");
    await bob.page.getByTestId("reco-toast").getByRole("button", { name: /close/i }).click();
    if (SHOTS) {
      await row.scrollIntoViewIfNeeded();
      await bob.page.screenshot({ path: `${SHOTS}/home-row-phone.png` });
    }

    // Bob: inbox with the note → 👍.
    await bob.page.getByTestId("reco-button").click();
    await expect(bob.page).toHaveURL(/\/recommendations$/);
    const card = bob.page.getByTestId("reco-card").filter({ hasText: movie.title });
    await expect(card).toHaveAttribute("data-unseen", "true");
    await expect(card.getByTestId("reco-note-text")).toHaveText("Watch it with headphones!");
    await expect(card).toContainText("Alice recommends");
    if (SHOTS) await bob.page.screenshot({ path: `${SHOTS}/inbox-phone.png` });
    const patched = bob.page.waitForResponse((r) => r.url().includes("/api/v1/recommendations/") && r.request().method() === "PATCH");
    await card.getByTestId("reco-react-like").click();
    expect((await patched).ok()).toBeTruthy();
    await expect(card.getByTestId("reco-react-like")).toHaveAttribute("aria-pressed", "true");
    await expect(card).not.toHaveAttribute("data-unseen", "true");
    await expect(bob.page.getByTestId("reco-badge")).toHaveCount(0);

    // Alice: "You recommended" shows bob's 👍.
    await alice.page.goto("/recommendations?tab=sent");
    const sentCard = alice.page.getByTestId("reco-sent-card").filter({ hasText: movie.title });
    await expect(sentCard.getByTestId("reco-reaction")).toContainText("Like");
    await expect(sentCard).toContainText(`To ${BOB}`);

    if (SHOTS) {
      await alice.page.screenshot({ path: `${SHOTS}/sent-desktop.png` });
      // Desktop inbox + Home row, phone sheet (a second recommendation back).
      await bob.page.goto(`/title/${movie.id}`);
      await bob.page.getByTestId("recommend-button").click();
      await expect(bob.page.getByTestId("recommend-sheet")).toBeVisible();
      await bob.page.getByTestId("reco-person").filter({ hasText: ALICE }).click();
      await bob.page.waitForTimeout(300);
      await bob.page.screenshot({ path: `${SHOTS}/sheet-phone.png` });
      await bob.page.keyboard.press("Escape");
      await bob.page.setViewportSize({ width: 1280, height: 860 });
      await bob.page.goto("/recommendations");
      await expect(bob.page.getByTestId("reco-card").first()).toBeVisible();
      await bob.page.screenshot({ path: `${SHOTS}/inbox-desktop.png` });
      await bob.page.goto("/");
      await bob.page.getByTestId("row-reco").scrollIntoViewIfNeeded();
      await bob.page.screenshot({ path: `${SHOTS}/home-row-desktop.png` });
    }
  } finally {
    await alice.ctx.close();
    await bob.ctx.close();
  }
});
