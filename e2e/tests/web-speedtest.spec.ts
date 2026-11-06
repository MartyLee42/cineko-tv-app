// Background speed test on the PWA: Settings → «This device» shows the
// switch (on by default), «Check now» measures against our own
// GET /speedtest (real API: the endpoint streams random bytes), the result
// is stored and re-reported as this browser's throughput, and the switch
// persists. The playback-clients API is mocked so only the report is seen.
import { expect, test, type Page } from "@playwright/test";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

test.use({ viewport: { width: 390, height: 844 }, locale: "en-US" });

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(USER);
  await page.getByLabel(/password/i).fill(PASS);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
}

test("this browser: «Check now» measures the speed and reports it", async ({ page }) => {
  // The real endpoint answers (auth + bytes).
  const direct = await page.request.get("/api/v1/speedtest?bytes=1000");
  expect([401, 200]).toContain(direct.status());

  const reports: number[] = [];
  await page.route(/\/api\/v1\/me\/playback-clients(\/[^/?]+)?(\?.*)?$/, async (route) => {
    const req = route.request();
    if (req.method() === "PATCH") {
      const body = req.postDataJSON() as { auto?: { throughput_bps?: number | null } };
      if (body.auto?.throughput_bps) reports.push(body.auto.throughput_bps);
      return route.fulfill({
        json: {
          client_id: "x",
          name: "",
          platform: "",
          auto: body.auto ?? {},
          manual: {},
          effective: { max_resolution: null, max_bitrate_bps: null, max_size_gb: null, video_codec: null, avoid_hdr: false, audio: null, prefer_smaller: false, video: null, audio_codecs: null, compat: false, default_player: null },
          constraints: [],
          updated_at: new Date().toISOString(),
        },
      });
    }
    if (new URL(req.url()).pathname.endsWith("/playback-clients")) return route.fulfill({ json: { items: [] } });
    return route.fulfill({ status: 404, json: { error: { code: "not_found", message: "not found" } } });
  });
  const tests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/speedtest")) tests.push(new URL(r.url()).searchParams.get("bytes") ?? "");
  });

  await login(page);
  await page.goto("/settings");
  const row = page.getByTestId("speedtest-row");
  await expect(row).toBeVisible();
  await expect(row.getByTestId("speedtest-toggle")).toHaveAttribute("aria-checked", "true");
  await expect(row.getByTestId("speedtest-last")).toHaveText(/not measured yet/i);

  await row.getByTestId("speedtest-run").click();
  await expect(row.getByTestId("speedtest-result")).toHaveText(/Mbit\/s/, { timeout: 20_000 });
  await expect(row.getByTestId("speedtest-last")).toHaveText(/Speed to the server: [\d.]+ Mbit\/s · just now/);
  // Adaptive: a 1 MB probe first, then a bigger sample.
  expect(tests[0]).toBe(String(1 << 20));
  expect(tests.length).toBeGreaterThanOrEqual(2);
  // The new estimate is re-reported as this browser's throughput.
  await expect.poll(() => reports.length).toBeGreaterThan(0);

  // The switch persists (per browser).
  await row.getByTestId("speedtest-toggle").click();
  await expect(row.getByTestId("speedtest-toggle")).toHaveAttribute("aria-checked", "false");
  await page.reload();
  await expect(page.getByTestId("speedtest-toggle")).toHaveAttribute("aria-checked", "false");
  expect(await page.evaluate(() => localStorage.getItem("martytv.speedtest_bg"))).toBe("0");
});
