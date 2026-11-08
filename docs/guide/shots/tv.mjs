// TV screenshots for the household guide (1920×1080 layout, saved 1600×900 JPEG).
// Runs in the e2e Playwright container against a dev stack: see ../README.md.
//   node /repo/docs/guide/shots/tv.mjs [shot names…]
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mockCatalog, mockForYou, ITEMS, SERIES, MOVIES } from "./mock.mjs";

const require = createRequire("/repo/e2e/package.json");
const { chromium, request } = require("@playwright/test");
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:8080";
const OUT = new URL("../img/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const ONLY = process.argv.slice(2);
const want = (n) => !ONLY.length || ONLY.some((o) => n.startsWith(o));
const SCALE = 1600 / 1920;
const HOST = "cineko.home"; // shown instead of the dev address
// The guide's look: every TV shot in this design (GUIDE_DESIGN to change).
const DESIGN = process.env.GUIDE_DESIGN || "wireframe";

const browser = await chromium.launch();
const CRED = new URL("./out-cred.json", import.meta.url).pathname;

// ---- account: e2e-admin, profiles Анна / Олег / Ира, TV «Гостиная»
const phone = await request.newContext({ baseURL: BASE });
await phone.post("/api/v1/auth/login", { data: { username: "e2e-admin", password: "e2e-password-123" }, headers: { Origin: BASE } });
const csrf = (await (await phone.get("/api/v1/auth/session")).json()).csrf_token;
const H = { "X-CSRF-Token": csrf, Origin: BASE };
let profiles = (await (await phone.get("/api/v1/profiles")).json()).items;
for (const [name, color] of [["Анна", "#e11d48"], ["Олег", "#2563eb"], ["Ира", "#16a34a"]]) {
  if (!profiles.some((p) => p.name === name)) await phone.post("/api/v1/profiles", { data: { name, color }, headers: H });
}
profiles = (await (await phone.get("/api/v1/profiles")).json()).items;
for (const p of profiles.filter((p) => !["Анна", "Олег", "Ира"].includes(p.name))) await phone.delete(`/api/v1/profiles/${p.id}`, { headers: H });
profiles = (await (await phone.get("/api/v1/profiles")).json()).items;
const anna = profiles.find((p) => p.name === "Анна");

async function pair() {
  const ph = await browser.newContext();
  const p = await ph.newPage();
  await p.goto(`${BASE}/login`);
  await p.getByLabel(/username/i).fill("e2e-admin");
  await p.getByLabel(/password/i).fill("e2e-password-123");
  await p.getByRole("button", { name: /sign in/i }).click();
  await p.getByRole("heading", { name: /welcome/i }).waitFor();
  const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: SCALE, locale: "ru-RU" });
  await tvCtx.addInitScript(() => localStorage.setItem("martytv.locale", "ru"));
  await tvCtx.route(/\/api\/v1\/pairing$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    for (const k of ["verification_url", "verification_url_complete"]) body[k] = String(body[k]).replace(/^https?:\/\/[^/]+/, `https://${HOST}`);
    return route.fulfill({ status: res.status(), json: body });
  });
  const tv = await tvCtx.newPage();
  await tv.goto(`${BASE}/tv/`);
  await tv.waitForFunction(() => /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(document.querySelector("p.font-mono")?.textContent ?? ""));
  await tv.waitForTimeout(1500);
  await hideHost(tv);
  if (want("01-pairing")) await shot(tv, "01-pairing");
  const code = (await tv.locator("p.font-mono").textContent()).trim();
  await p.goto(`${BASE}/pair?code=${code}`);
  await p.getByLabel(/tv name/i).fill("Гостиная");
  await p.getByRole("button", { name: /connect tv/i }).click();
  await tv.waitForFunction(() => !!localStorage.getItem("martytv.device_credential"), null, { timeout: 20000 });
  const credential = await tv.evaluate(() => localStorage.getItem("martytv.device_credential"));
  writeFileSync(CRED, JSON.stringify({ credential }));
  await tvCtx.close();
  await ph.close();
  return credential;
}

async function hideHost(page) {
  await page.evaluate((host) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) n.nodeValue = n.nodeValue.replace(/(https?:\/\/)?(caddy|localhost|\d+\.\d+\.\d+\.\d+)(:\d+)?/g, host);
  }, HOST);
}
async function shot(page, name) {
  await page.mouse.move(0, 0).catch(() => {});
  await page.screenshot({ path: `${OUT}tv-${name}.jpg`, type: "jpeg", quality: 80 });
  console.log("shot", name);
}

const credential = (want("01-pairing") || !existsSync(CRED)) ? await pair() : JSON.parse(readFileSync(CRED, "utf8")).credential;
const tvApi = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${credential}` } });
const deviceId = (await (await tvApi.get("/api/v1/devices/me")).json()).id;
const openOnTv = (media_id, extra = {}) => phone.post(`/api/v1/devices/${deviceId}/commands`, { data: { type: "media.open", payload: { media_id, ...extra } }, headers: H });

const FREEZE = "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important}";

/** A TV context: Анна's profile, a design, the fictional catalog. */
async function tvPage({ design = DESIGN, profile = anna.id, freeze = true, settings = {}, local = {}, mock = {}, clock = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: SCALE, locale: "ru-RU" });
  await ctx.addInitScript(([c, p, f, l]) => {
    localStorage.setItem("martytv.device_credential", c);
    if (p) localStorage.setItem("martytv.profile_id", p);
    else localStorage.removeItem("martytv.profile_id");
    localStorage.setItem("martytv.locale", "ru");
    localStorage.setItem("martytv.design_intro", "0");
    for (const [k, v] of Object.entries(l)) localStorage.setItem(k, v);
    if (f) document.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = f; document.head.appendChild(s); });
  }, [credential, profile, freeze ? FREEZE : "", local]);
  await mockCatalog(ctx, { continue: [ITEMS[16].id, ITEMS[5].id], ...mock });
  await mockForYou(ctx, anna.id);
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 200, json: {} });
    const body = await (await route.fetch()).json();
    return route.fulfill({ json: { ...body, design, theme: "dark", onboarding_completed: true, seasonal_effects: "off", design_intro: false, intro: false, ...settings } });
  });
  const tv = await ctx.newPage();
  tv.on("pageerror", (e) => console.log("pageerror", e.message));
  if (clock) await tv.clock.install();
  await tv.goto(`${BASE}/tv/`);
  if (profile) await tv.locator(`[data-design-skin="${design}"]`).waitFor({ timeout: 30000 });
  return { ctx, tv };
}
const wait = (tv, ms) => tv.waitForTimeout(ms);
const press = async (tv, key, n = 1, ms = 180) => { for (let i = 0; i < n; i++) { await tv.keyboard.press(key); await tv.waitForTimeout(ms); } };
const focusKey = (tv) => tv.evaluate(() => window.__focusKey?.());
async function openDetails(tv, m) {
  // Home → the card (click it like OK; falls back to the keyboard walk).
  if (!(await tv.locator("[data-media-id] h1").count())) {
    await tv.evaluate(() => document.querySelector('[data-menu="home"]')?.click());
    await wait(tv, 1200);
  }
  await tv.locator(`[data-card-id="${m.id}"]`).first().waitFor({ timeout: 15000 });
  await tv.evaluate((id) => {
    const el = document.querySelector(`[data-card-id="${id}"]`);
    (el.closest(".tv-focus") ?? el).click();
  }, m.id);
  await tv.locator("[data-media-id] h1").waitFor({ timeout: 20000 });
  await wait(tv, 2500);
}
async function step(name, fn) {
  if (!want(name)) return;
  try { await fn(); } catch (e) { console.log("FAILED", name, e.message.split("\n")[0]); }
}

const RAIL = new Set(["kinozal", "deco", "retro80"]);

await step("02-profiles", async () => {
  const { ctx, tv } = await tvPage({ profile: null });
  await tv.getByText(/Кто смотрит/).first().waitFor({ timeout: 20000 });
  await wait(tv, 1500);
  await shot(tv, "02-profiles");
  await ctx.close();
});

await step("03-home", async () => {
  const { ctx, tv } = await tvPage();
  await wait(tv, 3500);
  await shot(tv, "03-home");
  await press(tv, "ArrowDown");
  await wait(tv, 800);
  await shot(tv, "04-home-row");
  await press(tv, "ArrowDown", 2);
  await wait(tv, 900);
  await shot(tv, "05-home-foryou");
  await press(tv, "ArrowLeft", 8, 120);
  await wait(tv, 900);
  await shot(tv, "06-menu");
  await ctx.close();
});

await step("10-details", async () => {
  const { ctx, tv } = await tvPage();
  await wait(tv, 2500);
  await openDetails(tv, MOVIES[0]);
  await shot(tv, "10-details");
  // The extras line: quotes, facts, after credits.
  const click = (sel) => tv.evaluate((s) => document.querySelector(s)?.click(), sel);
  await click("[data-testid=tv-quotes-button]");
  await wait(tv, 1500);
  await shot(tv, "11-quotes");
  await press(tv, "Escape");
  await wait(tv, 600);
  await click("[data-testid=tv-facts-button]");
  await wait(tv, 1500);
  await shot(tv, "12-facts");
  await press(tv, "Escape");
  await wait(tv, 600);
  await click("[data-testid=tv-after-button]");
  await wait(tv, 1800);
  await shot(tv, "13-after-credits");
  await press(tv, "Escape");
  await wait(tv, 600);
  // «Ещё» → soundtrack QR.
  await press(tv, "ArrowRight", 3, 250);
  await press(tv, "Enter");
  await wait(tv, 900);
  await shot(tv, "14-more-menu");
  for (let i = 0; i < 10; i++) {
    const t = await tv.evaluate(() => document.querySelector("[data-testid=more-menu] .is-focused, [data-testid=more-menu] [data-nav-focused='1']")?.textContent ?? "");
    if (/Саундтрек/.test(t)) break;
    await press(tv, "ArrowDown", 1, 200);
  }
  await press(tv, "Enter");
  await wait(tv, 1500);
  await hideHost(tv);
  await shot(tv, "15-soundtrack");
  await press(tv, "Escape");
  await wait(tv, 800);
  // Releases (☰ next to Play).
  await press(tv, "ArrowLeft", 3, 200);
  await press(tv, "ArrowRight");
  await press(tv, "Enter");
  await tv.locator("[data-testid=release-picker]").waitFor({ timeout: 10000 });
  await wait(tv, 1200);
  await shot(tv, "16-releases");
  await press(tv, "Escape");
  await wait(tv, 600);
  await ctx.close();
});

await step("20-series", async () => {
  const { ctx, tv } = await tvPage();
  await wait(tv, 2500);
  await openDetails(tv, SERIES[0]);
  await shot(tv, "20-series");
  await press(tv, "ArrowDown");
  await wait(tv, 700);
  await press(tv, "ArrowDown");
  await wait(tv, 1200);
  await shot(tv, "21-episodes");
  await tv.evaluate(() => document.querySelector("[data-testid=tv-recap-button]")?.click());
  await wait(tv, 1800);
  await shot(tv, "22-recap");
  await ctx.close();
});

await step("30-player", async () => {
  const chapters = [{ start_seconds: 0, end_seconds: 12, title: "Пролог" }, { start_seconds: 12, end_seconds: 26, title: "Станция" }, { start_seconds: 26, end_seconds: 40, title: "Шторм" }];
  const markers = [{ kind: "opening", start_seconds: 0.5, end_seconds: 30, source: "chapters" }];
  const { ctx, tv } = await tvPage({ mock: { chapters, markers } });
  await wait(tv, 2500);
  await openDetails(tv, MOVIES[0]);
  await press(tv, "Enter");
  const video = tv.locator("[data-testid=player] video");
  await video.waitFor({ timeout: 30000 });
  await tv.waitForFunction(() => (document.querySelector("[data-testid=player] video")?.currentTime ?? 0) > 1.5, null, { timeout: 30000 });
  await wait(tv, 1500);
  await shot(tv, "30-player-skip");
  await press(tv, "ArrowUp");
  await wait(tv, 900);
  await shot(tv, "31-player-bar");
  await press(tv, "Enter"); // pause
  await wait(tv, 1200);
  await shot(tv, "32-player-paused");
  await press(tv, "Enter");
  await wait(tv, 500);
  await press(tv, "ArrowDown");
  await wait(tv, 1000);
  await shot(tv, "33-player-panel");
  await press(tv, "ArrowDown", 12, 150);
  await wait(tv, 800);
  await shot(tv, "34-player-sleep");
  await ctx.close();
});

// Every loading style (the guide's last gallery), read from the TV app.
const LOADERS = process.env.LOADERS ? process.env.LOADERS.split(" ") : JSON.parse(/export const LOADING_STYLES: readonly LoadingStyle\[\] = (\[[^\]]*\])/.exec(readFileSync("/repo/apps/tv/src/profile/settings.ts", "utf8"))[1]);
await step("35-loader", async () => {
  for (const style of LOADERS) {
    const { ctx, tv } = await tvPage({ freeze: false, mock: { holdSource: true }, settings: { loading_style: style } });
    await wait(tv, 2500);
    await openDetails(tv, MOVIES[0]);
    await press(tv, "Enter");
    await wait(tv, 4000);
    await shot(tv, `35-loader-${style}`);
    await ctx.close();
  }
});

await step("40-settings", async () => {
  const { ctx, tv } = await tvPage();
  await wait(tv, 2500);
  await tv.evaluate(() => document.querySelector('[data-menu="settings"]')?.click());
  await tv.locator('[data-testid="tv-settings"]').waitFor({ timeout: 10000 });
  await wait(tv, 1500);
  await shot(tv, "40-settings");
  await press(tv, "ArrowDown");
  await wait(tv, 900);
  await shot(tv, "41-settings-surprise");
  for (let i = 0; i < 60; i++) {
    const t = await tv.evaluate(() => [...document.querySelectorAll("[data-testid=tv-settings] .is-focused, [data-testid=tv-settings] [data-nav-focused=\"1\"]")].map((e) => e.textContent).join("|"));
    if (process.env.DEBUG) console.log("key", t);
    if (/Заставки и титры/.test(t)) break;
    await press(tv, "ArrowDown", 1, 110);
  }
  await wait(tv, 900);
  await shot(tv, "42-settings-skip");
  for (let i = 0; i < 60; i++) {
    const t = await tv.evaluate(() => [...document.querySelectorAll("[data-testid=tv-settings] .is-focused, [data-testid=tv-settings] [data-nav-focused=\"1\"]")].map((e) => e.textContent).join("|"));
    if (/^Заставка(?! )|Спящий Cineko|Логотип DVD/.test(t)) break;
    await press(tv, "ArrowDown", 1, 110);
  }
  await wait(tv, 900);
  await shot(tv, "43-settings-device");
  await ctx.close();
});

await step("45-screensaver", async () => {
  for (const saver of ["sleep", "dvd"]) {
    const { ctx, tv } = await tvPage({ freeze: false, clock: true, local: { "martytv.screensaver": saver } });
    await wait(tv, 3000);
    await tv.clock.fastForward("10:30");
    await wait(tv, 2500);
    await shot(tv, `45-saver-${saver}`);
    await ctx.close();
  }
});

await step("50-search", async () => {
  const { ctx, tv } = await tvPage();
  await wait(tv, 2500);
  await tv.evaluate(() => document.querySelector('[data-menu="search"]')?.click());
  await wait(tv, 1200);
  for (const ch of ["С", "Е", "В"]) {
    await tv.evaluate((c) => [...document.querySelectorAll("button, [role=button], .tv-focus")].find((b) => b.textContent.trim() === c)?.click(), ch);
    await wait(tv, 300);
  }
  await wait(tv, 1500);
  await shot(tv, "50-search");
  await tv.evaluate(() => document.querySelector('[data-menu="movies"]')?.click());
  await wait(tv, 2500);
  await shot(tv, "51-browse");
  await ctx.close();
});

// Every design (the guide's design gallery), read from packages/ui.
const DESIGNS = process.env.DESIGNS ? process.env.DESIGNS.split(" ") : JSON.parse(/export const DESIGNS: DesignSetting\[\] = (\[[^\]]*\])/.exec(readFileSync("/repo/packages/ui/src/designs.ts", "utf8"))[1]);
await step("60-design", async () => {
  for (const design of DESIGNS) {
    const { ctx, tv } = await tvPage({ design, local: { "martytv.calm_motion": "1", "martytv.matrixPill": "1" } });
    await wait(tv, 4000);
    await wait(tv, 400);
    await shot(tv, `60-design-${design}`);
    await ctx.close();
  }
});

await browser.close();
