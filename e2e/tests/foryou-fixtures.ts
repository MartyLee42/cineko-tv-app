// Shared helpers for web-foryou / web-history: sign-in, real catalog items
// from the dev API, and Phase 6 payloads built from them (the e2e profile is
// a cold start, so personal rows / history / diary are mocked with real titles).
import { expect, type BrowserContext, type Page, type Route } from "@playwright/test";

export const USER = process.env.E2E_USER ?? "e2e-admin";
export const PASS = process.env.E2E_PASS ?? "e2e-password-123";
/** Optional directory for review screenshots (e.g. /repo/e2e/scripts/out/foryou). */
export const SHOTS = process.env.FORYOU_SHOTS;

export type Media = {
  id: string;
  kind: "movie" | "series";
  tmdb_id: number;
  title: string;
  original_title: string;
  year: number | null;
  release_date: string | null;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  rating: number | null;
  vote_count: number;
  kp_rating?: number | null;
  genre_ids: number[];
  me?: { progress_percent: number | null; completed: boolean; in_watchlist: boolean; favorite: boolean; rating: number | null } | null;
};

export const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

export async function login(page: Page, locale?: "ru" | "en") {
  if (locale) await page.addInitScript((l) => localStorage.setItem("martytv.locale", l), locale);
  await page.goto("/login");
  await page.getByLabel(/username|имя пользователя|логин/i).fill(USER);
  await page.getByLabel(/password|пароль/i).fill(PASS);
  await page.getByRole("button", { name: /sign in|войти/i }).click();
  await expect(page.getByRole("heading", { name: /welcome|привет/i })).toBeVisible();
  const req = page.context().request;
  const session = await (await req.get("/api/v1/auth/session")).json();
  const headers = { "X-CSRF-Token": session.csrf_token as string, Origin: new URL(page.url()).origin };
  let profiles = (await (await req.get("/api/v1/profiles")).json()).items as { id: string }[];
  if (!profiles.length) {
    expect((await req.post("/api/v1/profiles", { data: { name: "E2E", color: "#6366f1" }, headers })).ok()).toBeTruthy();
    profiles = (await (await req.get("/api/v1/profiles")).json()).items;
  }
  // Onboarding off for this profile (it would cover the page).
  await req.put(`/api/v1/profiles/${profiles[0]!.id}/settings`, { data: { onboarding_completed: true }, headers });
  return { req, headers, profileId: profiles[0]!.id };
}

/** Real titles (with posters) from the dev catalog. */
export async function realItems(page: Page, lang: "ru" | "en" = "en"): Promise<Media[]> {
  const home = await (await page.context().request.get(`/api/v1/catalog/home?lang=${lang}`)).json();
  const seen = new Set<string>();
  const out: Media[] = [];
  for (const row of home.rows as { items: Media[] }[]) for (const m of row.items) if (m.poster_path && !seen.has(m.id) && seen.add(m.id)) out.push(m);
  expect(out.length, "dev catalog has titles").toBeGreaterThan(12);
  return out;
}

const NO_ME = { progress_percent: null, completed: false, in_watchlist: false, favorite: false, rating: null };

export function reason(type: string, p: Record<string, unknown> = {}) {
  return { type, text: `server:${type}`, media_id: null, media_title: null, person_tmdb_id: null, person_name: null, genre_ids: [], genre_names: [], collection_id: null, collection_title: null, mood: null, ...p };
}

export const COLLECTION_ID = "0b6f7f5e-1c1a-4d8e-9a3f-5a1c2b3d4e5f";

/** Three «Для вас» rows with typed reasons. */
export function forYouRows(profileId: string, items: Media[], ru = false) {
  const m = (x: Media) => ({ ...x, me: NO_ME });
  const src = ru ? "Матрица" : "The Matrix";
  const dir = ru ? "Дени Вильнёв" : "Denis Villeneuve";
  const byr = reason("because_you_rated", { media_id: items[0]!.id, media_title: src });
  const director = reason("director", { person_tmdb_id: 137427, person_name: dir });
  const gem = reason("hidden_gem");
  const coll = reason("ai_collection", { collection_id: COLLECTION_ID, collection_title: ru ? "Кино для дождливого вечера" : "Films for a rainy evening" });
  return {
    profile_id: profileId,
    generated_at: new Date().toISOString(),
    stale: false,
    cold_start: false,
    rows: [
      { id: `byr:${items[0]!.id}`, kind: "because_you_rated", title: "x", reason: byr, items: items.slice(1, 8).map((x) => ({ media: m(x), reason: byr, score: 1 })) },
      { id: "director:137427", kind: "director", title: "x", reason: director, items: items.slice(8, 13).map((x) => ({ media: m(x), reason: director, score: 1 })) },
      { id: "hidden_gems", kind: "hidden_gems", title: "x", reason: gem, items: items.slice(13, 20).map((x) => ({ media: m(x), reason: gem, score: 1 })) },
      { id: `ai:${COLLECTION_ID}`, kind: "ai_collection", title: "x", reason: coll, items: items.slice(20, 26).map((x) => ({ media: m(x), reason: coll, score: 1 })) },
    ],
  };
}

export function collection(items: Media[], ru = false) {
  return {
    id: COLLECTION_ID,
    scope: "profile",
    title: ru ? "Кино для дождливого вечера" : "Films for a rainy evening",
    description: ru ? "Неспешные, тёплые истории, которые хорошо смотреть под шум дождя." : "Slow, warm stories best watched to the sound of rain.",
    generated_at: new Date().toISOString(),
    model: "deepseek-chat",
    items: items.slice(0, 12).map((x) => ({ ...x, me: NO_ME })),
  };
}

/** A deterministic UUID-shaped id. */
export function uid(n: number) {
  const h = n.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${h}`;
}

/** `n` history entries over many months, newest first; every 3rd rated, every 5th a series. */
export function historyItems(items: Media[], n: number) {
  const out = [];
  const start = Date.UTC(2026, 9, 28, 20, 0, 0);
  for (let i = 0; i < n; i++) {
    const base = items[i % items.length]!;
    const at = new Date(start - i * 2.2 * 86400_000).toISOString();
    const series = i % 5 === 4;
    const rating = i % 3 === 0 ? 10 - (i % 7) : null;
    out.push({
      media: { ...base, id: uid(i + 1), kind: series ? "series" : "movie", title: `${base.title} #${i + 1}`, me: { ...NO_ME, completed: true, rating } },
      progress: {
        media_id: uid(i + 1),
        episode_id: null,
        season_number: series ? 1 : null,
        episode_number: series ? 3 : null,
        position_seconds: 0,
        duration_seconds: 6000,
        percent: 1,
        completed: true,
        completed_at: at,
        updated_at: at,
        device_id: null,
      },
    });
  }
  return out;
}

/** Serves /profiles/{id}/history from `all` in cursor pages. */
export async function mockHistory(ctx: BrowserContext | Page, all: unknown[]) {
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/history(\?.*)?$/, (route) => {
    const u = new URL(route.request().url());
    const limit = Number(u.searchParams.get("limit") ?? 30);
    const from = Number(u.searchParams.get("cursor") || 0);
    const next = from + limit < all.length ? String(from + limit) : null;
    return json(route, { items: all.slice(from, from + limit), next_cursor: next });
  });
}

export function diary(items: Media[]) {
  const days = [2, 5, 6, 9, 14, 18, 21, 22, 27].map((d, i) => ({
    date: `2026-10-${String(d).padStart(2, "0")}`,
    entries: items.slice(i * 2, i * 2 + (i % 3 === 0 ? 2 : 1)).map((m, j) => ({
      media: m,
      watched: true,
      episodes: [],
      rating: (i + j) % 2 === 0 ? 7 + ((i + j) % 4) : null,
      rewatch: i === 4,
      at: `2026-10-${String(d).padStart(2, "0")}T20:00:00Z`,
    })),
  }));
  return {
    month: "2026-10",
    days,
    stats: {
      movies_watched: 11,
      episodes_watched: 4,
      series_watched: 1,
      hours_watched: 23.5,
      ratings_count: 7,
      average_rating: 8.1,
      rewatches: 1,
      favorite_genres: [
        { key: "18", name: "Drama", count: 6 },
        { key: "53", name: "Thriller", count: 4 },
        { key: "878", name: "Science Fiction", count: 3 },
      ],
      favorite_decades: [
        { key: "2010", name: "2010s", count: 5 },
        { key: "1990", name: "1990s", count: 3 },
      ],
      top_directors: [{ key: "137427", name: "Denis Villeneuve", count: 2 }],
      top_rated: items.slice(0, 4).map((m, i) => ({ media: m, rating: 10 - i })),
    },
  };
}

export function taste(profileId: string) {
  const aff = (key: string, name: string, score: number, count: number) => ({ key, name, score, count });
  return {
    profile_id: profileId,
    computed_at: new Date().toISOString(),
    signals: { ratings: 2160, completed: 2174, favorites: 38, watchlist: 51, dismissed: 4, abandoned: 12, rewatches: 17, average_rating: 7.4 },
    rating_histogram: [12, 18, 41, 77, 160, 302, 498, 541, 371, 160],
    kinds: { movie: 1890, series: 270 },
    genres: [aff("18", "Drama", 0.72, 1120), aff("80", "Crime", 0.55, 410), aff("878", "Science Fiction", 0.48, 260), aff("53", "Thriller", 0.31, 380), aff("35", "Comedy", 0.12, 520), aff("10749", "Romance", -0.18, 190), aff("27", "Horror", -0.46, 88), aff("10751", "Family", -0.3, 70)],
    decades: [aff("1960", "1960s", 0.2, 40), aff("1970", "1970s", 0.35, 96), aff("1980", "1980s", 0.3, 210), aff("1990", "1990s", 0.52, 420), aff("2000", "2000s", 0.4, 610), aff("2010", "2010s", 0.22, 560), aff("2020", "2020s", -0.05, 224)],
    languages: [aff("en", "English", 0.4, 1500), aff("ru", "Russian", 0.33, 420), aff("ko", "Korean", 0.61, 45), aff("hi", "Hindi", -0.4, 8)],
    countries: [aff("US", "United States", 0.38, 1400), aff("RU", "Russia", 0.3, 410), aff("FR", "France", 0.45, 90), aff("JP", "Japan", 0.5, 60)],
    directors: [
      { tmdb_id: 525, name: "Christopher Nolan", profile_path: null, score: 0.9, count: 11 },
      { tmdb_id: 137427, name: "Denis Villeneuve", profile_path: null, score: 0.85, count: 9 },
      { tmdb_id: 138, name: "Quentin Tarantino", profile_path: null, score: 0.7, count: 9 },
      { tmdb_id: 1032, name: "Martin Scorsese", profile_path: null, score: 0.66, count: 14 },
    ],
    actors: [
      { tmdb_id: 6193, name: "Leonardo DiCaprio", profile_path: null, score: 0.74, count: 18 },
      { tmdb_id: 1892, name: "Matt Damon", profile_path: null, score: 0.5, count: 15 },
    ],
    credits_coverage: { with_credits: 1620, total: 2174 },
  };
}
