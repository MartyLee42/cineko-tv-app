import { expect, test } from "@playwright/test";

// The startup intro: plays once per start in the design's style (forced
// here with ?intro=1, since test browsers skip it), any key skips it, and
// Settings → «Анимация при запуске: Выкл» turns it off.
test("TV startup intro: shows, a key skips it, the setting turns it off", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/tv/?intro=1");
  const intro = page.getByTestId("startup-intro");
  await expect(intro).toBeVisible();
  await expect(intro).toHaveAttribute("data-design", "kinozal");
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  await expect(intro).toHaveCount(0, { timeout: 1000 });

  // On its own it ends after ~3.5 s, in the design the TV last showed.
  await page.evaluate(() => localStorage.setItem("martytv.design", "wireframe"));
  await page.reload();
  await expect(intro).toHaveAttribute("data-design", "wireframe");
  await expect(intro).toHaveCount(0, { timeout: 6000 });
  // The later designs have their own intros (VCR «PLAY», Windows-style boot, comic «БАМ!», poster diagonals).
  for (const d of ["retro80", "retro90", "popart", "constructivism"]) {
    await page.evaluate((x) => localStorage.setItem("martytv.design", x), d);
    await page.reload();
    await expect(intro).toHaveAttribute("data-design", d);
    await page.keyboard.press("Enter");
    await expect(intro).toHaveCount(0, { timeout: 1000 });
  }

  // Turned off on this TV.
  await page.evaluate(() => localStorage.setItem("martytv.startup_intro", "0"));
  await page.reload();
  await page.waitForTimeout(800);
  await expect(intro).toHaveCount(0);

  // Without ?intro=1 a test browser never sees it.
  await page.evaluate(() => localStorage.removeItem("martytv.startup_intro"));
  await page.goto("/tv/");
  await page.waitForTimeout(800);
  await expect(intro).toHaveCount(0);
});
