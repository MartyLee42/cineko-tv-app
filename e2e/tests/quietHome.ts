import type { BrowserContext } from "@playwright/test";

/**
 * Empty «Для вас» rows on TV Home. They vary with the dev data that earlier
 * runs leave behind (family picks, «Подборка», AI rows) and push the catalog
 * rows («Trending this week») out of Home's render window.
 */
export async function quietHome(ctx: BrowserContext): Promise<void> {
  await ctx.route(/\/api\/v1\/foryou\/rows/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ profile_id: "p", generated_at: null, stale: false, cold_start: true, rows: [] }),
    }),
  );
}
