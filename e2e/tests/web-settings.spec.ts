import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

/**
 * Phase 5 PWA settings: per-profile theme (instant + persisted), hide anime
 * (saved, catalog requests carry profile_id), and the first-run guide.
 */
test.use({ viewport: { width: 390, height: 844 } });

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(USER);
  await page.getByLabel(/password/i).fill(PASS);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
}

async function api(page: Page) {
  const req = page.context().request;
  const session = await (await req.get("/api/v1/auth/session")).json();
  const headers = { "X-CSRF-Token": session.csrf_token as string, Origin: new URL(page.url()).origin };
  return { req, headers, userId: session.user.id as string };
}

async function ensureProfile(req: APIRequestContext, headers: Record<string, string>) {
  const profiles = await (await req.get("/api/v1/profiles")).json();
  if (profiles.items.length) return profiles.items[0].id as string;
  const r = await req.post("/api/v1/profiles", { data: { name: "E2E", color: "#6366f1" }, headers });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).id as string;
}

test("theme applies instantly and persists; hide anime is saved per profile", async ({ page }) => {
  await login(page);
  const { req, headers, userId } = await api(page);
  const profileId = await ensureProfile(req, headers);
  // Browse as that profile on this browser.
  await page.evaluate(([u, p]) => localStorage.setItem(`martytv.active_profile.${u}`, p), [userId, profileId]);
  await req.put(`/api/v1/profiles/${profileId}/settings`, { data: { theme: "dark", design: "kinozal", hide_anime: false }, headers });

  try {
    await page.goto("/settings");
    await expect(page.getByTestId("settings-profile")).toBeVisible();
    const html = page.locator("html");
    await expect(html).not.toHaveClass(/theme-light/);

    // Theme: instant, then saved.
    const saved = page.waitForResponse((r) => r.url().includes(`/profiles/${profileId}/settings`) && r.request().method() === "PUT");
    await page.getByTestId("theme-picker").getByRole("radio", { name: /light/i }).click();
    await expect(html).toHaveClass(/theme-light/);
    expect((await saved).ok()).toBeTruthy();
    await expect(page.getByTestId("settings-saved")).toContainText(/saved/i);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "rgb(244, 245, 240)");

    await page.reload();
    await expect(html).toHaveClass(/theme-light/);
    await expect(page.getByTestId("theme-picker").getByRole("radio", { name: /light/i })).toHaveAttribute("aria-checked", "true");

    // Design: Терминал is dark-only, so the colour-mode control is disabled.
    await page.getByTestId("design-picker").getByRole("radio", { name: /terminal/i }).click();
    await expect(html).toHaveClass(/design-terminal/);
    await expect(page.getByTestId("theme-picker").getByRole("radio", { name: /light/i })).toBeDisabled();
    // The later designs: each switches html.design-* / skel-* at once, is saved, and is dark-only.
    for (const [name, id, skel] of [[/wireframe/i, "wireframe", "projector"], [/cyberpunk/i, "cyberpunk", "terminal"], [/art deco/i, "deco", "kinozal"], [/retro 80s/i, "retro80", "kinozal"], [/retro 90s/i, "retro90", "terminal"], [/pop art/i, "popart", "projector"], [/constructivism/i, "constructivism", "terminal"]] as const) {
      const put = page.waitForRequest((r) => r.url().includes(`/profiles/${profileId}/settings`) && r.method() === "PUT");
      await page.getByTestId("design-picker").getByRole("radio", { name }).click();
      await expect(html).toHaveClass(new RegExp(`design-${id}`));
      await expect(html).toHaveClass(new RegExp(`skel-${skel}`));
      expect((await put).postDataJSON()).toMatchObject({ design: id });
      await expect(page.getByTestId("design-picker").getByRole("radio", { name })).toHaveAttribute("aria-checked", "true");
      await expect(page.getByTestId("theme-picker").getByRole("radio", { name: /light/i })).toBeDisabled();
    }
    await expect.poll(async () => (await (await req.get(`/api/v1/profiles/${profileId}/settings`)).json()).design).toBe("constructivism");
    await page.getByTestId("design-picker").getByRole("radio", { name: /cinema hall/i }).click();
    await expect(html).toHaveClass(/design-kinozal/);
    await expect(html).toHaveClass(/theme-light/);

    // Hide anime: PUT carries the change; catalog requests carry profile_id.
    const put = page.waitForRequest((r) => r.url().includes(`/profiles/${profileId}/settings`) && r.method() === "PUT");
    const sw = page.getByTestId("setting-hide-anime");
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await sw.click();
    expect((await put).postDataJSON()).toEqual({ hide_anime: true });
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("settings-saved")).toContainText(/saved/i);
    const stored = await (await req.get(`/api/v1/profiles/${profileId}/settings`)).json();
    expect(stored.hide_anime).toBe(true);

    const home = page.waitForRequest((r) => r.url().includes("/api/v1/catalog/home"));
    await page.getByRole("link", { name: /^home$/i }).first().click();
    expect(new URL((await home).url()).searchParams.get("profile_id")).toBe(profileId);

    // Privacy note and device section are on the page.
    await page.goto("/settings");
    await expect(page.getByTestId("privacy-note")).toBeVisible();
    await expect(page.getByTestId("language-select")).toBeVisible();
  } finally {
    await req.put(`/api/v1/profiles/${profileId}/settings`, { data: { theme: "system", design: "kinozal", hide_anime: false }, headers });
  }
});

test("first-run guide shows for a new profile and Skip hides it for good", async ({ page }) => {
  await login(page);
  const { req, headers, userId } = await api(page);
  const r = await req.post("/api/v1/profiles", { data: { name: `Onb${Date.now() % 100000}`, color: "#22c55e" }, headers });
  expect(r.ok()).toBeTruthy();
  const profileId = (await r.json()).id as string;
  try {
    // Automated browsers skip the guide unless forced (see watch/onboarding.ts).
    await page.evaluate(
      ([u, p]) => {
        localStorage.setItem(`martytv.active_profile.${u}`, p);
        localStorage.setItem("martytv.onboarding.force", "1");
      },
      [userId, profileId],
    );
    await page.reload();
    const guide = page.getByTestId("onboarding");
    await expect(guide).toBeVisible();
    await expect(guide).toContainText(/step 1 of 6/i);
    await guide.getByTestId("onboarding-next").click();
    await expect(guide).toContainText(/step 2 of 6/i);
    await guide.getByTestId("onboarding-skip").click();
    await expect(guide).toBeHidden();

    const s = await (await req.get(`/api/v1/profiles/${profileId}/settings`)).json();
    expect(s.onboarding_completed).toBe(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
    await expect(page.getByTestId("onboarding")).toHaveCount(0);
  } finally {
    await page.evaluate(() => localStorage.removeItem("martytv.onboarding.force"));
    await req.delete(`/api/v1/profiles/${profileId}`, { headers });
  }
});

test("taste note and minimum ratings are saved per profile; Ask AI and «Для вас» link to them", async ({ page }) => {
  await login(page);
  const { req, headers, userId } = await api(page);
  const r = await req.post("/api/v1/profiles", { data: { name: `Taste${Date.now() % 100000}`, color: "#f59e0b" }, headers });
  expect(r.ok()).toBeTruthy();
  const profileId = (await r.json()).id as string;
  try {
    await page.evaluate(([u, p]) => localStorage.setItem(`martytv.active_profile.${u}`, p), [userId, profileId]);
    await page.goto("/settings#taste");
    const card = page.getByTestId("taste-card");
    await expect(card).toBeVisible();
    const box = card.getByTestId("taste-note");
    await expect(box).toHaveAttribute("placeholder", /atmospheric thrillers/i);
    await expect(card.getByTestId("taste-save")).toBeDisabled();

    // Over the limit: counter warns and Save stays disabled.
    await box.fill("x".repeat(601));
    await expect(card.getByTestId("taste-counter")).toContainText("601 / 600");
    await expect(card.getByTestId("taste-save")).toBeDisabled();

    const note = "  Love atmospheric thrillers and smart sci-fi, no musicals  ";
    await box.fill(note);
    await expect(card.getByTestId("taste-counter")).toContainText(`${note.trim().length} / 600`);
    const put = page.waitForRequest((q) => q.url().includes(`/profiles/${profileId}/settings`) && q.method() === "PUT");
    await card.getByTestId("taste-save").click();
    expect((await put).postDataJSON()).toEqual({ taste_note: note.trim() });
    await expect(card.getByTestId("taste-saved")).toContainText(/saved/i);

    // Minimum ratings: a select with the fixed choices.
    const sel = page.getByTestId("setting-min-votes");
    await expect(sel).toHaveValue("100");
    await expect(sel.locator("option")).toHaveCount(6);
    const put2 = page.waitForRequest((q) => q.url().includes(`/profiles/${profileId}/settings`) && q.method() === "PUT");
    await sel.selectOption("1000");
    expect((await put2).postDataJSON()).toEqual({ min_votes: 1000 });

    const stored = await (await req.get(`/api/v1/profiles/${profileId}/settings`)).json();
    expect(stored.taste_note).toBe(note.trim());
    expect(stored.min_votes).toBe(1000);
    await page.reload();
    await expect(page.getByTestId("taste-note")).toHaveValue(note.trim());
    await expect(page.getByTestId("setting-min-votes")).toHaveValue("1000");

    // Ask AI links here.
    await page.goto("/ask");
    const link = page.getByTestId("taste-link");
    await expect(link).toHaveAttribute("href", "/settings#taste");
    await link.click();
    await expect(page.getByTestId("taste-card")).toBeVisible();
  } finally {
    await req.delete(`/api/v1/profiles/${profileId}`, { headers });
  }
});
