// Throwaway: screenshots of PWA catalog screens with mocked catalog API.
// Usage: node scripts/web-shots.mjs [--real]
import { chromium } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:8080";
const REAL = process.argv.includes("--real");
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const titles = ["The Matrix", "Дюна: Часть вторая", "Severance", "Oppenheimer", "Shōgun", "Inception", "The Bear", "Interstellar", "Arcane", "Parasite", "Andor", "Past Lives"];
const posters = ["/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg", "/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg", "/pPHpeI2X1qEd1CS1SeyrdhZ4qnT.jpg", "/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg", null];
const item = (i, kind = i % 3 === 2 ? "series" : "movie") => ({
  id: uuid(i), kind, tmdb_id: 600 + i, title: titles[i % titles.length], original_title: titles[i % titles.length],
  year: 1999 + (i % 25), release_date: `${1999 + (i % 25)}-03-31`,
  overview: "A computer hacker learns from mysterious rebels about the true nature of his reality and his role in the war against its controllers.",
  poster_path: posters[i % posters.length], backdrop_path: "/fNG7i7RqMErkcqhohV2a6cV1Ehy.jpg",
  rating: i % 5 === 4 ? null : 6 + (i % 30) / 10, vote_count: 1000 * i, genre_ids: [28, 878],
});
const page = (start, n = 20, p = 1) => ({ items: Array.from({ length: n }, (_, k) => item(start + k)), page: p, total_pages: 3, total_results: 60 });
const keys = [["trending", "all", "trending"], ["popular_movies", "movie", "popular"], ["popular_series", "series", "popular"], ["top_rated_movies", "movie", "top_rated"]];
const genres = ["Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary", "Drama", "Family", "Fantasy", "History", "Horror", "Science Fiction", "Thriller"].map((name, i) => ({ id: 10 + i, name }));
const seasons = [0, 1, 2, 3].map((n) => ({ season_number: n, name: n ? `Season ${n}` : "Specials", overview: "", air_date: n === 3 ? "2099-01-01" : `20${20 + n}-02-01`, episode_count: 8, poster_path: null }));
const detail = (id) => ({
  ...item(2, "series"), id, title: "Severance", original_title: "Severance (原題)", tagline: "Work is mysterious and important.",
  runtime: 55, status: "Returning Series", original_language: "en", genres: genres.slice(5, 9), countries: ["US"],
  cast: Array.from({ length: 12 }, (_, i) => ({ person_tmdb_id: i, name: ["Adam Scott", "Britt Lower", "Zach Cherry", "John Turturro"][i % 4], character: "Mark Scout", profile_path: i % 3 ? null : "/abc.jpg", order: i })),
  crew: [{ person_tmdb_id: 1, name: "Dan Erickson", job: "Creator", department: "Writing", profile_path: null }, { person_tmdb_id: 2, name: "Ben Stiller", job: "Director", department: "Directing", profile_path: null }],
  seasons, number_of_seasons: 3, number_of_episodes: 19, last_air_date: "2025-03-21",
  external_ids: { tmdb: 95396, imdb: "tt11280740", tvdb: null }, trailer: { site: "YouTube", key: "xEQP4VVuyrY", name: "Official Trailer", type: "Trailer" },
});

const browser = await chromium.launch();
async function shoot(name, viewport, steps) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  if (!REAL) {
    await p.route(/\/api\/v1\/(catalog|media)\//, (route) => {
      const u = new URL(route.request().url());
      const path = u.pathname.replace("/api/v1", "");
      const json = (b) => route.fulfill({ json: b });
      if (path === "/catalog/config") return json({ image_base_url: "https://image.tmdb.org/t/p", poster_sizes: [], backdrop_sizes: [], profile_sizes: [], still_sizes: [], attribution: "", region: "US", available: process.env.UNAVAILABLE ? false : true });
      if (path === "/catalog/home") return json({ rows: keys.map(([key, kind, list], r) => ({ key, kind, list, items: page(r * 3, 12).items })) });
      if (path === "/catalog/genres") return json({ items: genres });
      if (path.startsWith("/catalog/")) { const pg = Number(u.searchParams.get("page") ?? 1); return json(page(pg * 20, 20, pg)); }
      if (/\/seasons\/\d+$/.test(path)) { const n = Number(path.split("/").pop()); return json({ ...seasons[n], media_id: uuid(2), episodes: Array.from({ length: 6 }, (_, i) => ({ id: uuid(900 + n * 10 + i), season_number: n, episode_number: i + 1, name: `S${n} episode ${i + 1}: Good News About Hell`, overview: "Mark is promoted after a sudden departure; Helly wakes up on a conference table with no memory of who she is.", air_date: "2022-02-18", runtime: 57, still_path: i % 2 ? null : "/x.jpg", rating: 8 })) }); }
      if (path.endsWith("/providers")) return json({ region: "US", link: "https://www.themoviedb.org", flatrate: [{ provider_id: 1, name: "Apple TV Plus", logo_path: null }], rent: [], buy: [{ provider_id: 2, name: "Amazon Video", logo_path: null }] });
      if (path.endsWith("/similar") || path.endsWith("/recommendations")) return json(page(4, 10));
      if (path.startsWith("/media/")) return json(detail(path.split("/")[2]));
      return route.fulfill({ status: 404, json: { error: { code: "not_found", message: "nf" } } });
    });
  }
  await p.goto(`${BASE}/login`);
  await p.getByLabel(/username/i).fill("e2e-admin");
  await p.getByLabel(/password/i).fill("e2e-password-123");
  await p.getByRole("button", { name: /sign in/i }).click();
  await p.getByRole("heading", { name: /welcome/i }).waitFor();
  await steps(p);
  await ctx.close();
}
const sizes = { phone: { width: 390, height: 844 }, desk: { width: 1280, height: 800 } };
const only = process.env.ONLY;
for (const [sz, vp] of Object.entries(sizes)) {
  await shoot(sz, vp, async (p) => {
    const snap = async (n, full = true) => { await p.waitForTimeout(1200); await p.screenshot({ path: `scripts/out/${n}-${sz}.png`, fullPage: full }); };
    if (!only || only === "home") { await p.goto(`${BASE}/`); await snap("home"); }
    if (!only || only === "browse") { await p.goto(`${BASE}/browse?kind=movie&genres=10,16`); await snap("browse", false);
      if (sz === "phone") { await p.getByRole("button", { name: /filters/i }).click(); await snap("browse-filters"); } }
    if (!only || only === "search") { await p.goto(`${BASE}/search`); await p.getByRole("searchbox").fill("Матрица"); await snap("search", false); }
    if (!only || only === "title") { if (REAL) { await p.goto(`${BASE}/search?q=Severance&kind=series`); await p.getByTestId("poster-card").first().click(); await p.getByTestId("seasons").waitFor(); } else await p.goto(`${BASE}/title/${uuid(2)}`); await snap("title"); }
  });
}
await browser.close();
