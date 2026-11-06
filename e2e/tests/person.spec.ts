import { expect, test, type Page } from "@playwright/test";
import { quietHome } from "./quietHome";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

/**
 * Actors are clickable: web title page → cast → the person's page (bio and
 * films) → another title; TV Details → OK on a cast card → their films →
 * OK opens Details, Back returns. Needs the API with TMDB configured.
 */

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(USER);
  await page.getByLabel(/password/i).fill(PASS);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
}

async function press(tv: Page, key: string, times = 1) {
  for (let i = 0; i < times; i++) {
    await tv.keyboard.press(key);
    await tv.waitForTimeout(170);
  }
}

async function focusKey(tv: Page): Promise<string> {
  return tv.evaluate(() => {
    const el = document.querySelectorAll(".is-focused");
    const f = el[el.length - 1] as HTMLElement | undefined;
    return f?.closest("[data-focus-key]")?.getAttribute("data-focus-key") ?? "";
  });
}

test("web: cast and director link to the person's films", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const movie = (await (await page.request.get("/api/v1/catalog/search?q=The%20Matrix&kind=movie&lang=en")).json()).items[0];
  await page.goto(`/title/${movie.id}`);
  await expect(page.getByRole("heading", { level: 1, name: /matrix/i })).toBeVisible({ timeout: 20_000 });

  // Director name links too.
  await expect(page.getByTestId("crew-link").first()).toHaveAttribute("href", /^\/person\/\d+$/);

  const actor = page.getByTestId("cast-link").first();
  const name = (await actor.locator("p").first().textContent())!.trim();
  await actor.click();
  await expect(page).toHaveURL(/\/person\/\d+$/);
  await expect(page.getByTestId("person-name")).toHaveText(name, { timeout: 20_000 });
  const credits = page.getByTestId("person-credit");
  await expect(credits.first()).toBeVisible();
  expect(await credits.count()).toBeGreaterThan(5);
  // The title we came from is among their films.
  await expect(page.locator(`[data-testid="person-credits"] a[href="/title/${movie.id}"]`)).toHaveCount(1);

  // Movies / Series filter and newest-first sort.
  const tabs = page.getByRole("tab", { name: /^movies$/i });
  if (await tabs.isVisible()) {
    await tabs.click();
    await expect(tabs).toHaveAttribute("aria-selected", "true");
  }
  await page.getByRole("tab", { name: /^newest$/i }).click();
  const years = await credits.locator('[data-testid="poster-card"] p:nth-of-type(2)').allTextContents();
  const nums = years.map((y) => Number(y.match(/\d{4}/)?.[0] ?? 0)).filter(Boolean);
  expect(nums).toEqual([...nums].sort((a, b) => b - a));

  // Another film opens its page; Back returns to the person.
  const other = credits.locator('[data-testid="poster-card"]').filter({ hasNot: page.locator(`[href="/title/${movie.id}"]`) }).first();
  const href = (await other.getAttribute("href"))!;
  await other.click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  await page.goBack();
  await expect(page.getByTestId("person-name")).toHaveText(name);

  // Unknown person.
  await page.goto("/person/999999999");
  await expect(page.getByTestId("person-missing")).toBeVisible({ timeout: 20_000 });
});

test("TV: OK on a cast card opens the actor's films", async ({ browser }) => {
  test.setTimeout(180_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: "en-US" });
  await quietHome(tvCtx);
  const phone = await phoneCtx.newPage();
  const tv = await tvCtx.newPage();
  await login(phone);
  const movie = (await (await phoneCtx.request.get("/api/v1/catalog/search?q=The%20Matrix&kind=movie&lang=en")).json()).items[0];

  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Person TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  try {
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");
    await expect(tv.getByText("Trending this week").first()).toBeVisible({ timeout: 30_000 });

    const ok = await phone.evaluate(
      async ({ name, mediaId }) => {
        const s = await (await fetch("/api/v1/auth/session")).json();
        const devs = await (await fetch("/api/v1/devices")).json();
        const id = devs.items.find((d: { name: string }) => d.name === name).id;
        const r = await fetch(`/api/v1/devices/${id}/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": s.csrf_token },
          body: JSON.stringify({ type: "media.open", payload: { media_id: mediaId } }),
        });
        return (await r.json()).ok;
      },
      { name: deviceName, mediaId: movie.id },
    );
    expect(ok).toBe(true);
    const details = tv.locator(`[data-media-id="${movie.id}"]`);
    await expect(details.locator("h1")).not.toBeEmpty({ timeout: 20_000 });

    // Down to the cast row.
    for (let i = 0; i < 8 && !(await focusKey(tv)).startsWith("cast-"); i++) await press(tv, "ArrowDown");
    expect(await focusKey(tv)).toMatch(/^cast-/);
    const castKey = await focusKey(tv);
    await press(tv, "Enter");

    const person = tv.getByTestId("person");
    await expect(person).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => focusKey(tv), { timeout: 20_000 }).toMatch(/^pp-/);
    await press(tv, "ArrowRight");
    const card = await focusKey(tv);
    await press(tv, "Enter");
    await expect(tv.getByTestId("person")).toHaveCount(0, { timeout: 20_000 });
    await expect(tv.locator("[data-media-id] h1").first()).not.toBeEmpty({ timeout: 20_000 });

    // Back: the person's grid with the same card focused, then Details on the cast card.
    await press(tv, "Escape");
    await expect(person).toBeVisible();
    await expect.poll(() => focusKey(tv)).toBe(card);
    await press(tv, "Escape");
    await expect(details).toBeVisible();
    await expect.poll(() => focusKey(tv)).toBe(castKey);
  } finally {
    const s = await (await phoneCtx.request.get("/api/v1/auth/session")).json();
    const devs = await (await phoneCtx.request.get("/api/v1/devices")).json();
    const dev = devs.items.find((d: { name: string }) => d.name === deviceName);
    if (dev)
      await phoneCtx.request.delete(`/api/v1/devices/${dev.id}`, { headers: { "X-CSRF-Token": s.csrf_token, Origin: new URL(phone.url()).origin } });
    await phoneCtx.close();
    await tvCtx.close();
  }
});
