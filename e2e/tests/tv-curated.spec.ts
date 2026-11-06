import { mkdirSync } from "node:fs";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
/** Set SHOTS=1 to save 1920×1080 screenshots (kinozal and constructivism). */
const SHOTS = process.env.SHOTS ? "/repo/e2e/scripts/out/curated-tv" : null;
const LIST = "deleuze-cinema-2";

/**
 * «Подборки» on TV: the Explore section opens a curated list (header with
 * author · source, «N из M просмотрено», the focused film's note under it),
 * OK on a card opens Details and Back returns to the same card; on Home a
 * curated «Для вас» row is titled «Подборка: … · X из Y» and carries ✓ marks.
 * Runs in «Кинозал» and «Конструктивизм».
 */

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
  await tv.waitForTimeout(800);
  await tv.screenshot({ path: `${SHOTS}/${name}.png` });
}

type Item = { note: string | null; rank: number | null; watched: boolean; media: { id: string; title: string; me?: Record<string, unknown> } | null };
type List = { title: string; author: string; count: number; watched: number; items: Item[] };

async function mockBase(ctx: BrowserContext, design: string, rows: unknown[]) {
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
  await ctx.route(/\/api\/v1\/foryou\/rows/, (route) => json(route, { profile_id: "p", generated_at: null, stale: false, cold_start: false, rows }));
}

/** The menu skeleton: «Кинозал» has a side rail, «Конструктивизм» (terminal skeleton) a top bar. */
const rail = async (tv: Page) => (await tv.locator("[data-design-shell]").getAttribute("data-design-shell")) === "kinozal";

async function intoMenu(tv: Page) {
  const key = (await rail(tv)) ? "ArrowLeft" : "ArrowUp";
  const inMenu = () => tv.locator('nav [data-nav-focused="1"]').count();
  await expect.poll(async () => (await inMenu()) + (await tv.locator(".is-focused").count())).toBeGreaterThan(0);
  for (let i = 0; i < 14 && !(await inMenu()); i++) await press(tv, key);
  await expect(tv.locator('nav [data-nav-focused="1"]')).toHaveCount(1);
}

async function pick(tv: Page, id: string) {
  const side = await rail(tv);
  const order = await tv.locator("nav [data-menu]").evaluateAll((els) => els.map((e) => e.getAttribute("data-menu")));
  for (let i = 0; i < 14; i++) {
    const cur = await tv.locator('nav [data-nav-focused="1"]').getAttribute("data-menu");
    if (cur === id) break;
    const forward = order.indexOf(id) > order.indexOf(cur);
    await press(tv, side ? (forward ? "ArrowDown" : "ArrowUp") : forward ? "ArrowRight" : "ArrowLeft");
  }
  await expect(tv.locator(`nav [data-menu="${id}"]`)).toHaveAttribute("data-nav-focused", "1");
  await press(tv, "Enter");
}

const noteOf = (it: Item) => [it.rank != null ? `№ ${it.rank}` : null, it.note].filter(Boolean).join(" · ");

test("TV curated lists: Explore section, list header and notes, Details and back, Home row", async ({ browser }) => {
  test.setTimeout(300_000);
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: "ru-RU" });
  await tvCtx.addInitScript(() => localStorage.setItem("martytv.locale", "ru"));
  const phone = await phoneCtx.newPage();
  const tv = await tvCtx.newPage();

  await phone.goto("/login");
  await phone.getByLabel(/username/i).fill(USER);
  await phone.getByLabel(/password/i).fill(PASS);
  await phone.getByRole("button", { name: /sign in/i }).click();
  await expect(phone.getByRole("heading", { name: /welcome/i })).toBeVisible();
  const pid = (await (await phoneCtx.request.get("/api/v1/profiles")).json()).items[0].id as string;
  const list = (await (await phoneCtx.request.get(`/api/v1/curated/${LIST}?lang=ru&profile_id=${pid}`)).json()) as List;
  const inCatalog = list.items.filter((it) => it.media);
  expect(inCatalog.length).toBeGreaterThan(1);

  // A curated «Для вас» row built from the real list (its first title marked watched).
  const media = inCatalog.map((it, i) => ({ ...it.media!, me: { ...(it.media!.me ?? {}), progress_percent: null, completed: i === 0, in_watchlist: false, favorite: false, rating: null } }));
  const reason = { type: "popular", text: "", media_id: null, media_title: null, person_tmdb_id: null, person_name: null, genre_ids: [], genre_names: [], collection_id: null, collection_title: null, mood: null };
  const rows = [
    {
      id: `curated:${LIST}`,
      kind: "curated",
      title: list.title,
      reason,
      items: media.map((m) => ({ media: m, score: 1, reason })),
      curated: { list_id: LIST, title: list.title, author: list.author, count: list.count, watched: 1 },
    },
  ];

  await mockBase(tvCtx, "kinozal", rows);
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Curated TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  try {
    if (await tv.getByRole("heading", { name: /кто смотрит|who's watching/i }).isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");

    for (const design of ["kinozal", "constructivism"]) {
      await mockBase(tvCtx, design, rows);
      await tv.reload();
      await expect(tv.locator("[data-design-shell]")).toBeVisible({ timeout: 30_000 });

      // ---- Home: «Подборка: … · 1 из N» with the ✓ on the watched title.
      const row = tv.locator(`[data-row="fy-curated:${LIST}"]`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row).toContainText(`Подборка: ${list.title} · 1 из ${list.count}`);
      await expect(row.locator(`[data-card-id="${media[0]!.id}"] [data-watched]`)).toBeVisible();
      await expect(row.locator(`[data-card-id="${media[1]!.id}"] [data-watched]`)).toHaveCount(0);
      await shot(tv, `${design}-home`);

      // ---- Explore → «Подборки» section → the Deleuze list.
      await intoMenu(tv);
      await pick(tv, "explore");
      await expect(tv.getByTestId("explore")).toBeVisible({ timeout: 20_000 });
      const section = tv.locator("[data-section=curated]");
      await expect(section.locator(`[data-tile="curated:${LIST}"]`)).toBeVisible({ timeout: 20_000 });
      await expect(section.locator(`[data-tile="curated:${LIST}"]`)).toContainText(list.author.split(" / ")[0]!);
      await expect(section.locator(`[data-tile="curated:${LIST}"] [data-progress-label]`)).toHaveText(`${list.watched} / ${list.count}`);
      for (let i = 0; i < 10 && !(await focusKey(tv)).startsWith("x-curated-"); i++) await press(tv, "ArrowDown");
      for (let i = 0; i < 10 && (await focusKey(tv)) !== `x-curated-curated:${LIST}`; i++) await press(tv, "ArrowRight");
      expect(await focusKey(tv)).toBe(`x-curated-curated:${LIST}`);
      await shot(tv, `${design}-explore`);
      await press(tv, "Enter");

      // ---- The list: title, author · source, progress, the first film's note.
      const screen = tv.getByTestId("curated");
      await expect(screen).toBeVisible();
      await expect(tv.getByTestId("curated-title")).toContainText(list.title);
      await expect(screen).toContainText(list.author);
      await expect(tv.getByTestId("curated-progress")).toHaveText(new RegExp(`^${list.watched} из ${list.count} просмотрено$`));
      await expect.poll(() => focusKey(tv)).toBe(`xq-${inCatalog[0]!.media!.id}`);
      await expect(tv.getByTestId("curated-note")).toHaveText(noteOf(inCatalog[0]!));
      await shot(tv, `${design}-list`);

      // Right: the focus and the note follow the next card.
      await press(tv, "ArrowRight");
      await expect.poll(() => focusKey(tv)).toBe(`xq-${inCatalog[1]!.media!.id}`);
      await expect(tv.getByTestId("curated-note")).toHaveText(noteOf(inCatalog[1]!));
      if (noteOf(inCatalog[0]!) !== noteOf(inCatalog[1]!)) await expect(tv.getByTestId("curated-note")).not.toHaveText(noteOf(inCatalog[0]!));

      // OK opens Details of exactly that title; Back returns to the same card.
      await press(tv, "Enter");
      await expect(tv.locator("[data-media-id]")).toHaveAttribute("data-media-id", inCatalog[1]!.media!.id, { timeout: 20_000 });
      await press(tv, "Escape");
      await expect(screen).toBeVisible();
      await expect.poll(() => focusKey(tv)).toBe(`xq-${inCatalog[1]!.media!.id}`);
      await expect(tv.getByTestId("curated-note")).toHaveText(noteOf(inCatalog[1]!));

      // Back (grid → menu → Explore) lands on the list's tile again.
      await press(tv, "Escape");
      await press(tv, "Escape");
      await expect(tv.getByTestId("explore")).toBeVisible();
      await expect.poll(() => focusKey(tv)).toBe(`x-curated-curated:${LIST}`);
      await press(tv, "Escape");
    }
  } finally {
    const origin = new URL(phone.url()).origin;
    const session = await (await phoneCtx.request.get("/api/v1/auth/session")).json();
    const devs = await (await phoneCtx.request.get("/api/v1/devices")).json();
    const dev = devs.items.find((d: { name: string }) => d.name === deviceName);
    if (dev) await phoneCtx.request.delete(`/api/v1/devices/${dev.id}`, { headers: { "X-CSRF-Token": session.csrf_token, Origin: origin } });
    await phoneCtx.close();
    await tvCtx.close();
  }
});
