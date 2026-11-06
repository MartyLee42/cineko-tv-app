import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { quietHome } from "./quietHome";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

type Run = { design: "kinozal" | "terminal" | "projector"; theme: "dark" | "light" };
const RUNS: Run[] = [
  { design: "kinozal", theme: "dark" },
  { design: "kinozal", theme: "light" },
  { design: "terminal", theme: "dark" },
  { design: "projector", theme: "dark" },
];

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function press(tv: Page, key: string, times = 1) {
  for (let i = 0; i < times; i++) {
    await tv.keyboard.press(key);
    await tv.waitForTimeout(170);
  }
}

/** The focused element (one per screen) and the focus key of its slot / button. */
const focused = (tv: Page) => tv.locator(".is-focused").last();
async function focusKey(tv: Page): Promise<string> {
  return tv.evaluate(() => {
    const el = document.querySelectorAll(".is-focused");
    const f = el[el.length - 1] as HTMLElement | undefined;
    const slot = f?.closest("[data-focus-key]");
    return slot?.getAttribute("data-focus-key") ?? f?.textContent?.trim() ?? "";
  });
}

/**
 * The focused element is fully on screen in a comfortable band: not under
 * the top chrome (top ≥ 80) and not at the very bottom (bottom ≤ 1000).
 * Waits for the scroll transition to settle.
 */
async function expectInView(tv: Page, what: string) {
  await tv.waitForTimeout(320);
  await expect
    .poll(
      async () => {
        const b = await focused(tv).boundingBox();
        return b ? { top: Math.round(b.y), bottom: Math.round(b.y + b.height), left: Math.round(b.x), right: Math.round(b.x + b.width) } : null;
      },
      { message: `${what}: focused element in view` },
    )
    .toMatchObject({ top: expect.any(Number) });
  const b = (await focused(tv).boundingBox())!;
  const info = await focused(tv).evaluate((el) => `${el.className} | ${(el.textContent ?? "").slice(0, 40)} | n=${document.querySelectorAll(".is-focused").length}`);
  what = `${what} [${info}]`;
  expect(b.y, `${what}: top ${b.y}`).toBeGreaterThanOrEqual(80);
  expect(b.y + b.height, `${what}: bottom ${b.y + b.height}`).toBeLessThanOrEqual(1000);
  expect(b.x, `${what}: left`).toBeGreaterThanOrEqual(0);
}

function release(i: number) {
  return {
    id: `rel-${i}`, title: `Mock.Release.${i}`, indexer: "MockTracker", size_bytes: (2 + i) * 1024 ** 3, seeders: 100 - i, leechers: 1, published_at: null, info_hash: null,
    resolution: i % 2 ? "1080p" : "2160p", video_codec: "h264", hdr: null, audio_codecs: ["ac3"], languages: ["ru"], voiceovers: [], release_group: null,
    source_quality: "web-dl", year: 2020, seasons: [], episodes: [], is_season_pack: false, confidence: 0.9, score: 1, reasons: [], warnings: [],
  };
}

async function mockBackend(ctx: BrowserContext, run: Run, extra: { watchlist: unknown[] }) {
  await ctx.unrouteAll({ behavior: "ignoreErrors" });
  await quietHome(ctx);
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
    if (route.request().method() !== "GET") return json(route, {});
    const res = await route.fetch().catch(() => null);
    const body = res && res.ok() ? await res.json() : {};
    return json(route, { ...body, design: run.design, theme: run.theme, onboarding_completed: true });
  });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, (route) => json(route, { items: [] }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/progress/, (route) => json(route, { media_id: "x", kind: "movie", movie: null, episodes: [], seasons: [], next_up: null }));
  await ctx.route(/\/api\/v1\/recommendations\/inbox/, (route) => json(route, { items: [], unseen: 0 }));
  // Online sources answer live in dev: keep Details hermetic (no «Смотреть онлайн» button).
  await ctx.route(/\/api\/v1\/media\/[^/]+\/online/, (route) => json(route, { items: [], providers: [], searched_at: new Date().toISOString(), cached: true }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) => json(route, { items: Array.from({ length: 12 }, (_, i) => release(i)), searched_at: new Date().toISOString(), cached: true, indexer_errors: [] }));
  await ctx.route(/\/api\/v1\/playback\//, (route) => json(route, { error: { code: "not_found", message: "mocked" } }, 404));
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/lists\/watchlist/, (route) => json(route, { items: extra.watchlist, page: 1, total_pages: 1, total_results: extra.watchlist.length }));
  const msgs = Array.from({ length: 9 }, (_, i) => ({
    id: `5e5a0000-0000-4000-8000-00000000000${i}`, title: `Message ${i + 1}`, body: "A longer message body that may wrap onto a second line on the TV screen.".repeat(2),
    from_name: "Admin", created_at: new Date().toISOString(), read_at: new Date().toISOString(),
  }));
  await ctx.route(/\/api\/v1\/messages(\?.*)?$/, (route) => json(route, { items: msgs, unread: 0 }));
}

/**
 * Details scrolls every section into view in each design (series: seasons,
 * the 6th episode, another season; then cast/similar/…; Up back to Play with
 * the hero). The same viewport check covers Browse, Search, Моё, Messages
 * and the release picker.
 */
test("TV scrolling: Details sections, grids, lists and the picker stay in view", async ({ browser }) => {
  test.setTimeout(420_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: "en-US" });
  const phone = await phoneCtx.newPage();
  const tv = await tvCtx.newPage();

  await phone.goto("/login");
  await phone.getByLabel(/username/i).fill(USER);
  await phone.getByLabel(/password/i).fill(PASS);
  await phone.getByRole("button", { name: /sign in/i }).click();
  await expect(phone.getByRole("heading", { name: /welcome/i })).toBeVisible();
  const origin = new URL(phone.url()).origin;
  const session = await (await phoneCtx.request.get("/api/v1/auth/session")).json();
  const profiles = await (await phoneCtx.request.get("/api/v1/profiles")).json();
  if (profiles.items.length === 0) {
    expect((await phoneCtx.request.post("/api/v1/profiles", { data: { name: "E2E", color: "#6366f1" }, headers: { "X-CSRF-Token": session.csrf_token, Origin: origin } })).ok()).toBeTruthy();
  }
  const find = async (q: string, kind: string) => (await (await phoneCtx.request.get(`/api/v1/catalog/search?q=${encodeURIComponent(q)}&kind=${kind}&lang=en`)).json()).items;
  const series = (await find("Breaking Bad", "series"))[0];
  const movie = (await find("The Matrix", "movie"))[0];
  const watchlist = (await find("Star", "all")).slice(0, 20);

  await mockBackend(tvCtx, RUNS[0]!, { watchlist });
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Scroll TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  const open = (mediaId: string) =>
    phone.evaluate(
      async ({ name, mediaId }) => {
        const s = await (await fetch("/api/v1/auth/session")).json();
        const devs = await (await fetch("/api/v1/devices")).json();
        const id = devs.items.find((d: { name: string }) => d.name === name).id;
        const r = await fetch(`/api/v1/devices/${id}/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": s.csrf_token },
          body: JSON.stringify({ type: "media.open", payload: { media_id: mediaId } }),
        });
        const ack = await r.json();
        return ack.ok ? true : JSON.stringify(ack);
      },
      { name: deviceName, mediaId },
    );

  try {
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");

    for (const run of RUNS) {
      const tag = `${run.design}/${run.theme}`;
      await mockBackend(tvCtx, run, { watchlist });
      await tv.reload();
      await expect(tv.locator(`[data-design-shell="${run.design}"]`)).toBeVisible({ timeout: 30_000 });
      await expect(tv.getByText("Trending this week").first()).toBeVisible({ timeout: 30_000 });

      // --- Series Details: Play → seasons → the 6th episode → another season → … → back up.
      expect(await open(series.id)).toBe(true);
      const details = tv.locator(`[data-media-id="${series.id}"]`);
      await expect(details.locator("h1")).not.toBeEmpty({ timeout: 20_000 });
      await expect(details.locator(".is-focused")).toContainText(/play/i);
      await expectInView(tv, `${tag} play`);
      await press(tv, "ArrowDown");
      await expect.poll(() => focusKey(tv)).toMatch(/^season-/);
      await expectInView(tv, `${tag} seasons`);
      await press(tv, "ArrowDown");
      await expect.poll(() => focusKey(tv)).toMatch(/^ep-/);
      await press(tv, "ArrowRight", 5);
      await expectInView(tv, `${tag} episode 6`);
      // Another season: its episodes replace the row and stay in view.
      await press(tv, "ArrowUp");
      await expect.poll(() => focusKey(tv)).toMatch(/^season-/);
      await press(tv, "ArrowRight");
      await press(tv, "Enter");
      await expectInView(tv, `${tag} season 2 chip`);
      await press(tv, "ArrowDown");
      await expect.poll(() => focusKey(tv), { timeout: 15_000 }).toMatch(/^ep-/);
      await expectInView(tv, `${tag} season 2 episodes`);
      // Every later section (cast, similar, recommendations) is reachable and in view.
      const seen = new Set<string>();
      for (let i = 0; i < 6; i++) {
        const before = await focusKey(tv);
        await press(tv, "ArrowDown");
        const after = await focusKey(tv);
        if (after === before) break;
        seen.add(after.split("-").slice(0, 2).join("-"));
        await expectInView(tv, `${tag} section ${after}`);
      }
      expect([...seen].some((k) => k.startsWith("cast-")), `${tag}: cast reached (${[...seen].join(", ")})`).toBe(true);
      // Up walks back to Play; the hero (title) is back on screen.
      for (let i = 0; i < 10 && !(await details.locator(".is-focused").textContent())?.match(/play/i); i++) await press(tv, "ArrowUp");
      await expect(details.locator(".is-focused")).toContainText(/play/i);
      await expectInView(tv, `${tag} play again`);
      const h1 = (await details.locator("h1").boundingBox())!;
      expect(h1.y, `${tag}: hero title visible`).toBeGreaterThanOrEqual(0);

      // --- Release picker: a long list stays in view.
      await press(tv, "ArrowRight");
      if (run.design === "projector") {
        // Проектор: Play, [Trailer], Sources.
        for (let i = 0; i < 2 && !/sources/i.test((await focused(tv).textContent()) ?? ""); i++) await press(tv, "ArrowRight");
      }
      if (run.design === "terminal") {
        await tv.locator("[data-media-id] [role=button]", { hasText: "⋯" }).click();
        await press(tv, "Enter"); // More → Choose a source
      } else await press(tv, "Enter");
      const rows = tv.locator("[data-testid=release-picker] [data-release-id]");
      await expect(rows.first()).toHaveClass(/is-focused/, { timeout: 15_000 });
      await press(tv, "ArrowDown", 8);
      await expectInView(tv, `${tag} picker row 9`);
      await press(tv, "Escape");
      await expect(tv.getByTestId("release-picker")).toHaveCount(0);

      // --- Movie Details: Down through every section and back.
      await press(tv, "Escape");
      expect(await open(movie.id)).toBe(true);
      const mDetails = tv.locator(`[data-media-id="${movie.id}"]`);
      await expect(mDetails.locator(".is-focused")).toContainText(/play/i, { timeout: 20_000 });
      for (let i = 0; i < 5; i++) {
        const before = await focusKey(tv);
        await press(tv, "ArrowDown");
        if ((await focusKey(tv)) === before) break;
        await expectInView(tv, `${tag} movie section ${i + 1}`);
      }
      for (let i = 0; i < 8 && !(await mDetails.locator(".is-focused").textContent())?.match(/play/i); i++) await press(tv, "ArrowUp");
      await expect(mDetails.locator(".is-focused")).toContainText(/play/i);
      await press(tv, "Escape");
      await expect(mDetails).toHaveCount(0);

      // --- Browse grid, Search results, Моё, Messages.
      await tv.locator('[data-menu="movies"]').click();
      await expect(tv.locator("[data-focus-key^=b-] [data-card-id]").first()).toBeVisible({ timeout: 20_000 });
      await tv.locator("[data-focus-key^=b-] [data-card-id]").first().waitFor();
      await press(tv, "ArrowDown", 4);
      await expect.poll(() => focusKey(tv)).toMatch(/^b-/);
      await expectInView(tv, `${tag} browse row 4`);

      await tv.locator('[data-menu="search"]').click();
      await expect(tv.getByText("Search movies and series")).toBeVisible();
      await tv.keyboard.type("star");
      await expect(tv.locator("[data-focus-key^=s-] [data-card-id]").first()).toBeVisible({ timeout: 20_000 });
      // Rightmost key column → the results grid.
      for (let i = 0; i < 9 && !(await focusKey(tv)).startsWith("s-"); i++) await press(tv, "ArrowRight");
      await expect.poll(() => focusKey(tv)).toMatch(/^s-/);
      await press(tv, "ArrowDown", 3);
      await expectInView(tv, `${tag} search row 4`);

      await tv.locator('[data-menu="mine"]').click();
      await expect(tv.locator("[data-focus-key^=m-] [data-card-id]").first()).toBeVisible({ timeout: 20_000 });
      await press(tv, "ArrowDown", 2);
      await expectInView(tv, `${tag} my list row 3`);

      await tv.locator('[data-menu="messages"]').click();
      await expect(tv.locator("[data-message-id]").first()).toBeVisible({ timeout: 20_000 });
      await press(tv, "ArrowDown", 7);
      await expectInView(tv, `${tag} message 8`);
      await tv.locator('[data-menu="home"]').click();
    }

    // --- «Продолжить просмотр» on a series: OK opens Details on the in-progress
    // episode (season pre-selected, Play = «Resume S02E03 · 10:00»), Back → the card.
    const season2 = await (await phoneCtx.request.get(`/api/v1/media/${series.id}/seasons/2?lang=en`)).json();
    const ep3 = season2.episodes[2];
    const progress = {
      media_id: series.id, episode_id: ep3.id, season_number: 2, episode_number: 3, position_seconds: 600, duration_seconds: 2800,
      percent: 0.21, completed: false, completed_at: null, updated_at: new Date().toISOString(), device_id: null,
    };
    await mockBackend(tvCtx, RUNS[0]!, { watchlist });
    await tvCtx.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, (route) => json(route, { items: [{ media: series, progress, next_up: null }] }));
    await tvCtx.route(/\/api\/v1\/media\/[^/]+\/progress/, (route) =>
      json(route, { media_id: series.id, kind: "series", movie: null, episodes: [progress], seasons: [{ season_number: 2, completed: 2, total: 13 }], next_up: null }),
    );
    await tv.reload();
    await expect(tv.locator(`[data-continue-id="${series.id}"]`)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => focusKey(tv)).toContain("row-continue");
    await press(tv, "Enter");
    const cDetails = tv.locator(`[data-media-id="${series.id}"]`);
    await expect(cDetails.locator(".is-focused")).toContainText(/Resume S02E03 · 10:00/, { timeout: 20_000 });
    await expectInView(tv, "continue → play");
    await expect(cDetails.locator('[data-season="2"]')).toHaveClass(/bg-accent/);
    await press(tv, "ArrowDown", 2);
    await expect.poll(() => focusKey(tv)).toBe(`ep-${ep3.id}`);
    await expectInView(tv, "continue → in-progress episode");
    // Back: first to Play (the hero), then Home.
    await press(tv, "Escape");
    await expect(cDetails.locator(".is-focused")).toContainText(/Resume/);
    await press(tv, "Escape");
    await expect(cDetails).toHaveCount(0);
    await expect.poll(() => focusKey(tv)).toContain("row-continue");
  } finally {
    await phone.goto("/devices");
    const card = phone.locator("section", { hasText: deviceName });
    phone.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: /unpair/i }).click();
    await expect(card).toHaveCount(0);
  }
});
