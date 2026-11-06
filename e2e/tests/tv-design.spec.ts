import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

type Design = "kinozal" | "terminal" | "projector";

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function press(tv: Page, key: string, times = 1) {
  for (let i = 0; i < times; i++) {
    await tv.keyboard.press(key);
    await tv.waitForTimeout(170);
  }
}

const focusedCard = (tv: Page) => tv.locator("[data-focus-key]:has(.is-focused) [data-card-id]");
async function focusedCardId(tv: Page) {
  await expect(focusedCard(tv)).toHaveCount(1);
  return (await focusedCard(tv).getAttribute("data-card-id"))!;
}

function release(id: string, p: Record<string, unknown> = {}) {
  return {
    id, title: `Mock.Release.${id}`, indexer: "MockTracker", size_bytes: 14 * 1024 ** 3, seeders: 300, leechers: 1, published_at: null, info_hash: null,
    resolution: "1080p", video_codec: "h264", hdr: null, audio_codecs: ["ac3"], languages: ["ru"], voiceovers: [{ kind: "dub", studio: null, language: "ru" }],
    release_group: null, source_quality: "web-dl", year: 2024, seasons: [], episodes: [], is_season_pack: false, confidence: 0.95, score: 1, reasons: [], warnings: [], ...p,
  };
}
const RELEASES = [release("rel-best"), release("rel-4k", { resolution: "2160p", video_codec: "hevc", hdr: "hdr10", size_bytes: 61 * 1024 ** 3 }), release("rel-720", { resolution: "720p" })];

/**
 * Fixed backend answers for this run: the design/rating settings, no
 * continue row or messages, a status, mocked releases (nothing is ever
 * played) and one recommendation in the inbox.
 */
async function mockBackend(ctx: BrowserContext, s: { design: Design; poster_rating: string }, reco: () => unknown) {
  await ctx.unrouteAll({ behavior: "ignoreErrors" });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
    if (route.request().method() !== "GET") return json(route, {});
    const res = await route.fetch().catch(() => null);
    const body = res && res.ok() ? await res.json() : {};
    return json(route, { ...body, ...s, theme: "dark", onboarding_completed: true });
  });
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, (route) => json(route, { items: [] }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/progress/, (route) => json(route, { media_id: "x", kind: "movie", movie: null, episodes: [], seasons: [], next_up: null }));
  await ctx.route(/\/api\/v1\/messages(\?.*)?$/, (route) => json(route, { items: [], unread: 0 }));
  await ctx.route(/\/api\/v1\/status(\?.*)?$/, (route) => json(route, { torrserver: { ok: true, latency_ms: 12 }, prowlarr: { ok: true }, active_streams: 2, server_time: new Date().toISOString() }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) => json(route, { items: RELEASES, searched_at: new Date().toISOString(), cached: true, indexer_errors: [] }));
  await ctx.route(/\/api\/v1\/recommendations\/inbox/, (route) => json(route, { items: [reco()], unseen: 1 }));
  await ctx.route(/\/api\/v1\/recommendations\/[0-9a-f-]{36}(\?.*)?$/, (route) => json(route, reco()));
  await ctx.route(/\/api\/v1\/playback\//, (route) => json(route, { error: { code: "not_found", message: "mocked" } }, 404));
}

/**
 * The three visual designs: each renders its own shell, moves focus with the
 * remote, opens Details (Back restores the card) and shows the auto-selected
 * source (Кинозал), the sources table (Терминал) or the release badges
 * (Проектор); posters carry a rating badge unless switched off; a
 * recommendation appears in «Советуют близкие».
 */
test("TV designs: shells, navigation, details, rating badges, recommendations", async ({ browser }) => {
  test.setTimeout(240_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
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
  const search = await (await phoneCtx.request.get(`/api/v1/catalog/search?q=${encodeURIComponent("Dune")}&kind=movie&lang=en`)).json();
  const recoMedia = search.items[0];
  let seenAt: string | null = null;
  const reco = () => ({
    id: "7ec00000-0000-4000-8000-000000000001",
    media: recoMedia,
    from: { user_id: "7ec00000-0000-4000-8000-0000000000aa", name: "Mom", color: "#e5a50a", avatar: "" },
    to: { user_id: "7ec00000-0000-4000-8000-0000000000bb", name: "E2E", color: "#6366f1", avatar: "" },
    note: "Watch it on the big screen.",
    created_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    seen_at: seenAt,
    reaction: null,
    reply: null,
  });

  await mockBackend(tvCtx, { design: "kinozal", poster_rating: "tmdb" }, reco);
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Design TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  try {
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) await press(tv, "Enter");

    for (const design of ["kinozal", "terminal", "projector"] as Design[]) {
      const ratingsOff = design === "projector";
      await mockBackend(tvCtx, { design, poster_rating: ratingsOff ? "off" : "tmdb" }, reco);
      await tv.reload();
      const shell = tv.locator(`[data-design-shell="${design}"]`);
      await expect(shell).toBeVisible({ timeout: 30_000 });
      await expect(tv.locator(`nav[data-design-nav="${design}"]`)).toBeVisible();
      // Home is up (Trending may sit below the rendered rows now that «For you» / family rows come first).
      await expect(tv.locator("[data-row]").first()).toBeVisible({ timeout: 30_000 });

      // «Recommended by family» (first row: no continue row here) with the sender chip.
      await expect(tv.getByText("Recommended by family").first()).toBeVisible();
      await expect(tv.locator('[data-reco-from="Mom"]').first()).toBeVisible();
      expect(await focusedCardId(tv)).toBe(recoMedia.id);

      // Status: Кинозал's corner / Терминал's ticker.
      if (design === "kinozal") await expect(tv.getByTestId("status-corner")).toHaveAttribute("data-torrserver", "online");
      if (design === "terminal") await expect(tv.getByTestId("status-ticker")).toContainText(/TORRSERVER 12 MS/);

      // Rating badges (TMDB values) unless the setting is off.
      if (ratingsOff) await expect(tv.locator("[data-rating]")).toHaveCount(0);
      else await expect(tv.locator("[data-rating-source=tmdb]").first()).toBeVisible();

      // Remote: right within the row, down to the next row.
      await press(tv, "ArrowDown");
      const first = await focusedCardId(tv);
      await press(tv, "ArrowRight");
      const opened = await focusedCardId(tv);
      expect(opened).not.toBe(first);

      // OK → Details for that card (full-screen: no menu), Back → the same card.
      await press(tv, "Enter");
      const details = tv.locator("[data-media-id]");
      await expect(details).toHaveAttribute("data-media-id", opened);
      await expect(tv.locator("[data-media-id] h1")).not.toBeEmpty({ timeout: 20_000 });
      await expect(tv.locator("[data-media-id] .is-focused")).toContainText(/play/i);
      await expect(tv.locator("nav[data-design-nav]")).toHaveCount(0);
      if (design === "kinozal") {
        const line = tv.getByTestId("source-line");
        await expect(line).toHaveAttribute("data-status", "ok", { timeout: 15_000 });
        await expect(line.locator("[data-release-id]")).toHaveAttribute("data-release-id", "rel-best");
        await expect(line).toContainText("1080p");
      }
      if (design === "terminal") {
        const table = tv.getByTestId("sources-table");
        await expect(table.locator("[data-source-id]")).toHaveCount(3, { timeout: 15_000 });
        await expect(table.locator("[data-best]")).toHaveAttribute("data-source-id", "rel-best");
        await expect(table).toContainText("3 found");
        // One compact fit chip per row for this TV («✓» / «AC3→AAC» / «✗ AC3»).
        await expect(table.locator("[data-best] [data-fit-verdict]")).toBeVisible();
      }
      if (design === "projector") await expect(tv.getByTestId("release-badges")).toContainText("FHD", { timeout: 15_000 });
      await press(tv, "Escape");
      await expect(details).toHaveCount(0);
      await expect.poll(() => focusedCardId(tv)).toBe(opened);
    }

    // The recommended title: OK opens Details with the note and marks it seen.
    let patched = false;
    await tvCtx.route(/\/api\/v1\/recommendations\/[0-9a-f-]{36}(\?.*)?$/, (route) => {
      if (route.request().method() === "PATCH") {
        patched = true;
        seenAt = new Date().toISOString();
      }
      return json(route, reco());
    });
    await press(tv, "ArrowUp");
    await expect.poll(() => focusedCardId(tv)).toBe(recoMedia.id);
    await press(tv, "Enter");
    await expect(tv.getByTestId("reco-note")).toContainText("Mom recommends");
    await expect(tv.getByTestId("reco-note")).toContainText("Watch it on the big screen.");
    await expect.poll(() => patched).toBe(true);

    // «Уточнить поиск»: nothing found → the focused Refine button → own query (+ loose) → uncertain chip.
    let refineQuery: URLSearchParams | null = null;
    // No online variants either (the dev API asks the live online sources).
    await tvCtx.route(/\/api\/v1\/media\/[^/]+\/online/, (route) => json(route, { items: [], providers: [], searched_at: new Date().toISOString(), cached: true }));
    await tvCtx.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) => {
      const u = new URL(route.request().url());
      if (!u.searchParams.get("q")) return json(route, { items: [], searched_at: new Date().toISOString(), cached: false, indexer_errors: [] });
      refineQuery = u.searchParams;
      return json(route, { items: [release("rel-loose", { warnings: ["uncertain_match"], confidence: 0.3 })], searched_at: new Date().toISOString(), cached: false, indexer_errors: [] });
    });
    await tv.locator("[data-media-id] [role=button]", { hasText: /^Sources$/ }).click();
    const refineBtn = tv.locator("[data-testid=release-picker] [role=button]", { hasText: "Refine search" });
    await expect(refineBtn).toHaveClass(/is-focused/, { timeout: 15_000 });
    await press(tv, "Enter");
    await expect(tv.getByTestId("refine-text")).toContainText(recoMedia.title);
    await tv.locator("[data-testid=refine] [role=button]", { hasText: "Uncertain matches" }).click();
    await expect(tv.getByTestId("refine-loose")).toHaveAttribute("data-on", "1");
    await tv.locator("[data-testid=refine] [role=button]", { hasText: /Search$/ }).click();
    await expect(tv.getByTestId("refine")).toHaveCount(0);
    await expect(tv.locator("[data-testid=release-picker] [data-uncertain]")).toBeVisible();
    expect(refineQuery!.get("q")).toContain(recoMedia.title);
    expect(refineQuery!.get("loose")).toBe("true");
  } finally {
    await phone.goto("/devices");
    const card = phone.locator("section", { hasText: deviceName });
    phone.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: /unpair/i }).click();
    await expect(card).toHaveCount(0);
  }
});
