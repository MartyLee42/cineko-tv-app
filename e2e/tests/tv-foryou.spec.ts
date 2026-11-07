import { mkdirSync } from "node:fs";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
/** Set SHOTS=1 to save 1920×1080 screenshots of every new screen. */
const SHOTS = process.env.SHOTS ? "/repo/e2e/scripts/out/foryou-tv" : null;

type Design = "kinozal" | "terminal" | "projector";
type Media = { id: string; title: string; kind: string; genre_ids: number[]; [k: string]: unknown };

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function press(tv: Page, key: string, times = 1) {
  for (let i = 0; i < times; i++) {
    await tv.keyboard.press(key);
    await tv.waitForTimeout(170);
  }
}
const focusKey = (tv: Page) => tv.evaluate(() => (window as unknown as { __focusKey: () => string }).__focusKey());

async function shot(tv: Page, name: string) {
  if (!SHOTS) return;
  await tv.waitForTimeout(700);
  await tv.screenshot({ path: `${SHOTS}/${name}.png` });
}

const reason = (p: Record<string, unknown>) => ({
  type: "popular",
  text: "server text",
  media_id: null,
  media_title: null,
  person_tmdb_id: null,
  person_name: null,
  genre_ids: [],
  genre_names: [],
  collection_id: null,
  collection_title: null,
  mood: null,
  ...p,
});

/** Mocked Phase 6 backend built from real catalog titles (Details keeps working). */
function phase6(pool: Media[]) {
  const seed = pool[0]!;
  let rows = [
    {
      id: `byr:${seed.id}`,
      kind: "because_you_rated",
      title: "Server title",
      reason: reason({ type: "because_you_rated", media_id: seed.id, media_title: "The Matrix" }),
      items: pool.slice(1, 9).map((m) => ({ media: m, score: 1, reason: reason({ type: "because_you_rated", media_id: seed.id, media_title: "The Matrix" }) })),
    },
    {
      id: "hidden_gems",
      kind: "hidden_gems",
      title: "Server title",
      reason: reason({ type: "hidden_gem" }),
      items: pool.slice(9, 17).map((m) => ({ media: m, score: 1, reason: reason({ type: "hidden_gem" }) })),
    },
  ];
  const feedback: { action?: string; media_id?: string; events?: { action: string; media_id: string }[] }[] = [];
  const surprises: { exclude_ids?: string[]; kind?: string }[] = [];
  const notes: { url: string; body: { text: string; reasons: string[] } }[] = [];
  // ~300 history entries over 14 months, every third one rated.
  const history = Array.from({ length: 300 }, (_, i) => {
    const m = pool[i % pool.length]!;
    const at = new Date(Date.UTC(2026, 9, 28) - i * 36 * 3600_000).toISOString();
    const id = i < pool.length ? m.id : `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    return {
      media: { ...m, id, title: i < pool.length ? m.title : `${m.title} #${i}`, me: { progress_percent: null, completed: true, in_watchlist: false, favorite: false, rating: i % 3 === 0 ? (i % 10) + 1 : null } },
      progress: { media_id: id, episode_id: null, season_number: null, episode_number: null, position_seconds: 0, duration_seconds: 6000, percent: 1, completed: true, completed_at: at, updated_at: at, device_id: null },
    };
  });
  const collection = {
    id: "11111111-2222-4333-8444-555555555555",
    scope: "profile",
    title: "Rainy evening noir",
    description: "Dark streets, sharp dialogue and rain-soaked city lights.",
    generated_at: new Date().toISOString(),
    model: "deepseek-chat",
    items: pool.slice(0, 12),
  };
  return {
    feedback,
    surprises,
    notes,
    async install(ctx: BrowserContext) {
      await ctx.route(/\/api\/v1\/profiles\/[^/]+\/notes\/[^/?]+$/, (route) => {
        const body = route.request().postDataJSON();
        notes.push({ url: route.request().url(), body });
        return json(route, { media_id: route.request().url().split("/").pop(), ...body, updated_at: new Date().toISOString() });
      });
      await ctx.route(/\/api\/v1\/foryou\/rows/, (route) => json(route, { profile_id: "p", generated_at: new Date().toISOString(), stale: false, cold_start: false, rows }));
      await ctx.route(/\/api\/v1\/foryou\/feedback/, (route) => {
        const body = route.request().postDataJSON();
        feedback.push(body);
        if (body.action === "dismiss") rows = rows.map((r) => ({ ...r, items: r.items.filter((x) => x.media.id !== body.media_id) }));
        return json(route, { accepted: 1 }, 202);
      });
      await ctx.route(/\/api\/v1\/foryou\/surprise(\?.*)?$/, (route) => {
        const body = route.request().postDataJSON();
        surprises.push(body);
        const m = pool[(surprises.length * 5) % pool.length]!;
        return json(route, {
          media: m,
          reason: reason({ type: "director", person_name: "Denis Villeneuve" }),
          source: "pool",
          pool_size: 42,
          reroll: { exclude_ids: [...(body.exclude_ids ?? []), m.id] },
        });
      });
      await ctx.route(/\/api\/v1\/foryou\/explore/, async (route) => {
        const res = await route.fetch().catch(() => null);
        const body = res && res.ok() ? await res.json() : { sections: [] };
        const tile = { id: `collection:${collection.id}`, kind: "collection", title: collection.title, subtitle: "AI", emoji: "🌧", image_path: null, collection_id: collection.id, discover: null };
        return json(route, { sections: [{ id: "collections", kind: "collections", title: "Collections of the day", tiles: [tile] }, ...body.sections] });
      });
      await ctx.route(/\/api\/v1\/foryou\/collections\/[0-9a-f-]{36}/, (route) => json(route, collection));
      await ctx.route(/\/api\/v1\/profiles\/[^/]+\/history/, (route) => {
        const url = new URL(route.request().url());
        const start = Number(url.searchParams.get("cursor") || 0);
        const end = Math.min(history.length, start + 100);
        return json(route, { items: history.slice(start, end), next_cursor: end < history.length ? String(end) : null });
      });
    },
  };
}

async function mockBase(ctx: BrowserContext, design: Design) {
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
}

async function intoMenu(tv: Page, design: Design) {
  const key = design === "kinozal" ? "ArrowLeft" : "ArrowUp";
  const inMenu = () => tv.locator('nav [data-nav-focused="1"]').count();
  await expect.poll(async () => (await inMenu()) + (await tv.locator(".is-focused").count())).toBeGreaterThan(0);
  for (let i = 0; i < 14 && !(await inMenu()); i++) await press(tv, key);
  await expect(tv.locator('nav [data-nav-focused="1"]')).toHaveCount(1);
}

async function pick(tv: Page, design: Design, id: string) {
  const order = await tv.locator("nav [data-menu]").evaluateAll((els) => els.map((e) => e.getAttribute("data-menu")));
  for (let i = 0; i < 14; i++) {
    const cur = await tv.locator('nav [data-nav-focused="1"]').getAttribute("data-menu");
    if (cur === id) break;
    const forward = order.indexOf(id) > order.indexOf(cur);
    await press(tv, design === "kinozal" ? (forward ? "ArrowDown" : "ArrowUp") : forward ? "ArrowRight" : "ArrowLeft");
  }
  await expect(tv.locator(`nav [data-menu="${id}"]`)).toHaveAttribute("data-nav-focused", "1");
  await press(tv, "Enter");
}

/** Holds OK long enough for a card's long-press menu. */
async function holdOk(tv: Page) {
  await tv.keyboard.down("Enter");
  await tv.waitForTimeout(950);
  await tv.keyboard.up("Enter");
  await tv.waitForTimeout(200);
}

/**
 * Phase 6 on the TV, in every design: «Для вас» rows with the reason in the
 * hero and «Не интересно» on the long-press menu; Обзор / Удиви меня! /
 * История in the menu; Explore → AI collection; the History list grouped by
 * month (with rating chips) scrolls and pages; Surprise reveals spoiler-free,
 * then rerolls with the previous picks excluded.
 */
test("TV For you: rows, dismiss, menus, history, explore, surprise in every design", async ({ browser }) => {
  test.setTimeout(420_000);
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: "en-US" });
  const phone = await phoneCtx.newPage();
  const tv = await tvCtx.newPage();

  await phone.goto("/login");
  await phone.getByLabel(/username/i).fill(USER);
  await phone.getByLabel(/password/i).fill(PASS);
  await phone.getByRole("button", { name: /sign in/i }).click();
  await expect(phone.getByRole("heading", { name: /welcome/i })).toBeVisible();
  const home = await (await phoneCtx.request.get("/api/v1/catalog/home?lang=en")).json();
  const seen = new Set<string>();
  const pool: Media[] = [];
  for (const r of home.rows as { items: Media[] }[]) {
    for (const m of r.items) {
      if (seen.has(m.id) || pool.length >= 40) continue;
      seen.add(m.id);
      pool.push(m);
    }
  }
  expect(pool.length).toBeGreaterThan(20);

  await mockBase(tvCtx, "kinozal");
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E ForYou TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  try {
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");

    for (const design of ["kinozal", "terminal", "projector"] as Design[]) {
      const be = phase6(pool);
      await mockBase(tvCtx, design);
      await be.install(tvCtx);
      await tv.reload();
      await expect(tv.locator(`[data-design-shell="${design}"]`)).toBeVisible({ timeout: 30_000 });

      // ---- Home: «Для вас» first (no continue / reco rows), the reason in the hero.
      const fyRow = tv.locator(`[data-row="fy-byr:${pool[0]!.id}"]`);
      await expect(fyRow).toBeVisible({ timeout: 20_000 });
      await expect(fyRow).toContainText("Because you liked “The Matrix”");
      await expect(tv.locator("[data-row=fy-hidden_gems]")).toContainText("Hidden gems");
      await expect.poll(() => focusKey(tv)).toBe(`row-fy-byr:${pool[0]!.id}-${pool[1]!.id}`);
      await expect(tv.getByTestId("hero")).toContainText(/Because you liked “The Matrix”/i);
      await shot(tv, `${design}-home`);

      // ---- «Не интересно» (hold OK → quick actions): the dismiss is sent and the card leaves the row.
      const card = fyRow.locator(`[data-card-id="${pool[1]!.id}"]`);
      await expect(card).toHaveCount(1);
      await holdOk(tv);
      const menu = tv.getByTestId("tv-quick");
      await expect(menu).toBeVisible();
      await expect(menu.locator("[data-quick=dismiss]")).toContainText("Not interested");
      await press(tv, "ArrowDown", 3); // ♥ → watchlist → rating → «Не интересно»
      await expect(menu.locator("[data-quick=dismiss]")).toHaveClass(/is-focused/);
      await press(tv, "Enter");
      await expect(menu).toHaveCount(0);
      await expect(card).toHaveCount(0);
      expect(be.feedback.some((f) => f.action === "dismiss" && f.media_id === pool[1]!.id)).toBe(true);
      // «Почему не интересно?»: reason chips (OK toggles), then «Готово» saves them as the title's note.
      const why = tv.getByTestId("tv-dismiss-why");
      await expect(why).toBeVisible();
      await press(tv, "Enter"); // too slow
      await press(tv, "ArrowRight");
      await press(tv, "Enter"); // too scary
      await expect(why.locator("[data-reason=too_slow]")).toHaveAttribute("data-on", "1");
      await expect(why.locator("[data-reason=too_scary]")).toHaveAttribute("data-on", "1");
      await press(tv, "ArrowDown", 6); // chips → comment → done
      await expect(why.locator("[data-action=done]")).toHaveClass(/is-focused/);
      await press(tv, "Enter");
      await expect(why).toHaveCount(0);
      await expect.poll(() => be.notes.length).toBeGreaterThan(0);
      const saved = be.notes.at(-1)!;
      expect(saved.url).toContain(`/notes/${pool[1]!.id}`);
      expect(saved.body).toEqual({ text: "", reasons: ["too_slow", "too_scary"] });
      // Focus moved to the neighbour, OK still opens Details.
      await expect.poll(() => focusKey(tv)).toBe(`row-fy-byr:${pool[0]!.id}-${pool[2]!.id}`);

      // ---- Menus: the new items exist in this design.
      await intoMenu(tv, design);
      for (const id of ["explore", "surprise", "history"]) await expect(tv.locator(`nav [data-menu="${id}"]`)).toHaveCount(1);
      await shot(tv, `${design}-menu`);

      // ---- History: grouped by month, rating chips, scrolls and loads the next pages.
      await pick(tv, design, "history");
      const list = tv.getByTestId("history-list");
      await expect(list).toBeVisible({ timeout: 20_000 });
      await expect(list.locator('[data-month="2026-10"]')).toContainText("October 2026");
      await expect(list.getByTestId("history-rating").first()).toBeVisible();
      await expect.poll(() => focusKey(tv)).toMatch(/^h-2026-10:/);
      await shot(tv, `${design}-history`);
      await press(tv, "ArrowDown", 24);
      const focused = tv.locator("[data-history-id].is-focused");
      await expect(focused).toHaveCount(1);
      const box = (await focused.boundingBox())!;
      expect(box.y, `${design}: focused history line on screen`).toBeGreaterThan(100);
      expect(box.y + box.height).toBeLessThan(1080);
      await expect(list.locator('[data-month="2026-09"]')).toHaveCount(1);
      await shot(tv, `${design}-history-scrolled`);
      // Back: to the top / the tabs.
      await press(tv, "Escape");
      await expect(tv.locator('nav [data-nav-focused="1"]')).toHaveCount(1);
      await tv.waitForTimeout(400);
      expect((await tv.locator("[data-design-shell] h1").first().boundingBox())!.y).toBeGreaterThan(0);

      // ---- Explore → AI collection.
      await pick(tv, design, "explore");
      await expect(tv.getByTestId("explore")).toBeVisible({ timeout: 20_000 });
      await expect(tv.locator("[data-section=collections]")).toContainText("Rainy evening noir");
      await expect.poll(() => focusKey(tv)).toMatch(/^x-collections-collection:/);
      await shot(tv, `${design}-explore`);
      await press(tv, "Enter");
      await expect(tv.getByTestId("collection")).toContainText("Pick of the day");
      await expect(tv.getByTestId("collection")).toContainText("Rainy evening noir");
      await expect(tv.locator("[data-focus-key^=xc-] [data-card-id]").first()).toBeVisible();
      await shot(tv, `${design}-collection`);
      await press(tv, "Escape"); // grid → menu
      await press(tv, "Escape"); // collection → explore
      await expect(tv.getByTestId("explore")).toBeVisible();

      // ---- Surprise me: spoiler-free result, reveal, reroll.
      await intoMenu(tv, design);
      await pick(tv, design, "surprise");
      await expect(tv.getByTestId("surprise")).toBeVisible();
      await expect.poll(() => focusKey(tv)).toBe("s-mood-any");
      await shot(tv, `${design}-surprise-form`);
      await press(tv, "Enter");
      const result = tv.getByTestId("surprise-result");
      await expect(result).toHaveAttribute("data-revealed", "0");
      await expect(tv.getByTestId("surprise-title")).toHaveText("A mystery pick");
      await expect(result).toContainText("Directed by Denis Villeneuve");
      await expect.poll(() => focusKey(tv)).toBe("s-reveal");
      await shot(tv, `${design}-surprise-hidden`);
      const first = pool[5 % pool.length]!;
      await press(tv, "Enter");
      await expect(result).toHaveAttribute("data-revealed", "1");
      await expect(tv.getByTestId("surprise-title")).toHaveText(first.title);
      await expect.poll(() => focusKey(tv)).toBe("s-watch");
      await shot(tv, `${design}-surprise-revealed`);
      await press(tv, "ArrowRight");
      await expect.poll(() => focusKey(tv)).toBe("s-reroll");
      await press(tv, "Enter");
      await expect(tv.getByTestId("surprise-title")).toHaveText("A mystery pick");
      expect(be.surprises.length).toBe(2);
      expect(be.surprises[1]!.exclude_ids).toEqual([first.id]);
      await press(tv, "Escape");
      await expect(tv.locator('nav [data-nav-focused="1"]')).toHaveCount(1);
      await pick(tv, design, "home");
      await expect(fyRow).toBeVisible();
    }
  } finally {
    await phone.goto("/devices");
    const card = phone.locator("section", { hasText: deviceName });
    phone.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: /unpair/i }).click();
    await expect(card).toHaveCount(0);
  }
});
