import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";

// Startup on a weak TV + slow link: the production TV bundle (apps/tv/dist —
// build it first: pnpm --filter @martytv/tv build) served at ~1.5 Mbit/s with
// 300 ms latency, API calls delayed too, CPU ×6. Screenshots every 400 ms go
// to /tmp/pw-x/startup (to eyeball flashes); fails on page errors or layout
// shifts. Checked: dark/cached-theme first frame (no splash text), no theme flash.
// TV_DIST: another build to measure (e.g. a branch's dist copied elsewhere).
const DIST = process.env.TV_DIST ?? "/repo/apps/tv/dist";
// The page itself is served by route.fulfill: Chrome then treats it as public and blocks calls to the (private) dev API.
test.skip(!existsSync(`${DIST}/index.html`), "needs the production TV build (apps/tv/dist)");
test.use({ launchOptions: { args: ["--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,LocalNetworkAccessChecks"] } });
const BPS = 1_500_000 / 8;
const LAT = 300;
const OUT = "/tmp/pw-x/startup";

const types: Record<string, string> = { js: "text/javascript", css: "text/css", html: "text/html", webp: "image/webp", png: "image/png", svg: "image/svg+xml", woff2: "font/woff2", json: "application/json" };

/** Milestones (ms since navigation start) logged by each test: React's first render, the pairing code and QR, Home. */
const PROBE = () => {
  const w = window as unknown as { __t: Record<string, number> };
  w.__t = {};
  const marks: [string, string][] = [
    ["render", "#root > :not(.boot)"],
    ["code", "p.font-mono"],
    ["qr", "img[src^='data:image']"],
    ["home", "[data-design-shell]"],
  ];
  const tick = () => {
    for (const [k, sel] of marks) if (!(k in w.__t) && document.querySelector(sel)) w.__t[k] = Math.round(performance.now());
    if (Object.keys(w.__t).length < marks.length && performance.now() < 60_000) setTimeout(tick, 50);
  };
  tick();
};

async function logTimes(page: Page, tag: string) {
  const t = await page.evaluate(() => (window as unknown as { __t?: Record<string, number> }).__t ?? {}).catch(() => ({}));
  console.log(`[startup] ${tag}: ${JSON.stringify(t)}`);
}

async function slowNet(ctx: BrowserContext) {
  await ctx.route(/\/tv\/(?!api)/, async (route) => {
    const url = new URL(route.request().url());
    let rel = url.pathname.replace(/^\/tv\/?/, "") || "index.html";
    if (!existsSync(`${DIST}/${rel}`) || statSync(`${DIST}/${rel}`).isDirectory()) rel = "index.html";
    const body = readFileSync(`${DIST}/${rel}`);
    const ext = rel.split(".").pop() ?? "";
    const wire = ["js", "css", "html", "svg", "json"].includes(ext) ? gzipSync(body).length : body.length;
    await new Promise((r) => setTimeout(r, LAT + (wire / BPS) * 1000));
    await route.fulfill({ status: 200, body, headers: { "Content-Type": types[ext] ?? "application/octet-stream", "Cache-Control": "no-store" } });
  });
  await ctx.route(/\/api\/v1\//, async (route) => {
    await new Promise((r) => setTimeout(r, LAT + 150));
    await route.continue();
  });
}

async function watch(page: Page, tag: string, ms: number) {
  mkdirSync(OUT, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  const shots: string[] = [];
  for (let t = 0; t < ms; t += 400) {
    const p = `${OUT}/${tag}-${String(t).padStart(5, "0")}.png`;
    await page.screenshot({ path: p }).catch(() => undefined);
    shots.push(p);
    await page.waitForTimeout(400);
  }
  return shots;
}

test("TV startup on a slow link and a slow CPU", async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: "ru-RU" });
  await ctx.addInitScript(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value;
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      /* no CLS API */
    }
  });
  await ctx.addInitScript(PROBE);
  await slowNet(ctx);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  page.on("requestfailed", (r) => errors.push(`failed: ${r.url()} ${r.failure()?.errorText}`));
  await page.goto("/tv/", { waitUntil: "commit" });
  await watch(page, "cold", 14_000);
  await logTimes(page, "cold (pairing)");
  const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
  expect(errors, "no errors while starting").toEqual([]);
  expect(cls, "no layout jumps").toBeLessThan(0.1);
  await expect(page.locator("p.font-mono").first()).toBeVisible({ timeout: 30_000 });
  await ctx.close();
});

test("TV startup when paired: intro → Home on a slow link and a slow CPU", async ({ browser }) => {
  test.setTimeout(300_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await phoneCtx.newPage();
  await phone.goto("/login");
  await phone.getByLabel(/username/i).fill(process.env.E2E_USER ?? "e2e-admin");
  await phone.getByLabel(/password/i).fill(process.env.E2E_PASS ?? "e2e-password-123");
  await phone.getByRole("button", { name: /sign in/i }).click();
  await expect(phone.getByRole("heading", { name: /welcome/i })).toBeVisible();

  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: "ru-RU" });
  await ctx.addInitScript(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value;
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      /* no CLS API */
    }
  });
  await ctx.addInitScript(PROBE);
  await slowNet(ctx);
  const tv = await ctx.newPage();
  const errors: string[] = [];
  tv.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  tv.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono").first();
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/, { timeout: 60_000 });
  const code = (await codeEl.textContent())!.trim();
  const name = `E2E Startup TV ${Date.now()}`;
  await phone.goto(`/pair?code=${code}`);
  await phone.getByLabel(/tv name/i).fill(name);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 60_000 });
  try {
    const picker = tv.getByRole("heading", { name: /кто смотрит|who's watching/i });
    if (await picker.isVisible({ timeout: 8_000 }).catch(() => false)) await tv.keyboard.press("Enter");
    await tv.waitForTimeout(3000);
    errors.length = 0;
    // Cold relaunch, as MSX does.
    await tv.goto("/tv/", { waitUntil: "commit" });
    await watch(tv, "warm", 7_000);
    if (await picker.isVisible().catch(() => false)) await tv.keyboard.press("Enter");
    await watch(tv, "home", 12_000);
    await logTimes(tv, "warm (paired)");
    // Second relaunch: the cached theme must apply from the first frame.
    await tv.goto("/tv/", { waitUntil: "commit" });
    await watch(tv, "again", 6_000);
    if (await picker.isVisible().catch(() => false)) await tv.keyboard.press("Enter");
    await watch(tv, "home2", 6_000);
    await logTimes(tv, "again (paired)");
    const cls = await tv.evaluate(() => (window as unknown as { __cls: number }).__cls);
    expect(errors, "no errors while starting").toEqual([]);
    expect(cls, "no layout jumps").toBeLessThan(0.1);
  } finally {
    const s = await (await phoneCtx.request.get("/api/v1/auth/session")).json();
    const devs = await (await phoneCtx.request.get("/api/v1/devices")).json();
    const dev = devs.items.find((d: { name: string }) => d.name === name);
    if (dev) await phoneCtx.request.delete(`/api/v1/devices/${dev.id}`, { headers: { "X-CSRF-Token": s.csrf_token, Origin: new URL(phone.url()).origin } });
    await ctx.close();
    await phoneCtx.close();
  }
});
