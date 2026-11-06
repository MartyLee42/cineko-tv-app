// Throwaway: PWA Settings (design picker) and Home in each design, phone and desktop.
// Usage (e2e container): node scripts/web-design-shots.mjs [designs…]   (default: the three later designs)
// The profile's settings are mocked per run (nothing is saved).
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:8080";
const OUT = new URL("./out/", import.meta.url);
mkdirSync(OUT, { recursive: true });
const designs = process.argv.slice(2).length ? process.argv.slice(2) : ["wireframe", "cyberpunk", "deco", "retro80", "retro90", "popart", "constructivism"];

const browser = await chromium.launch();
const login = await browser.newContext();
const lp = await login.newPage();
await lp.goto(`${BASE}/login`);
await lp.getByLabel(/username/i).fill(process.env.E2E_USER ?? "e2e-admin");
await lp.getByLabel(/password/i).fill(process.env.E2E_PASS ?? "e2e-password-123");
await lp.getByRole("button", { name: /sign in/i }).click();
await lp.getByRole("heading", { name: /welcome/i }).waitFor();
const state = await login.storageState();
const session = await (await login.request.get(`${BASE}/api/v1/auth/session`)).json();
const profileId = (await (await login.request.get(`${BASE}/api/v1/profiles`)).json()).items[0].id;
await login.close();

for (const design of designs) {
  for (const [tag, viewport] of [["phone", { width: 390, height: 844 }], ["desk", { width: 1440, height: 900 }]]) {
    const ctx = await browser.newContext({ viewport, storageState: state, locale: "ru-RU" });
    await ctx.addInitScript(([u, p, d]) => {
      localStorage.setItem(`martytv.active_profile.${u}`, p);
      localStorage.setItem("martytv.design", d);
      localStorage.setItem("martytv.theme", "dark");
      localStorage.setItem("martytv.locale", "ru");
    }, [session.user.id, profileId, design]);
    await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
      if (route.request().method() !== "GET") return route.fulfill({ json: {} });
      const body = await (await route.fetch()).json();
      return route.fulfill({ json: { ...body, design, theme: "dark", onboarding_completed: true } });
    });
    const p = await ctx.newPage();
    await p.goto(`${BASE}/settings`);
    await p.getByTestId("design-picker").waitFor();
    await p.waitForTimeout(1200);
    if (tag === "phone") await p.getByTestId("design-picker").scrollIntoViewIfNeeded();
    await p.screenshot({ path: new URL(`web-${design}-settings-${tag}.png`, OUT).pathname });
    await p.goto(`${BASE}/`);
    await p.waitForTimeout(2500);
    await p.screenshot({ path: new URL(`web-${design}-home-${tag}.png`, OUT).pathname });
    await ctx.close();
  }
  console.log("done", design);
}
await browser.close();
