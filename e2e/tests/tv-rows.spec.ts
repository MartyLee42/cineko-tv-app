// The TV emulator over every Home row: entering a row (↓) and scrolling it
// (→ held) never shows a poster that isn't ready — the cards coming in at a
// row's right edge (the last three) used to blink. Run: make tv-emu.
import { expect, test } from "@playwright/test";
import { quietHome } from "./quietHome";
import { emulateTv, takeBlinks, unshownPosters, TV_CPU } from "./tvEmulator";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

test(`TV emulator (CPU ×${TV_CPU}): no poster blink in any Home row`, async ({ browser }, info) => {
  test.setTimeout(300_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
  await quietHome(tvCtx);
  const phone = await phoneCtx.newPage();
  const tv = await tvCtx.newPage();
  await emulateTv(tvCtx, tv, {});

  await phone.goto("/login");
  await phone.getByLabel(/username/i).fill(USER);
  await phone.getByLabel(/password/i).fill(PASS);
  await phone.getByRole("button", { name: /sign in/i }).click();
  await expect(phone.getByRole("heading", { name: /welcome/i })).toBeVisible();
  const origin = new URL(phone.url()).origin;
  const session = await (await phoneCtx.request.get("/api/v1/auth/session")).json();
  const profiles = await (await phoneCtx.request.get("/api/v1/profiles")).json();
  if (profiles.items.length === 0) {
    await phoneCtx.request.post("/api/v1/profiles", { data: { name: "E2E", color: "#6366f1" }, headers: { "X-CSRF-Token": session.csrf_token, Origin: origin } });
  }
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/, { timeout: 60_000 });
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  await phone.getByLabel(/tv name/i).fill(`E2E Rows TV ${Date.now()}`);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 30_000 });
  await expect
    .poll(
      async () => {
        if ((await tv.locator("[data-screen=home]").count()) > 0) return "home";
        if (await tv.getByRole("heading", { name: /who's watching/i }).isVisible()) await tv.keyboard.press("Enter");
        return "waiting";
      },
      { timeout: 90_000 },
    )
    .toBe("home");
  await expect(tv.locator("[data-card-id] img").first()).toBeVisible({ timeout: 60_000 });
  await tv.waitForTimeout(4_000);
  await takeBlinks(tv);

  const problems: string[] = [];
  const row = () => tv.evaluate(() => document.querySelector(".is-focused")?.closest("[data-row]")?.getAttribute("data-row") ?? "?");
  for (let r = 0; r < 8; r++) {
    if (r > 0) {
      await tv.keyboard.press("ArrowDown");
      await tv.waitForTimeout(450);
      const name = await row();
      for (const p of await unshownPosters(tv)) problems.push(`enter ${name}: ${p}`);
    }
    const name = await row();
    for (let i = 0; i < 14; i++) {
      await tv.keyboard.press("ArrowRight");
      await tv.waitForTimeout(220);
      for (const p of await unshownPosters(tv)) problems.push(`→${i + 1} ${name}: ${p}`);
    }
    for (let i = 0; i < 14; i++) {
      await tv.keyboard.press("ArrowLeft");
      await tv.waitForTimeout(120);
    }
    await tv.waitForTimeout(600);
    for (const b of await takeBlinks(tv)) problems.push(`back ${name}: came back hidden ${b}`);
  }
  await info.attach("rows.txt", { body: problems.join("\n") || "(none)", contentType: "text/plain" });
  console.log(problems.join("\n") || "no blinks");
  expect(problems).toEqual([]);
});
