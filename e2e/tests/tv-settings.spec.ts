import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

async function press(tv: Page, key: string, times = 1) {
  for (let i = 0; i < times; i++) {
    await tv.keyboard.press(key);
    await tv.waitForTimeout(160);
  }
}

/** Is the element focused (a settings row's is-focused, or a menu item's data-nav-focused)? */
const focused = (l: ReturnType<Page["locator"]>) => l.evaluate((el) => /is-focused/.test(el.className) || el.getAttribute("data-nav-focused") === "1").catch(() => false);
/** Presses `key` until `target` is focused (menus and settings grow, so no fixed counts); the cap only stops a stuck walk. */
async function walkTo(tv: Page, target: ReturnType<Page["locator"]>, key = "ArrowDown", cap = 40) {
  for (let i = 0; i < cap && !(await focused(target)); i++) await press(tv, key);
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** A release and a source that stays "preparing" (the loading screen stays up). */
async function mockPreparing(ctx: BrowserContext, mediaId: () => string) {
  const rel = {
    id: "rel-1", title: "Mock.Release", indexer: "MockTracker", size_bytes: 2_000_000_000, seeders: 50, leechers: 1, published_at: null, info_hash: null,
    resolution: "1080p", video_codec: "h264", hdr: null, audio_codecs: ["aac"], languages: ["en"], voiceovers: [], release_group: null,
    source_quality: "web-dl", year: 1999, seasons: [], episodes: [], is_season_pack: false, confidence: 0.9, score: 1, reasons: [], warnings: [],
  };
  let n = 0;
  const src = () => ({
    id: "5e1f0000-0000-4000-8000-0000000000d1", media_id: mediaId(), episode_id: null, release: rel, status: "preparing", error: null, file: null,
    stream_url: null, stream_expires_at: null, mime_type: null, media_info: null,
    torrent: { peers: 7, seeders: 5, download_speed_bps: 2_000_000, preloaded_bytes: ++n * 3_000_000 }, created_at: new Date().toISOString(),
  });
  // Online sources answer live in dev: keep Details hermetic (no «Смотреть онлайн» button).
  await ctx.route(/\/api\/v1\/media\/[^/]+\/online/, (route) => json(route, { items: [], providers: [], searched_at: new Date().toISOString(), cached: true }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) => json(route, { items: [rel], searched_at: new Date().toISOString(), cached: false, indexer_errors: [] }));
  await ctx.route(/\/api\/v1\/playback\/sources(\/[^/?]+)?(\?.*)?$/, (route) => json(route, src(), route.request().method() === "POST" ? 201 : 200));
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, (route) => json(route, { items: [] }));
  await ctx.route(/\/api\/v1\/messages(\?.*)?$/, (route) => json(route, { items: [], unread: 0 }));
  // «Для вас» rows (family, «Подборка»…) vary with live data and would push the catalog rows out of Home's render window.
  await ctx.route(/\/api\/v1\/foryou\/rows/, (route) => json(route, { profile_id: "p", generated_at: null, stale: false, cold_start: true, rows: [] }));
}

const htmlClass = (tv: Page) => tv.evaluate(() => document.documentElement.className);

/**
 * Phase 5 TV settings: the first-run guide (Skip/Finish marks the profile
 * done on the server), Settings in the side menu — theme switches the
 * <html> class at once and is saved; the loading style picks the loader
 * that the preparing screen uses.
 */
test("TV settings: first-run guide, theme, loading style", async ({ browser }) => {
  test.setTimeout(180_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US", colorScheme: "dark" });
  const phone = await phoneCtx.newPage();
  const tv = await tvCtx.newPage();

  await phone.goto("/login");
  await phone.getByLabel(/username/i).fill(USER);
  await phone.getByLabel(/password/i).fill(PASS);
  await phone.getByRole("button", { name: /sign in/i }).click();
  await expect(phone.getByRole("heading", { name: /welcome/i })).toBeVisible();

  const origin = new URL(phone.url()).origin;
  const session = await (await phoneCtx.request.get("/api/v1/auth/session")).json();
  const headers = { "X-CSRF-Token": session.csrf_token, Origin: origin };
  let profiles = await (await phoneCtx.request.get("/api/v1/profiles")).json();
  if (profiles.items.length === 0) {
    expect((await phoneCtx.request.post("/api/v1/profiles", { data: { name: "E2E", color: "#6366f1" }, headers })).ok()).toBeTruthy();
    profiles = await (await phoneCtx.request.get("/api/v1/profiles")).json();
  }
  const ids = (profiles.items as { id: string }[]).map((p) => p.id);
  const original = new Map<string, unknown>();
  for (const id of ids) {
    original.set(id, await (await phoneCtx.request.get(`/api/v1/profiles/${id}/settings`)).json());
    const r = await phoneCtx.request.put(`/api/v1/profiles/${id}/settings`, { data: { onboarding_completed: false, design: "kinozal", theme: "dark", loading_style: "popcorn", taste_note: "", min_votes: 100 }, headers });
    expect(r.ok(), await r.text()).toBeTruthy();
  }
  const search = await (await phoneCtx.request.get(`/api/v1/catalog/search?q=${encodeURIComponent("The Matrix")}&kind=movie&lang=en`)).json();
  const movieId = search.items[0].id as string;
  await mockPreparing(tvCtx, () => movieId);

  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Settings TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  try {
    const devices = await (await phoneCtx.request.get("/api/v1/devices")).json();
    const deviceId = devices.items.find((d: { name: string }) => d.name === deviceName).id as string;
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");
    const me = await tv.evaluate(() => localStorage.getItem("martytv.profile_id"));
    expect(me).toBeTruthy();

    // --- First-run guide: step 1 (look), change the theme live, Next → step 2 previews loaders.
    const guide = tv.getByTestId("tv-onboarding");
    await expect(guide).toHaveAttribute("data-step", "1", { timeout: 30_000 });
    await expect(guide.locator("[data-setting=design]")).toHaveClass(/is-focused/);
    await press(tv, "ArrowDown");
    await expect(guide.locator("[data-setting=theme]")).toHaveClass(/is-focused/);
    await press(tv, "ArrowRight"); // dark → light
    await expect.poll(() => htmlClass(tv)).toContain("theme-light");
    await press(tv, "ArrowLeft"); // back to dark
    await expect.poll(() => htmlClass(tv)).toContain("theme-dark");
    await press(tv, "ArrowDown", 3); // language → actions (Next focused)
    await expect(guide.locator("[data-action=next]")).toHaveClass(/is-focused/);
    await press(tv, "Enter");
    await expect(guide).toHaveAttribute("data-step", "2");
    await expect(guide.locator("[data-testid=loader-preview][data-loader=popcorn]")).toBeVisible();
    // Skip: closes and marks the profile done on the server.
    await press(tv, "ArrowDown");
    await press(tv, "ArrowLeft");
    await expect(guide.locator("[data-action=skip]")).toHaveClass(/is-focused/);
    await press(tv, "Enter");
    await expect(guide).toHaveCount(0);
    await expect
      .poll(async () => (await (await phoneCtx.request.get(`/api/v1/profiles/${me}/settings`)).json()).onboarding_completed)
      .toBe(true);
    await expect(tv.getByText("Trending this week")).toBeVisible({ timeout: 30_000 });

    // --- Settings from the side menu.
    await press(tv, "ArrowLeft");
    // Rail: search, home, explore, movies, series, … settings (last): walk down until it's focused.
    const settingsItem = tv.locator("nav [data-menu=settings]");
    await walkTo(tv, settingsItem);
    await expect(settingsItem).toHaveAttribute("data-nav-focused", "1");
    await press(tv, "Enter");
    const settings = tv.getByTestId("tv-settings");
    await expect(settings).toBeVisible();
    await expect(settings.locator("[data-setting=design]")).toHaveClass(/is-focused/);
    const theme = settings.locator("[data-setting=theme]");
    await walkTo(tv, theme);
    await expect(theme).toHaveClass(/is-focused/);
    await press(tv, "ArrowRight");
    await expect(theme).toHaveAttribute("data-value", "light");
    await expect.poll(() => htmlClass(tv)).toContain("theme-light");
    await expect
      .poll(async () => (await (await phoneCtx.request.get(`/api/v1/profiles/${me}/settings`)).json()).theme)
      .toBe("light");
    await press(tv, "ArrowRight");
    await expect(theme).toHaveAttribute("data-value", "system");
    await press(tv, "ArrowRight");
    await expect(theme).toHaveAttribute("data-value", "dark");
    await expect.poll(() => htmlClass(tv)).toContain("theme-dark");

    // Loading style: the focused row shows a live preview; pick "film_reel".
    const style = settings.locator("[data-setting=loading_style]");
    await walkTo(tv, style);
    await expect(style).toHaveClass(/is-focused/);
    await expect(settings.locator("[data-testid=loader-preview]")).toHaveAttribute("data-loader", "popcorn");
    for (let i = 0; i < 5 && (await style.getAttribute("data-value")) !== "film_reel"; i++) await press(tv, "ArrowRight");
    await expect(style).toHaveAttribute("data-value", "film_reel");
    await expect(settings.locator("[data-testid=loader-preview]")).toHaveAttribute("data-loader", "film_reel");
    // One press = one change of the preview (it used to flip back and restart
    // when an older save's answer arrived after a quicker press).
    await tv.evaluate(() => {
      const w = window as unknown as { __loaders: string[] };
      w.__loaders = [];
      const seen = () => {
        const v = document.querySelector("[data-testid=loader-preview]")?.getAttribute("data-loader") ?? "";
        if (w.__loaders[w.__loaders.length - 1] !== v) w.__loaders.push(v);
      };
      seen();
      new MutationObserver(seen).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-loader"] });
    });
    // Saves take a while on a real TV's Wi-Fi: answers arrive after the next press.
    const slowSave = /\/api\/v1\/profiles\/[^/]+\/settings$/;
    await tv.route(slowSave, async (route) => {
      if (route.request().method() === "PUT") await new Promise((r) => setTimeout(r, 600));
      await route.continue();
    });
    await tv.keyboard.press("ArrowRight");
    await tv.waitForTimeout(150);
    await tv.keyboard.press("ArrowRight");
    await tv.waitForTimeout(2500);
    await tv.unroute(slowSave);
    const seq = await tv.evaluate(() => (window as unknown as { __loaders: string[] }).__loaders);
    expect(seq.length, `preview sequence ${seq.join(" → ")}`).toBe(3);
    expect(new Set(seq).size, `no flip back: ${seq.join(" → ")}`).toBe(3);
    // Back to film_reel for the rest of the test.
    await press(tv, "ArrowLeft", 2);
    await expect(style).toHaveAttribute("data-value", "film_reel");

    // «О моих вкусах»: the row shows the note; OK opens the on-screen keyboard
    // (with the "easier from the phone" hint); typing + Save stores it.
    const note = settings.locator("[data-setting=taste_note]");
    await walkTo(tv, note); // past holiday animations, poster rating, hide anime/watched, autoplay, spoilers
    await expect(note).toHaveClass(/is-focused/);
    await expect(settings).toContainText(/easier to type on your phone/i);
    await press(tv, "Enter");
    const editor = tv.getByTestId("tv-taste-editor");
    await expect(editor).toBeVisible();
    await press(tv, "Enter"); // the focused key: A
    await tv.keyboard.type(" noir");
    await expect(editor.getByTestId("tv-taste-text")).toHaveText("A noir");
    await press(tv, "ArrowRight", 7); // keyboard → Save
    await press(tv, "Enter");
    await expect(editor).toHaveCount(0);
    await expect(note).toHaveAttribute("data-value", "A noir");
    await expect
      .poll(async () => (await (await phoneCtx.request.get(`/api/v1/profiles/${me}/settings`)).json()).taste_note)
      .toBe("A noir");
    // Back in the list: Down → min votes; Right cycles 100 → 300.
    const minVotes = settings.locator("[data-setting=min_votes]");
    await walkTo(tv, minVotes);
    await expect(minVotes).toHaveClass(/is-focused/);
    await expect(minVotes).toHaveAttribute("data-value", "100");
    await press(tv, "ArrowRight");
    await expect(minVotes).toHaveAttribute("data-value", "300");
    await expect
      .poll(async () => (await (await phoneCtx.request.get(`/api/v1/profiles/${me}/settings`)).json()).min_votes)
      .toBe(300);
    await press(tv, "Escape");
    await expect(settings).toHaveCount(0);

    // --- The preparing screen uses that style.
    const r = await phone.evaluate(
      async ({ deviceId, mediaId }) => {
        const s = await (await fetch("/api/v1/auth/session")).json();
        const res = await fetch(`/api/v1/devices/${deviceId}/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": s.csrf_token },
          body: JSON.stringify({ type: "media.open", payload: { media_id: mediaId } }),
        });
        return res.json();
      },
      { deviceId, mediaId: movieId },
    );
    expect(r.ok).toBe(true);
    await expect(tv.locator("[data-media-id] .is-focused")).toContainText(/play/i, { timeout: 20_000 });
    await press(tv, "ArrowRight"); // ☰ sources
    await press(tv, "Enter");
    await expect(tv.locator("[data-testid=release-picker] [data-release-id]").first()).toHaveClass(/is-focused/);
    await press(tv, "Enter");
    const loader = tv.locator("[data-testid=player-preparing][data-loader=film_reel]");
    await expect(loader).toBeVisible();
    await expect(loader).toContainText(/peers/i);
    const p1 = Number(await loader.getAttribute("data-progress"));
    await tv.waitForTimeout(2500);
    expect(Number(await loader.getAttribute("data-progress"))).toBeGreaterThanOrEqual(p1);
    await press(tv, "Escape");
    await expect(tv.getByTestId("player-preparing")).toHaveCount(0);
  } finally {
    for (const [id, s] of original) await phoneCtx.request.put(`/api/v1/profiles/${id}/settings`, { data: s, headers });
    await phone.goto("/devices");
    const card = phone.locator("section", { hasText: deviceName });
    phone.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: /unpair/i }).click();
    await expect(card).toHaveCount(0);
  }
});
