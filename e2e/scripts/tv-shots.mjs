// Throwaway: 1920×1080 screenshots of the TV app in each design with real dev data.
// Usage (e2e container): node scripts/tv-shots.mjs [designs…]   e.g. kinozal terminal projector kinozal-light wireframe cyberpunk deco
// Extra shots via env: ROW2, SERIES_STEPS, BROWSE, MENU, SERIES_SHOT (series Details), SETTINGS (+ design picker), LOADER (player loader; playback is held, never plays).
// Pairs a TV once (credential cached in scripts/out/tv-cred.json). Never presses Play.
import { chromium } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:8080";
const OUT = new URL("./out/", import.meta.url);
mkdirSync(OUT, { recursive: true });
const CRED = new URL("tv-cred.json", OUT);
const wanted = process.argv.slice(2);
const runs = (wanted.length ? wanted : ["kinozal", "kinozal-light", "terminal", "projector", "wireframe", "cyberpunk", "deco"]).map((s) => {
  const [design, theme] = s.split("-");
  return { name: s, design, theme: theme ?? "dark" };
});
/** Designs on the Кинозал rail skeleton (the menu is to the left). */
const RAIL = new Set(["kinozal", "deco"]);
const DETAIL = process.env.DETAIL; // optional media id for Details
const SERIES = process.env.SERIES;

const browser = await chromium.launch();

async function pair() {
  const phoneCtx = await browser.newContext();
  const phone = await phoneCtx.newPage();
  await phone.goto(`${BASE}/login`);
  await phone.getByLabel(/username/i).fill("e2e-admin");
  await phone.getByLabel(/password/i).fill("e2e-password-123");
  await phone.getByRole("button", { name: /sign in/i }).click();
  await phone.getByRole("heading", { name: /welcome/i }).waitFor();
  const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const tv = await tvCtx.newPage();
  await tv.goto(`${BASE}/tv/`);
  const codeEl = tv.locator("p.font-mono");
  await codeEl.waitFor();
  await tv.waitForFunction(() => /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(document.querySelector("p.font-mono")?.textContent ?? ""));
  const code = (await codeEl.textContent()).trim();
  await phone.goto(`${BASE}/pair?code=${code}`);
  await phone.getByLabel(/tv name/i).fill("Гостиная");
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await tv.waitForFunction(() => !!localStorage.getItem("martytv.device_credential"), null, { timeout: 20000 });
  const credential = await tv.evaluate(() => localStorage.getItem("martytv.device_credential"));
  writeFileSync(CRED, JSON.stringify({ credential }));
  await tvCtx.close();
  await phoneCtx.close();
  return credential;
}

const credential = existsSync(CRED) ? JSON.parse(readFileSync(CRED, "utf8")).credential : await pair();
const api = await (await import("@playwright/test")).request.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${credential}` } });
const profiles = (await (await api.get("/api/v1/profiles")).json()).items;
const profile = profiles[0];

// A phone session to send media.open (Details of a given title) to this TV.
const phone = await (await import("@playwright/test")).request.newContext({ baseURL: BASE });
await phone.post("/api/v1/auth/login", { data: { username: "e2e-admin", password: "e2e-password-123" }, headers: { Origin: BASE } });
const csrf = (await (await phone.get("/api/v1/auth/session")).json()).csrf_token;
const deviceId = (await (await api.get("/api/v1/devices/me")).json()).id;
const openOnTv = (mediaId) => phone.post(`/api/v1/devices/${deviceId}/commands`, { data: { type: "media.open", payload: { media_id: mediaId } }, headers: { "X-CSRF-Token": csrf, Origin: BASE } });
const seriesId = (await (await api.get("/api/v1/catalog/search?q=Breaking%20Bad&kind=series&lang=ru")).json()).items[0].id;

for (const run of runs) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: "ru-RU" });
  await ctx.addInitScript(
    ([c, p]) => {
      localStorage.setItem("martytv.device_credential", c);
      localStorage.setItem("martytv.profile_id", p);
      localStorage.setItem("martytv.locale", "ru");
    },
    [credential, profile.id],
  );
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 200, json: {} });
    const res = await route.fetch();
    const body = await res.json();
    return route.fulfill({ json: { ...body, design: run.design, theme: run.theme, onboarding_completed: true } });
  });
  // Releases: the dev API's search may be down; demo rows (never played).
  if (!process.env.REAL_RELEASES) {
    const rel = (id, p) => ({ id, title: `Demo.${id}`, indexer: "RuTracker", size_bytes: 14.6 * 1024 ** 3, seeders: 847, leechers: 3, published_at: null, info_hash: null, resolution: "1080p", video_codec: "h264", hdr: null, audio_codecs: ["ac3"], languages: ["ru"], voiceovers: [{ kind: "dub", studio: null, language: "ru" }], release_group: null, source_quality: "web-dl", year: 2024, seasons: [], episodes: [], is_season_pack: false, confidence: 0.95, score: 1, reasons: [], warnings: [], ...p });
    const items = [
      rel("a", { title: "Demo.2160p.HDR10.Atmos", resolution: "2160p", hdr: "hdr10", video_codec: "h264", audio_codecs: ["truehd"], size_bytes: 61.4 * 1024 ** 3, seeders: 312 }),
      rel("b", { title: "Demo.2160p.DD5.1", resolution: "2160p", video_codec: "hevc", indexer: "Kinozal", size_bytes: 24.8 * 1024 ** 3, seeders: 196 }),
      rel("c", { title: "Demo.1080p.5.1" }),
      rel("d", { title: "Demo.1080p", indexer: "NNM", voiceovers: [{ kind: "mvo", studio: null, language: "ru" }], size_bytes: 9.2 * 1024 ** 3, seeders: 233 }),
      rel("e", { title: "Demo.720p.2.0", resolution: "720p", indexer: "Rutor", size_bytes: 4.1 * 1024 ** 3, seeders: 402 }),
      rel("f", { title: "Demo.2160p.Atmos", resolution: "2160p", indexer: "1337x", voiceovers: [{ kind: "original", studio: null, language: "orig" }], size_bytes: 78.9 * 1024 ** 3, seeders: 58 }),
    ];
    await ctx.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) => route.fulfill({ json: { items, searched_at: new Date().toISOString(), cached: true, indexer_errors: [] } }));
  }
  // Player loader shots: hold playback requests so the loader stays up (nothing ever plays).
  if (process.env.LOADER) await ctx.route(/\/api\/v1\/playback\//, () => {});
  const tv = await ctx.newPage();
  tv.on("pageerror", (e) => console.log(`[${run.name}] pageerror`, e.message));
  await tv.goto(`${BASE}/tv/`);
  await tv.locator(`[data-design-skin="${run.design}"]`).waitFor({ timeout: 30000 });
  await tv.waitForTimeout(3500);
  await tv.screenshot({ path: new URL(`tv-${run.name}-home.png`, OUT).pathname });
  // A poster row (never OK on "Continue watching": that starts playback).
  if (process.env.ROW2) {
    await tv.keyboard.press("ArrowDown");
    await tv.waitForTimeout(400);
    await tv.keyboard.press("ArrowDown");
    await tv.waitForTimeout(2500);
    await tv.screenshot({ path: new URL(`tv-${run.name}-home-row.png`, OUT).pathname });
  }
  for (const [tag, id] of [["details", DETAIL], ["series", SERIES]]) {
    if (!id) continue;
    await tv.evaluate((mid) => {
      // Open Details like a phone's media.open would (no playback).
      window.__openDetails?.(mid);
    }, id);
  }
  if (await tv.locator('[data-focus-key*="row-continue"] .is-focused').count()) {
    await tv.keyboard.press("ArrowDown");
    await tv.waitForTimeout(500);
  }
  await tv.keyboard.press("ArrowRight");
  await tv.waitForTimeout(300);
  await tv.keyboard.press("Enter");
  await tv.locator("[data-media-id] h1").waitFor({ timeout: 20000 });
  await tv.waitForTimeout(6000);
  await tv.screenshot({ path: new URL(`tv-${run.name}-details.png`, OUT).pathname });
  if (process.env.SERIES_SHOT) {
    await tv.keyboard.press("Escape");
    await tv.waitForTimeout(600);
    await openOnTv(seriesId);
    await tv.locator("[data-media-id] h1").waitFor({ timeout: 20000 });
    await tv.waitForTimeout(4000);
    await tv.screenshot({ path: new URL(`tv-${run.name}-series.png`, OUT).pathname });
  }
  if (process.env.LOADER) {
    // From Details: Play → the loader (playback requests are held).
    await tv.evaluate(() => (document.querySelector('[data-focus-key="d-play"], .tv-focus.is-focused'))?.click());
    await tv.waitForTimeout(3500);
    await tv.screenshot({ path: new URL(`tv-${run.name}-loader.png`, OUT).pathname });
    await tv.keyboard.press("Escape");
    await tv.waitForTimeout(1200);
    await tv.keyboard.press("Escape");
    await tv.waitForTimeout(800);
  }
  if (process.env.SERIES_STEPS) {
    // Series Details: Play → seasons → 6th episode → season 2 → cast → back up.
    await tv.keyboard.press("Escape");
    await tv.waitForTimeout(600);
    await openOnTv(seriesId);
    await tv.locator("[data-media-id] h1").waitFor({ timeout: 20000 });
    await tv.waitForTimeout(3000);
    const shot = async (n) => {
      await tv.waitForTimeout(900);
      await tv.screenshot({ path: new URL(`tv-${run.name}-series-${n}.png`, OUT).pathname });
    };
    await shot("1-play");
    await tv.keyboard.press("ArrowDown");
    await shot("2-seasons");
    await tv.keyboard.press("ArrowDown");
    for (let i = 0; i < 5; i++) {
      await tv.keyboard.press("ArrowRight");
      await tv.waitForTimeout(200);
    }
    await shot("3-episode6");
    await tv.keyboard.press("ArrowUp");
    await tv.waitForTimeout(200);
    await tv.keyboard.press("ArrowRight");
    await tv.waitForTimeout(200);
    await tv.keyboard.press("Enter");
    await tv.waitForTimeout(800);
    await tv.keyboard.press("ArrowDown");
    await tv.waitForTimeout(1500);
    await shot("4-season2-episodes");
    await tv.keyboard.press("ArrowDown");
    await shot("5-cast");
    for (let i = 0; i < 4; i++) {
      await tv.keyboard.press("ArrowUp");
      await tv.waitForTimeout(250);
    }
    await shot("6-back-to-play");
  }
  if (process.env.BROWSE) {
    // Movies (Browse grid) via the menu, then Search.
    await tv.keyboard.press("Escape");
    await tv.waitForTimeout(800);
    await tv.evaluate(() => (document.querySelector('[data-menu="movies"]'))?.click());
    await tv.waitForTimeout(3500);
    await tv.screenshot({ path: new URL(`tv-${run.name}-browse.png`, OUT).pathname });
    await tv.evaluate(() => (document.querySelector('[data-menu="search"]'))?.click());
    await tv.waitForTimeout(1500);
    await tv.screenshot({ path: new URL(`tv-${run.name}-search.png`, OUT).pathname });
    await tv.evaluate(() => (document.querySelector('[data-menu="home"]'))?.click());
    await tv.waitForTimeout(1500);
    await tv.keyboard.press(RAIL.has(run.design) ? "ArrowLeft" : "ArrowUp");
    await tv.waitForTimeout(300);
    await tv.keyboard.press(RAIL.has(run.design) ? "ArrowLeft" : "ArrowUp");
    await tv.waitForTimeout(800);
    await tv.screenshot({ path: new URL(`tv-${run.name}-menu.png`, OUT).pathname });
  }
  if (process.env.MENU) {
    await tv.keyboard.press("Escape");
    await tv.waitForTimeout(800);
    await tv.keyboard.press(RAIL.has(run.design) ? "ArrowLeft" : "ArrowUp");
    await tv.keyboard.press(RAIL.has(run.design) ? "ArrowLeft" : "ArrowUp");
    await tv.waitForTimeout(800);
    await tv.screenshot({ path: new URL(`tv-${run.name}-menu.png`, OUT).pathname });
  }
  if (process.env.SETTINGS) {
    await tv.keyboard.press("Escape");
    await tv.waitForTimeout(800);
    await tv.evaluate(() => (document.querySelector('[data-menu="settings"]'))?.click());
    await tv.locator('[data-testid="tv-settings"]').waitFor({ timeout: 10000 });
    await tv.waitForTimeout(1500);
    await tv.screenshot({ path: new URL(`tv-${run.name}-settings.png`, OUT).pathname });
  }
  await ctx.close();
  console.log("done", run.name);
}
await browser.close();
