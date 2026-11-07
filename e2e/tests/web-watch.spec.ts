import { expect, test, type Page } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

/**
 * Phase 5 PWA watch features against the real API (TMDB needed for a title):
 * watchlist add/remove, mark watched/unwatched, rating. Continue watching,
 * history-driven "rate what you watched" and the inbox use mocked routes
 * (no real playback/messages in the e2e stack).
 */
test.use({ viewport: { width: 390, height: 844 } });

async function setup(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(USER);
  await page.getByLabel(/password/i).fill(PASS);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
  const req = page.context().request;
  const session = await (await req.get("/api/v1/auth/session")).json();
  const headers = { "X-CSRF-Token": session.csrf_token as string, Origin: new URL(page.url()).origin };
  let profiles = (await (await req.get("/api/v1/profiles")).json()).items;
  if (!profiles.length) {
    expect((await req.post("/api/v1/profiles", { data: { name: "E2E", color: "#6366f1" }, headers })).ok()).toBeTruthy();
    profiles = (await (await req.get("/api/v1/profiles")).json()).items;
  }
  const profileId = profiles[0].id as string;
  await page.evaluate(([u, p]) => localStorage.setItem(`martytv.active_profile.${u}`, p), [session.user.id, profileId]);
  // A movie to work with.
  const search = await (await req.get("/api/v1/catalog/search?q=Inception&kind=movie")).json();
  const movie = search.items[0] as { id: string; title: string; backdrop_path: string | null; poster_path: string | null };
  expect(movie).toBeTruthy();
  return { req, headers, profileId, movie };
}

const progress = (o: Record<string, unknown>) => ({
  episode_id: null,
  season_number: null,
  episode_number: null,
  duration_seconds: 8880,
  completed: false,
  completed_at: null,
  updated_at: new Date().toISOString(),
  device_id: null,
  ...o,
});

test("watchlist, favorites, mark watched and rating on a title", async ({ page }) => {
  const { req, headers, profileId, movie } = await setup(page);
  // Clean state.
  await req.delete(`/api/v1/profiles/${profileId}/lists/watchlist/${movie.id}`, { headers });
  await req.delete(`/api/v1/profiles/${profileId}/ratings/${movie.id}`, { headers });
  await req.put(`/api/v1/media/${movie.id}/watched`, { data: { profile_id: profileId, watched: false }, headers });

  try {
    await page.goto(`/title/${movie.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 20_000 });

    // Watchlist add → visible on the list page and on Home; remove again.
    const wl = page.getByTestId("toggle-watchlist");
    await expect(wl).toHaveAttribute("aria-pressed", "false");
    const added = page.waitForResponse((r) => r.url().includes(`/lists/watchlist/${movie.id}`) && r.request().method() === "PUT");
    await wl.click();
    expect((await added).ok()).toBeTruthy();
    await expect(wl).toHaveAttribute("aria-pressed", "true");
    await page.goto("/lists/watchlist");
    await expect(page.getByTestId("list-watchlist").getByTestId("poster-card").filter({ hasText: movie.title }).first()).toBeVisible();
    await page.goto("/");
    await expect(page.getByTestId("row-watchlist").getByTestId("poster-card").first()).toBeVisible({ timeout: 20_000 });

    await page.goto(`/title/${movie.id}`);
    const removed = page.waitForResponse((r) => r.url().includes(`/lists/watchlist/${movie.id}`) && r.request().method() === "DELETE");
    await page.getByTestId("toggle-watchlist").click();
    expect((await removed).ok()).toBeTruthy();
    await expect(page.getByTestId("toggle-watchlist")).toHaveAttribute("aria-pressed", "false");

    // Mark watched / unwatched.
    const watched = page.getByTestId("toggle-watched");
    await expect(watched).toHaveAttribute("aria-pressed", "false");
    const put = page.waitForRequest((r) => r.url().includes(`/media/${movie.id}/watched`) && r.method() === "PUT");
    await watched.click();
    expect((await put).postDataJSON()).toMatchObject({ profile_id: profileId, watched: true });
    await expect(watched).toHaveAttribute("aria-pressed", "true");
    const p = await (await req.get(`/api/v1/media/${movie.id}/progress?profile_id=${profileId}`)).json();
    expect(p.movie?.completed).toBe(true);
    await expect(page.getByTestId("play-on-tv")).toContainText(/watch again/i);
    await watched.click();
    await expect(watched).toHaveAttribute("aria-pressed", "false");

    // Rating.
    await page.getByTestId("rate-button").click();
    // The 1–10 popover sits above the page (not clipped by the hero): all ten are fully on screen.
    const vp = page.viewportSize()!;
    for (const n of ["1", "10"]) {
      const b = await page.getByTestId("rating-scale").getByRole("radio", { name: n, exact: true }).boundingBox();
      expect(b && b.y >= 0 && b.y + b.height <= vp.height && b.x >= 0 && b.x + b.width <= vp.width).toBeTruthy();
    }
    await expect(page.getByTestId("rating-scale").getByRole("radio", { name: "10", exact: true })).toBeVisible();
    const rated = page.waitForRequest((r) => r.url().includes(`/ratings/${movie.id}`) && r.method() === "PUT");
    await page.getByTestId("rating-scale").getByRole("radio", { name: "8", exact: true }).click();
    expect((await rated).postDataJSON()).toEqual({ rating: 8 });
    await expect(page.getByTestId("rate-button")).toContainText("8");
  } finally {
    await req.delete(`/api/v1/profiles/${profileId}/lists/watchlist/${movie.id}`, { headers });
    await req.delete(`/api/v1/profiles/${profileId}/ratings/${movie.id}`, { headers });
    await req.put(`/api/v1/media/${movie.id}/watched`, { data: { profile_id: profileId, watched: false }, headers });
  }
});

test("continue watching, rate prompt and inbox (mocked)", async ({ page }) => {
  const { req, headers, profileId, movie } = await setup(page);
  const media = { ...movie, me: { progress_percent: 0.42, completed: false, in_watchlist: false, favorite: false, rating: null } };
  await page.route(`**/api/v1/profiles/${profileId}/continue-watching**`, (r) =>
    r.fulfill({
      json: { items: [{ media, progress: progress({ media_id: movie.id, position_seconds: 2530, percent: 0.42 }), next_up: null }] },
    }),
  );
  await page.route(`**/api/v1/profiles/${profileId}/history**`, (r) =>
    r.fulfill({
      json: {
        items: [
          {
            media: { ...media, me: { ...media.me, completed: true, progress_percent: 1 } },
            progress: progress({ media_id: movie.id, position_seconds: 8800, percent: 1, completed: true, completed_at: new Date().toISOString() }),
          },
        ],
        next_cursor: null,
      },
    }),
  );
  await page.route(`**/api/v1/media/${movie.id}/progress**`, (r) =>
    r.fulfill({
      json: {
        media_id: movie.id,
        kind: "movie",
        movie: progress({ media_id: movie.id, position_seconds: 2530, percent: 0.42 }),
        episodes: [],
        seasons: [],
        next_up: null,
      },
    }),
  );
  let read = false;
  await page.route("**/api/v1/messages", (r) =>
    r.fulfill({
      json: {
        items: [{ id: "00000000-0000-4000-8000-0000000000aa", title: "Movie night", body: "Friday 8pm", from_name: "Admin", created_at: new Date().toISOString(), read_at: read ? new Date().toISOString() : null }],
        unread: read ? 0 : 1,
      },
    }),
  );
  await page.route("**/api/v1/messages/*/read", (r) => {
    read = true;
    return r.fulfill({ status: 204 });
  });

  try {
    await page.goto("/");
    // Continue watching comes first and shows progress.
    const row = page.getByTestId("row-continue");
    await expect(row).toBeVisible({ timeout: 20_000 });
    const card = row.getByTestId("continue-card").first();
    await expect(card).toContainText(movie.title);
    await expect(card).toContainText(/left/);

    // Rate prompt from history (rating hits the real API).
    const prompt = page.getByTestId("rate-prompt");
    await expect(prompt).toBeVisible();
    const rated = page.waitForRequest((r) => r.url().includes(`/ratings/${movie.id}`) && r.method() === "PUT");
    await prompt.getByRole("radio", { name: "9", exact: true }).click();
    expect((await rated).postDataJSON()).toEqual({ rating: 9 });
    await expect(page.getByText(/thanks/i)).toBeVisible();

    // Inbox badge → sheet → mark read.
    await expect(page.getByTestId("inbox-badge")).toHaveText("1");
    await page.getByTestId("inbox-button").click();
    const sheet = page.getByTestId("inbox-sheet");
    await expect(sheet).toContainText("Movie night");
    await sheet.getByRole("button", { name: /mark as read/i }).click();
    await expect(page.getByTestId("inbox-badge")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Under the card: resume right here (and «On TV» when there is a TV).
    await expect(card.getByTestId("continue-card-here")).toHaveText(/Here/);
    // ▶ on the card → "Where to watch?" (TV / here / the title page).
    await card.getByTestId("continue-play").click();
    const where = page.getByTestId("continue-sheet");
    await expect(where.getByTestId("continue-here")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(where).toHaveCount(0);
    // Tapping the card itself (not the ▶ in its middle) opens the title page with "Resume at 42:10".
    await card.click({ position: { x: 12, y: 12 } });
    await expect(page).toHaveURL(new RegExp(`/title/${movie.id}`));
    await expect(page.getByTestId("play-on-tv")).toContainText("42:10");
    await page.getByTestId("play-more").click();
    await expect(page.getByTestId("start-over")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("movie-progress")).toBeVisible();
  } finally {
    await req.delete(`/api/v1/profiles/${profileId}/ratings/${movie.id}`, { headers });
  }
});
