import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

/**
 * «Конструктивизм» on TV: no Marty anywhere (Mayakovsky is the mascot), the
 * «Ленин в Октябре» card first on Home (opens the title), «Рекомендовано
 * Госкино», the red news strip, the five-year plan, renamed tabs, «VOICE OF
 * AMERICA» over «Видео» (not focusable), and the player loader with the
 * hammer and sickle and a changing slogan whatever the loading style. The
 * intro: Mayakovsky, the emblem, «ГОВОРИТ МОСКВА…» and a slogan.
 */

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const MARTY_IMG = /\/(idle|happy|excited|love|music|sleepy|thinking|surprised|error|loading|popcorn|laptop|rain|run|sly)(-anim)?[-.][\w-]*\.webp/;

async function press(tv: Page, key: string, times = 1) {
  for (let i = 0; i < times; i++) {
    await tv.keyboard.press(key);
    await tv.waitForTimeout(170);
  }
}
const focusKey = (tv: Page) => tv.evaluate(() => (window as unknown as { __focusKey: () => string }).__focusKey());

const RELEASES = [1, 2].map((i) => ({
  id: `rel-${i}`, title: `Mock.Release.${i}`, indexer: "MockTracker", size_bytes: (2 + i) * 1024 ** 3, seeders: 100 - i, leechers: 1, published_at: null, info_hash: null,
  resolution: "1080p", video_codec: "h264", hdr: null, audio_codecs: ["ac3"], languages: ["ru"], voiceovers: [{ kind: "dub", studio: null, language: "ru" }],
  release_group: null, source_quality: "web-dl", year: 1937, seasons: [], episodes: [], is_season_pack: false, confidence: 0.95, score: 1, reasons: [], warnings: [],
}));

async function mockBackend(ctx: BrowserContext, design: string) {
  await ctx.unrouteAll({ behavior: "ignoreErrors" });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
    if (route.request().method() !== "GET") return json(route, {});
    const res = await route.fetch().catch(() => null);
    const body = res && res.ok() ? await res.json() : {};
    // «Марти» loading style: the design must replace it with its poster loader.
    return json(route, { ...body, design, theme: "dark", onboarding_completed: true, loading_style: "marty" });
  });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, (route) => json(route, { items: [] }));
  await ctx.route(/\/api\/v1\/recommendations\/inbox/, (route) => json(route, { items: [], unseen: 0 }));
  await ctx.route(/\/api\/v1\/messages(\?.*)?$/, (route) => json(route, { items: [], unread: 0 }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) => json(route, { items: RELEASES, searched_at: new Date().toISOString(), cached: true, indexer_errors: [] }));
  // Playback never answers: the loader stays up.
  await ctx.route(/\/api\/v1\/playback\//, () => {});
  await ctx.route(/\/api\/v1\/foryou\/rows/, (route) => json(route, { profile_id: "p", generated_at: null, stale: false, cold_start: true, rows: [] }));
}

async function noMarty(tv: Page, where: string) {
  const mascots = await tv.locator("[data-mascot]").evaluateAll((els) => els.map((e) => e.getAttribute("data-mascot")));
  expect(mascots.filter((m) => m !== "mayakovsky"), `${where}: only Mayakovsky`).toEqual([]);
  const srcs = await tv.locator("img").evaluateAll((els) => els.map((e) => (e as HTMLImageElement).currentSrc || (e as HTMLImageElement).src));
  expect(srcs.filter((s) => MARTY_IMG.test(s)), `${where}: no Marty images`).toEqual([]);
}

test("TV constructivism: Lenin card, Госкино, news, plan, tabs, VOA, poster loader — no Marty", async ({ browser }) => {
  test.setTimeout(240_000);
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
  const origin = new URL(phone.url()).origin;
  const session = await (await phoneCtx.request.get("/api/v1/auth/session")).json();
  const profiles = await (await phoneCtx.request.get("/api/v1/profiles")).json();
  if (profiles.items.length === 0) {
    expect((await phoneCtx.request.post("/api/v1/profiles", { data: { name: "E2E", color: "#6366f1" }, headers: { "X-CSRF-Token": session.csrf_token, Origin: origin } })).ok()).toBeTruthy();
  }

  await mockBackend(tvCtx, "kinozal");
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  await phone.getByLabel(/tv name/i).fill(`E2E Constructivism TV ${Date.now()}`);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  try {
    const picker = tv.getByRole("heading", { name: /who's watching|кто смотрит/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");

    await mockBackend(tvCtx, "constructivism");
    await tv.reload();
    await expect(tv.locator('[data-design-skin="constructivism"]')).toBeVisible({ timeout: 30_000 });
    await expect(tv.locator("html")).toHaveClass(/design-constructivism/);

    // Home: «Рекомендуем к просмотру» first, focus starts on it; Госкино next.
    const lenin = tv.locator('[data-row="cv-lenin"]');
    await expect(lenin).toBeVisible({ timeout: 30_000 });
    await expect(lenin.getByTestId("cv-lenin")).toContainText(/Рекомендуем к просмотру/i);
    await expect(lenin.getByTestId("cv-lenin")).toContainText(/Ленин в Октябре/i);
    await expect.poll(() => focusKey(tv)).toMatch(/^row-cv-lenin-/);
    await expect(tv.locator('[data-row="cv-goskino"]')).toHaveCount(1);
    await expect(tv.locator("[data-row=trending]")).toHaveCount(1);
    await noMarty(tv, "home");

    // The news strip moves (transform), the plan plaque, renamed tabs (data-menu ids unchanged).
    const track = tv.getByTestId("cv-news").locator(".cv-news-track");
    const t1 = await track.evaluate((e) => getComputedStyle(e).transform);
    await tv.waitForTimeout(1200);
    expect(await track.evaluate((e) => getComputedStyle(e).transform)).not.toBe(t1);
    await expect(tv.getByTestId("cv-plan")).toContainText(/Пятилетка/i, { timeout: 20_000 });
    await expect(tv.locator('nav [data-menu="home"]')).toContainText("Главк");
    await expect(tv.locator('nav [data-menu="history"]')).toContainText("Архив");
    await expect(tv.locator('nav [data-menu="search"]')).toContainText("Розыск");
    await expect(tv.locator('nav [data-menu="mine"]')).toContainText("Дефицит");
    // The AI is «Товарищ ЭВМ»; ⚙ is a constructivist pictogram.
    await expect(tv.locator('nav [data-menu="ask"]')).toContainText("Товарищ ЭВМ");
    await expect(tv.locator('nav [data-menu="settings"] [data-cv-icon="gear"]')).toBeVisible();

    // «ударник ★…»: a red slab along the poster's bottom edge (clear of the ✓/♥ marks top-left).
    await expect.poll(() => tv.locator("[data-udarnik]").count(), { timeout: 30_000 }).toBeGreaterThan(0);
    const udarnik = await tv.locator("[data-udarnik]").evaluateAll((els) =>
      els.map((e) => {
        const card = e.closest(".mt-card")!.getBoundingClientRect();
        const r = e.getBoundingClientRect();
        return { top: r.top - card.top, bottom: card.bottom - r.bottom, height: card.height, width: r.width, cardWidth: card.width, text: e.textContent, bg: getComputedStyle(e).backgroundColor };
      }),
    );
    for (const u of udarnik) {
      expect(u.text).toMatch(/ударник ★\d/i);
      expect(u.top, "in the lower part of the card").toBeGreaterThan(u.height / 2);
      expect(u.bottom).toBeLessThanOrEqual(1);
      expect(u.width, "fits the poster").toBeLessThanOrEqual(u.cardWidth);
      expect(u.bg).toBe("rgb(215, 38, 30)");
    }

    // OK on the card opens «Ленин в Октябре».
    await press(tv, "Enter");
    const details = tv.locator("[data-media-id]");
    await expect(details.locator("h1")).toContainText(/Ленин в Октябре/i, { timeout: 20_000 });
    await expect.poll(() => focusKey(tv)).toBe("d-play");
    await noMarty(tv, "details");

    // Buttons: one style — square slabs in condensed capitals on an offset block; primary red,
    // secondary cream; the focused one lifts with the red offset slab. Pictograms, not ▶ / ⋯.
    // Play is the red (focused) slab; «⋯» the last button of the same row.
    const playBtn = details.locator(".tv-focus.bg-accent[role=button]").first();
    const look = (last: boolean) =>
      playBtn.evaluate((p, l) => {
        const e = l ? p.parentElement!.lastElementChild! : p;
        const s = getComputedStyle(e);
        return { radius: s.borderTopLeftRadius, shadow: s.boxShadow, font: s.fontFamily, tt: s.textTransform, bg: s.backgroundColor, tf: s.transform, icon: e.querySelector("[data-cv-icon]")?.getAttribute("data-cv-icon") ?? null };
      }, last);
    // (After the focus transition settles.)
    await expect.poll(async () => (await look(false)).shadow).toContain("14px 14px 0px 9px");
    const play = await look(false);
    expect(play.radius).toBe("0px");
    expect(play.bg).toBe("rgb(215, 38, 30)");
    expect(play.font).toMatch(/Oswald/);
    expect(play.tt).toBe("uppercase");
    expect(play.tf, "focused: lifted").not.toBe("none");
    expect(play.icon).toBe("play");
    const more = await look(true);
    expect(more.radius).toBe("0px");
    expect(more.bg).toBe("rgb(239, 228, 204)");
    expect(more.shadow).toContain("8px 8px 0px");
    expect(more.tf).toBe("none");
    expect(more.icon).toBe("more");

    // Play: the poster loader (style «Марти» is replaced), the emblem, a slogan that changes.
    await press(tv, "Enter");
    const loader = tv.getByTestId("player-preparing");
    await expect(loader).toBeVisible({ timeout: 20_000 });
    await expect(loader).toHaveAttribute("data-cv", "1");
    await expect(loader.getByTestId("cv-loader")).toBeVisible();
    await expect(loader.locator("[data-emblem=hammer-sickle]")).toBeVisible();
    await expect(loader.locator("[data-mascot]")).toHaveCount(0);
    const slogan = loader.getByTestId("cv-slogan");
    const n0 = await slogan.getAttribute("data-n");
    const s0 = await slogan.textContent();
    await expect.poll(() => slogan.getAttribute("data-n"), { timeout: 6000 }).not.toBe(n0);
    expect(await slogan.textContent()).not.toBe(s0);
    await noMarty(tv, "loader");
    await press(tv, "Escape");
    await tv.waitForTimeout(1200);
    if (await loader.count()) await press(tv, "Escape");
    await expect(details.locator("h1")).toBeVisible({ timeout: 15_000 });
    await press(tv, "Escape");
    await expect(lenin).toBeVisible({ timeout: 15_000 });

    // «Видео»: «VOICE OF AMERICA», decorative (no focus key, never focused).
    for (let i = 0; i < 12 && !(await tv.locator('nav [data-nav-focused="1"]').count()); i++) await press(tv, "ArrowUp");
    await expect.poll(() => focusKey(tv)).toBe("menu-home");
    await press(tv, "ArrowRight", 2);
    await expect.poll(() => focusKey(tv)).toBe("menu-video");
    await press(tv, "Enter");
    const voa = tv.getByTestId("cv-voa");
    await expect(voa).toBeVisible({ timeout: 20_000 });
    await expect(voa).toHaveText(/voice of america/i);
    await expect(voa.locator("[data-focus-key]")).toHaveCount(0);
    expect(await voa.getAttribute("data-focus-key")).toBeNull();
    for (const k of ["ArrowDown", "ArrowUp", "ArrowUp", "ArrowRight"]) {
      await press(tv, k);
      expect(await voa.evaluate((e) => e.classList.contains("is-focused") || !!e.querySelector(".is-focused"))).toBe(false);
    }
    await noMarty(tv, "video");

    // «Товарищ ЭВМ»: the Ask screen's title and thinking line; its tiles are cream slabs.
    await tv.evaluate(() => (document.querySelector('nav [data-menu="ask"]') as HTMLElement | null)?.click());
    await expect(tv.getByText(/Спросите Товарища ЭВМ/).first()).toBeVisible({ timeout: 20_000 });
    await expect(tv.getByText(/электронный советчик Госкино/i).first()).toBeVisible();
    const tile = await tv.locator(".tv-chip.bg-surface-2:not(.is-focused)").first().evaluate((e) => ({ radius: getComputedStyle(e).borderTopLeftRadius, bg: getComputedStyle(e).backgroundColor, shadow: getComputedStyle(e).boxShadow }));
    expect(tile.radius).toBe("0px");
    expect(tile.bg).toBe("rgb(239, 228, 204)");
    expect(tile.shadow).toContain("8px 8px 0px");
  } finally {
    await phoneCtx.close();
    await tvCtx.close();
  }
});

test("TV constructivism intro: Mayakovsky, the emblem, «Говорит Москва…», a slogan — no Marty", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript(() => localStorage.setItem("martytv.design", "constructivism"));
  await page.goto("/tv/?intro=1");
  const intro = page.getByTestId("startup-intro");
  await expect(intro).toHaveAttribute("data-design", "constructivism");
  await expect(intro.getByTestId("intro-mayakovsky")).toBeVisible();
  await expect(intro.getByTestId("intro-emblem").locator("[data-emblem=hammer-sickle]")).toBeVisible();
  await expect(intro.getByTestId("intro-broadcast")).toHaveText(/Говорит Москва/i);
  await expect(intro.getByTestId("cv-slogan")).not.toBeEmpty();
  await noMarty(page, "intro");
  await page.keyboard.press("Enter");
  await expect(intro).toHaveCount(0, { timeout: 1000 });
});
