import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function press(tv: Page, key: string, times = 1) {
  for (let i = 0; i < times; i++) {
    await tv.keyboard.press(key);
    await tv.waitForTimeout(170);
  }
}
const focusKey = (tv: Page) => tv.evaluate(() => (window as unknown as { __focusKey: () => string }).__focusKey());

const DESIGNS = [
  { design: "kinozal", rail: true },
  { design: "wireframe", rail: false },
  { design: "terminal", rail: false },
] as const;

const SHOW = {
  id: "8d2f7a3e-1111-4c4c-9a9a-000000000001",
  kind: "series",
  tmdb_id: 990001,
  title: "Mock Show",
  original_title: "Mock Show",
  year: 2024,
  release_date: "2024-01-01",
  overview: "",
  poster_path: null,
  backdrop_path: null,
  rating: 7.5,
  vote_count: 100,
  genre_ids: [18],
};
const day = (off: number) => new Date(Date.now() + off * 86_400_000).toISOString().slice(0, 10);
const episode = (id: string, s: number, e: number, name: string, air: string) => ({
  id,
  season_number: s,
  episode_number: e,
  name,
  overview: "",
  air_date: air,
  runtime: 45,
  still_path: null,
  rating: null,
});
const EP_NEW = "8d2f7a3e-2222-4c4c-9a9a-000000000023";
const EP_OLD = "8d2f7a3e-2222-4c4c-9a9a-000000000022";

/** Profile settings (design), empty home extras, the new-episodes list, releases and a failing source. */
async function mockBackend(ctx: BrowserContext, design: string, log: { seen: unknown[]; releases: string[] }) {
  await ctx.unrouteAll({ behavior: "ignoreErrors" });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
    if (route.request().method() !== "GET") return json(route, {});
    const res = await route.fetch().catch(() => null);
    const body = res && res.ok() ? await res.json() : {};
    return json(route, { ...body, design, theme: "dark", onboarding_completed: true });
  });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, (route) => json(route, { items: [] }));
  await ctx.route(/\/api\/v1\/recommendations\/inbox/, (route) => json(route, { items: [], unseen: 0 }));
  await ctx.route(/\/api\/v1\/messages(\?.*)?$/, (route) => json(route, { items: [], unread: 0 }));
  await ctx.route(/\/api\/v1\/foryou\/rows/, (route) => json(route, { profile_id: "p", generated_at: null, stale: false, cold_start: true, rows: [] }));
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/new-episodes\/seen/, (route) => {
    log.seen.push(route.request().postDataJSON());
    return route.fulfill({ status: 204 });
  });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/new-episodes(\?.*)?$/, (route) =>
    json(route, {
      unseen: 1,
      items: [
        { media: SHOW, episode: episode(EP_NEW, 2, 3, "The New One", day(-2)), detected_at: new Date().toISOString(), seen: false, source: "kinopoisk" },
        { media: SHOW, episode: episode(EP_OLD, 2, 2, "Seen Before", day(-9)), detected_at: new Date().toISOString(), seen: true, source: null },
      ],
    }),
  );
  await ctx.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) => {
    log.releases.push(route.request().url());
    return json(route, { items: [], searched_at: new Date().toISOString(), cached: true, indexer_errors: [] });
  });
  await ctx.route(/\/api\/v1\/media\/[^/]+\/online/, (route) => json(route, { items: [], providers: [], searched_at: new Date().toISOString(), cached: true }));
}

/**
 * «Новые серии»: the tab with its unseen badge in every layout, the list
 * (new first, seen dimmed), OK plays the episode (releases searched for
 * S02E03), holding OK → «Скрыть» marks it seen; Home shows the row.
 */
test("TV new episodes: tab, badge, list, play, hide", async ({ browser }) => {
  test.setTimeout(240_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: "en-US" });
  const phone = await phoneCtx.newPage();
  const tv = await tvCtx.newPage();
  const log = { seen: [] as unknown[], releases: [] as string[] };

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

  await mockBackend(tvCtx, "kinozal", log);
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  await phone.getByLabel(/tv name/i).fill(`E2E New Episodes TV ${Date.now()}`);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  try {
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");

    for (const d of DESIGNS) {
      log.seen.length = 0;
      log.releases.length = 0;
      await mockBackend(tvCtx, d.design, log);
      await tv.reload();
      await expect(tv.locator(`[data-design-skin="${d.design}"]`)).toBeVisible({ timeout: 30_000 });
      await expect(tv.locator("[data-row=trending]")).toBeVisible({ timeout: 20_000 });
      // The tab (after «Сериалы»; Проектор: the first icon tab, after the text tabs) with the unseen badge.
      const order = await tv.locator("nav [data-menu]").evaluateAll((els) => els.map((e) => e.getAttribute("data-menu")));
      expect(order[order.indexOf(d.design === "wireframe" ? "mine" : "series") + 1], `${d.design}: tab position`).toBe("new");
      await expect(tv.getByTestId("new-episodes-badge"), `${d.design}: badge`).toContainText("1");
      // Every tab on screen, none overlapping its neighbour (the bar got one more tab).
      const boxes = await tv.locator("nav [data-menu]").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { id: e.getAttribute("data-menu"), l: r.left, r: r.right, t: r.top, b: r.bottom }; }));
      for (const [i, bx] of boxes.entries()) {
        expect(bx.l >= 0 && bx.r <= 1920 && bx.t >= 0 && bx.b <= 1080, `${d.design}: ${bx.id} on screen ${JSON.stringify(bx)}`).toBe(true);
        const nx = boxes[i + 1];
        if (nx && Math.abs(nx.t - bx.t) < 5) expect(nx.l, `${d.design}: ${bx.id} / ${nx.id} overlap`).toBeGreaterThanOrEqual(bx.r);
        if (nx && d.rail) expect(nx.t, `${d.design}: ${bx.id} / ${nx.id} overlap`).toBeGreaterThanOrEqual(bx.b);
      }
      // Home: the «New episodes» row with the new episode's series.
      await expect(tv.locator("[data-row=new]")).toBeVisible();

      // Into the menu, then step to «Новые» one tab at a time (none skipped).
      await press(tv, "Escape");
      await expect.poll(() => focusKey(tv)).toBe("menu-home");
      const from = order.indexOf("home");
      const to = order.indexOf("new");
      for (let i = from + 1; i <= to; i++) {
        await press(tv, d.rail ? "ArrowDown" : "ArrowRight");
        await expect.poll(() => focusKey(tv), { message: `${d.design}: tab ${order[i]}` }).toBe(`menu-${order[i]}`);
      }
      await press(tv, "Enter");
      const screen = tv.getByTestId("new-episodes");
      await expect(screen).toBeVisible();
      await expect(screen.locator("[data-new-episode]")).toHaveCount(2);
      await expect(screen.locator(`[data-new-episode="${EP_NEW}"]`)).toHaveAttribute("data-seen", "0");
      await expect(screen.locator(`[data-new-episode="${EP_OLD}"]`)).toHaveAttribute("data-seen", "1");
      await expect(screen).toContainText("S02E03");
      await expect(screen).toContainText(/aired 2 days ago/);
      await expect(screen.locator(`[data-new-episode="${EP_NEW}"] [data-source=kinopoisk]`)).toHaveText("Kinopoisk");
      await expect.poll(() => focusKey(tv)).toBe(`ne-${EP_NEW}`);
      // Up: «Mark all as seen», Down back to the episode.
      await press(tv, "ArrowUp");
      await expect.poll(() => focusKey(tv)).toBe("ne-all");
      await press(tv, "ArrowDown");
      await expect.poll(() => focusKey(tv)).toBe(`ne-${EP_NEW}`);

      // Hold OK → menu → «Hide».
      await tv.keyboard.down("Enter");
      await tv.waitForTimeout(900);
      await tv.keyboard.up("Enter");
      const menu = tv.getByTestId("new-episode-menu");
      await expect(menu).toBeVisible();
      await expect(menu).toContainText("S02E03");
      await press(tv, "ArrowDown", 3);
      await press(tv, "Enter");
      await expect(menu).toHaveCount(0);
      await expect.poll(() => log.seen).toEqual([{ episode_ids: [EP_NEW] }]);

      // OK plays that episode: releases are searched for S02E03.
      await expect.poll(() => focusKey(tv)).toBe(`ne-${EP_NEW}`);
      await press(tv, "Enter");
      await expect.poll(() => log.releases.some((u) => /season=2/.test(u) && /episode=3/.test(u)), { timeout: 15_000 }).toBe(true);
      // Leave the player (no release: the picker / failed screen) back to the list.
      for (let i = 0; i < 4 && !(await screen.isVisible()); i++) await press(tv, "Escape");
      await expect(screen).toBeVisible();
    }
  } finally {
    const devices = await (await phoneCtx.request.get("/api/v1/devices")).json();
    const csrf = (await (await phoneCtx.request.get("/api/v1/auth/session")).json()).csrf_token;
    for (const dv of devices.items.filter((x: { name: string }) => x.name.startsWith("E2E New Episodes TV"))) {
      await phoneCtx.request.delete(`/api/v1/devices/${dv.id}`, { headers: { "X-CSRF-Token": csrf, Origin: origin } });
    }
    await phoneCtx.close();
    await tvCtx.close();
  }
});
