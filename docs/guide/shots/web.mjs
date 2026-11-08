// Phone (PWA) screenshots for the household guide: 390×844 at 2×, JPEG.
// Runs in the e2e Playwright container against a dev stack (after tv.mjs paired «Гостиная»).
//   node /repo/docs/guide/shots/web.mjs [shot names…]
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { mockCatalog, mockForYou, ITEMS, MOVIES, SERIES, json } from "./mock.mjs";

const require = createRequire("/repo/e2e/package.json");
const { chromium } = require("@playwright/test");
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:8080";
const OUT = new URL("../img/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const ONLY = process.argv.slice(2);
const want = (n) => !ONLY.length || ONLY.some((o) => n.startsWith(o));
const HOST = "cineko.home";
const credential = JSON.parse(readFileSync(new URL("./out-cred.json", import.meta.url).pathname, "utf8")).credential;

const browser = await chromium.launch();
const FREEZE = "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important}";

async function hideHost(page) {
  await page.evaluate((host) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) n.nodeValue = n.nodeValue.replace(/(https?:\/\/)?(caddy|localhost|\d+\.\d+\.\d+\.\d+)(:\d+)?/g, host);
  }, HOST);
}
async function shot(p, name, opts = {}) {
  await p.waitForTimeout(opts.wait ?? 1200);
  await hideHost(p);
  await p.screenshot({ path: `${OUT}web-${name}.jpg`, type: "jpeg", quality: 78, fullPage: !!opts.full, clip: opts.clip });
  console.log("shot", name);
}

/** A signed-in phone with Анна's profile and the fictional catalog. */
async function phone({ settings = {} } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "ru-RU", isMobile: true, hasTouch: true });
  await ctx.addInitScript((f) => {
    localStorage.setItem("martytv.locale", "ru");
    localStorage.setItem("martytv.pwa_install_dismissed", "1");
    document.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = f; document.head.appendChild(s); });
  }, FREEZE);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log("pageerror", e.message));
  await p.goto(`${BASE}/login`);
  await p.getByLabel(/имя пользователя|username/i).fill("e2e-admin");
  await p.getByLabel(/пароль|password/i).fill("e2e-password-123");
  await p.getByRole("button", { name: /войти|sign in/i }).click();
  await p.waitForURL((u) => !u.pathname.startsWith("/login"));
  const profiles = (await (await ctx.request.get(`${BASE}/api/v1/profiles`)).json()).items;
  const anna = profiles.find((x) => x.name === "Анна");
  await p.evaluate((id) => localStorage.setItem("martytv.profile_id", id), anna.id);
  await mockCatalog(ctx, { continue: [ITEMS[16].id, ITEMS[5].id] });
  await mockForYou(ctx, anna.id);
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 200, json: {} });
    const body = await (await route.fetch()).json();
    return route.fulfill({ json: { ...body, design: process.env.GUIDE_DESIGN || "wireframe", theme: "dark", onboarding_completed: true, seasonal_effects: "off", ...settings } });
  });
  await ctx.route(/\/docs\/martytv-guide\.pdf/, (route) => route.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-1.4" }));
  return { ctx, p, anna };
}
async function step(name, fn) {
  if (!want(name)) return;
  try { await fn(); } catch (e) { console.log("FAILED", name, e.message.split("\n")[0]); }
}

await step("01-login", async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "ru-RU", isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => localStorage.setItem("martytv.locale", "ru"));
  const p = await ctx.newPage();
  await p.goto(`${BASE}/login`);
  await p.getByLabel(/имя пользователя|username/i).fill("anna");
  await p.getByLabel(/пароль|password/i).fill("секретный-пароль");
  await shot(p, "01-login");
  await ctx.close();
});

await step("02-home", async () => {
  const { ctx, p } = await phone();
  await p.goto(`${BASE}/`);
  await p.waitForTimeout(3000);
  await shot(p, "02-home");
  await p.evaluate(() => window.scrollTo(0, 800));
  await shot(p, "03-home-foryou");
  await p.evaluate(() => window.scrollTo(0, 1500));
  await shot(p, "04-home-foryou2");
  await ctx.close();
});

await step("10-title", async () => {
  const { ctx, p } = await phone();
  await p.goto(`${BASE}/title/${MOVIES[0].id}`);
  await p.waitForTimeout(3500);
  await shot(p, "10-title");
  await p.evaluate(() => window.scrollTo(0, 650));
  await shot(p, "11-title-actions");
  const after = p.getByRole("button", { name: /После титров/ }).first();
  if (await after.count()) { await after.click(); await shot(p, "12-after-credits", { wait: 2000 }); await p.keyboard.press("Escape"); }
  await p.goto(`${BASE}/title/${MOVIES[0].id}`);
  await p.waitForTimeout(2500);
  const quotes = p.getByRole("button", { name: /Цитаты/ }).first();
  if (await quotes.count()) { await quotes.click(); await shot(p, "13-quotes", { wait: 2000 }); }
  await ctx.close();
});

await step("14-releases", async () => {
  const { ctx, p } = await phone();
  await p.goto(`${BASE}/title/${MOVIES[0].id}`);
  await p.waitForTimeout(3000);
  // ▾ next to «Смотреть» → «Выбрать раздачу».
  await p.getByTestId("play-more").first().click();
  await p.getByTestId("choose-release").first().click();
  await shot(p, "14-releases", { wait: 2500 });
  await ctx.close();
});

await step("20-series", async () => {
  const { ctx, p } = await phone();
  await p.goto(`${BASE}/title/${SERIES[0].id}`);
  await p.waitForTimeout(3500);
  await shot(p, "20-series");
  await p.getByText(/Ранее в сериале/).first().click();
  await shot(p, "21-recap", { wait: 2000 });
  await p.keyboard.press("Escape");
  await p.waitForTimeout(600);
  await p.evaluate(() => window.scrollTo(0, 1100));
  await shot(p, "22-episodes");
  await ctx.close();
});

await step("30-settings", async () => {
  const { ctx, p } = await phone({ settings: { design_surprise: "off" } });
  await p.goto(`${BASE}/settings`);
  await p.waitForTimeout(3000);
  await shot(p, "30-settings");
  const y = async (re) => p.evaluate((src) => {
    const el = [...document.querySelectorAll("h2, h3, label, p, span, div")].find((e) => new RegExp(src).test(e.textContent ?? "") && e.children.length < 3);
    return el ? el.getBoundingClientRect().top + window.scrollY : null;
  }, re.source);
  for (const [name, re] of [["31-settings-designs", /^Оформление$/], ["32-settings-surprise", /^Сюрприз$/], ["33-settings-skip", /^Заставки и титры$/], ["34-settings-language", /^Язык$/], ["35-settings-guides", /^Инструкции$/]]) {
    const top = await y(re);
    if (top == null) { console.log("missing", name); continue; }
    await p.evaluate((t) => window.scrollTo(0, t - 90), top);
    await shot(p, name);
  }
  await ctx.close();
});

await step("40-devices", async () => {
  // A TV online for the remote: Анна's profile, playing the clip.
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await tvCtx.addInitScript((c) => { localStorage.setItem("martytv.device_credential", c); localStorage.setItem("martytv.locale", "ru"); }, credential);
  await mockCatalog(tvCtx, {});
  const { ctx, p, anna } = await phone();
  await tvCtx.addInitScript((id) => localStorage.setItem("martytv.profile_id", id), anna.id);
  const tv = await tvCtx.newPage();
  await tv.goto(`${BASE}/tv/`);
  await tv.waitForTimeout(5000);
  await p.goto(`${BASE}/devices`);
  await shot(p, "40-devices", { wait: 2500 });
  const devices = (await (await ctx.request.get(`${BASE}/api/v1/devices`)).json()).items;
  const dev = devices.find((d) => d.name === "Гостиная");
  await p.goto(`${BASE}/remote/${dev.id}`);
  await shot(p, "41-remote", { wait: 2500 });
  // Play on the TV from the phone, then the remote's playback card.
  await p.goto(`${BASE}/title/${MOVIES[0].id}`);
  await p.waitForTimeout(2500);
  // ▾ next to «Смотреть» → «На «Гостиная»».
  await p.getByTestId("play-more").first().click();
  await p.getByTestId("play-tv").first().click();
  await p.waitForTimeout(12000);
  await p.goto(`${BASE}/remote/${dev.id}`);
  await shot(p, "42-remote-playing", { wait: 3000 });
  await p.evaluate(() => window.scrollTo(0, 600));
  await shot(p, "43-remote-playing2");
  await tvCtx.close();
  await ctx.close();
});

await browser.close();
