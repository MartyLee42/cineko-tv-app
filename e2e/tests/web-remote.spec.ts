import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { quietHome } from "./quietHome";

const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";

/** Searches on the phone and opens the first result; returns its media id. */
async function openFromSearch(phone: Page, query: string) {
  await phone.goto(`/search?q=${encodeURIComponent(query)}`);
  const card = phone.getByTestId("poster-card").first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();
  await expect(phone).toHaveURL(/\/title\/[0-9a-f-]{36}/);
  await expect(phone.getByRole("heading", { level: 1 })).not.toBeEmpty({ timeout: 20_000 });
  return phone.url().split("/title/")[1]!.split(/[?#]/)[0]!;
}

/** Presses "Send to TV", choosing `deviceName` if a picker opens (several online TVs). */
async function sendToTv(phone: Page, deviceName: string) {
  await phone.getByTestId("send-to-tv").click();
  const picker = phone.getByTestId("tv-picker");
  const result = phone.getByTestId("send-result");
  await expect(picker.or(result)).toBeVisible({ timeout: 20_000 });
  if (await picker.isVisible()) await picker.getByRole("button", { name: new RegExp(deviceName) }).click();
  await expect(result).toBeVisible({ timeout: 20_000 });
  await expect(result).toHaveAttribute("data-outcome", "sent");
}

/**
 * Phase 3 acceptance: selecting a title on the phone opens the same title's
 * Details on the paired TV without reloading it; the phone's remote shows
 * what is on the TV, live.
 */
test("send to TV opens the same title on the TV, live remote follows", async ({ browser }) => {
  test.setTimeout(150_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US" });
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
  await quietHome(tvCtx);
  const phone = await phoneCtx.newPage();
  const tv = await tvCtx.newPage();

  await phone.goto("/login");
  await phone.getByLabel(/username/i).fill(USER);
  await phone.getByLabel(/password/i).fill(PASS);
  await phone.getByRole("button", { name: /sign in/i }).click();
  await expect(phone.getByRole("heading", { name: /welcome/i })).toBeVisible();

  // The TV needs a profile to show Details.
  const origin = new URL(phone.url()).origin;
  const session = await (await phoneCtx.request.get("/api/v1/auth/session")).json();
  const profiles = await (await phoneCtx.request.get("/api/v1/profiles")).json();
  if (profiles.items.length === 0) {
    const r = await phoneCtx.request.post("/api/v1/profiles", {
      data: { name: "E2E", color: "#6366f1" },
      headers: { "X-CSRF-Token": session.csrf_token, Origin: origin },
    });
    expect(r.ok()).toBeTruthy();
  }

  // Pair the TV.
  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E Remote TV ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });

  try {
    // Choose a profile on the TV if it asks.
    const picker = tv.getByRole("heading", { name: /who's watching/i });
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await tv.keyboard.press("Enter");
    }
    await expect(tv.getByText("Trending this week").first()).toBeVisible({ timeout: 30_000 });

    const devices = (await (await phoneCtx.request.get("/api/v1/devices")).json()).items as { id: string; name: string }[];
    const deviceId = devices.find((d) => d.name === deviceName)!.id;

    // Any reload of the TV page would reset this marker.
    await tv.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));

    // Phone: find a title, send it to the TV.
    const first = await openFromSearch(phone, "The Matrix");
    await sendToTv(phone, deviceName);
    await expect(tv.locator("[data-media-id]")).toHaveAttribute("data-media-id", first, { timeout: 15_000 });
    await expect(tv.locator("[data-media-id] h1")).not.toBeEmpty({ timeout: 20_000 });
    const tvTitle = (await tv.locator("[data-media-id] h1").textContent())!.trim();

    // The phone's remote shows it as "now on TV" (from device.state).
    await phone.goto(`/remote/${deviceId}`);
    await expect(phone.getByTestId("remote-status")).toContainText(/online/i);
    const now = phone.getByTestId("now-on-tv");
    await expect(now).toHaveAttribute("data-media-id", first, { timeout: 15_000 });
    await expect(now).toContainText(tvTitle);
    await expect(phone.getByTestId("playback-soon")).toBeVisible();

    // A second title: the TV switches, and the open remote follows live.
    const remote = await phoneCtx.newPage();
    await remote.goto(`/remote/${deviceId}`);
    await expect(remote.getByTestId("now-on-tv")).toHaveAttribute("data-media-id", first, { timeout: 15_000 });

    const second = await openFromSearch(phone, "Inception");
    expect(second).not.toBe(first);
    await sendToTv(phone, deviceName);
    await expect(tv.locator("[data-media-id]")).toHaveAttribute("data-media-id", second, { timeout: 15_000 });
    await expect(remote.getByTestId("now-on-tv")).toHaveAttribute("data-media-id", second, { timeout: 15_000 });

    // The TV page was never reloaded.
    expect(await tv.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
    await remote.close();
  } finally {
    // Clean up: unpair so reruns start fresh.
    await phone.goto("/devices");
    const card = phone.locator("section", { hasText: deviceName });
    phone.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: /unpair/i }).click();
    await expect(card).toHaveCount(0);
  }
});

// ---------------------------------------------------------------- «Видео» on the TV, controlled from the phone

const VID = "remotevid01";
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const FIX = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
const vItem = (id: string, title: string) => ({
  id,
  title,
  channel_id: "UCabcdefghijklmnopqrstuv",
  channel_name: "Cineko Влог",
  channel_verified: false,
  duration_seconds: 80,
  views: 1000,
  published_at: new Date().toISOString(),
  published_text: null,
  thumbnail: `/api/v1/video/thumbs/vi/${id}/mqdefault.jpg`,
  thumbnail_hd: `/api/v1/video/thumbs/vi/${id}/hqdefault.jpg`,
  live: false,
  upcoming: false,
  short: false,
});

/** The VOD fixture (~16 s) ×5: ~80 s of fMP4 HLS. */
function playlist(): string {
  const segs = [["6.329670", "seg0.m4s"], ["3.164835", "seg1.m4s"], ["3.164835", "seg2.m4s"], ["3.428571", "seg3.m4s"]];
  const out = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:7", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD", '#EXT-X-MAP:URI="init.mp4"'];
  for (let r = 0; r < 5; r++) {
    if (r > 0) out.push("#EXT-X-DISCONTINUITY", '#EXT-X-MAP:URI="init.mp4"');
    for (const [d, f] of segs) out.push(`#EXTINF:${d},`, f!);
  }
  out.push("#EXT-X-ENDLIST", "");
  return out.join("\n");
}

/** Mocked Invidious data and streams for a context (both the TV and the phone). */
async function mockVideo(ctx: BrowserContext) {
  await ctx.route(/\/api\/v1\/video\//, (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api\/v1\/video/, "");
    if (path.startsWith("/thumbs/")) return route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#1971c2"/></svg>' });
    if (path === "/progress") return route.fulfill({ status: 204 });
    const m = /^\/videos\/([\w-]{11})$/.exec(path);
    if (m) {
      return json(route, {
        ...vItem(m[1]!, m[1] === VID ? "Пульт для YouTube" : "Похожее видео"),
        description: "",
        likes: 1,
        genre: null,
        channel: { id: "UCabcdefghijklmnopqrstuv", name: "Cineko Влог", avatar: null, subscribers: 1, video_count: 1, verified: false, subscribed: false },
        related: [vItem("remotevid02", "Похожее видео"), vItem("remotevid03", "Ещё одно")],
        in_watch_later: false,
        qualities: [1080, 720, 480, 360],
        captions: [],
        playable: true,
      });
    }
    if (path === "/feed") return json(route, { items: [], refreshed_at: null, next_offset: null });
    return json(route, { items: [] });
  });
  await ctx.route(/\/api\/v1\/playback\/sources(\?.*)?$/, (route) => {
    const body = route.request().postDataJSON() as { video_id: string; quality?: number };
    if ((body as { kind?: string }).kind !== "video") return route.fallback();
    return json(
      route,
      {
        id: "5e1f0000-0000-4000-8000-0000000000cc", media_id: null, episode_id: null, release: null, status: "ready", error: null, file: null,
        stream_url: `/api/v1/vstream/ok-${body.video_id}-${body.quality ?? 0}/master.m3u8`, stream_expires_at: new Date(Date.now() + 3600_000).toISOString(),
        mime_type: "application/vnd.apple.mpegurl", media_info: null, torrent: null, created_at: new Date().toISOString(), kind: "video", live: false,
        video_id: body.video_id, provider: null, format: "hls", quality: body.quality ?? 720, qualities: [1080, 720, 480, 360], subtitles: [],
        duration_seconds: 80, fallback_url: null, position_seconds: null,
      },
      201,
    );
  });
  await ctx.route(/\/api\/v1\/vstream\//, (route) => {
    const file = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (file === "master.m3u8") return route.fulfill({ status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" }, body: playlist() });
    return route.fulfill({ status: 200, headers: { "Content-Type": "video/mp4" }, body: FIX(`hls/${file}`) });
  });
}

test("remote: a YouTube video on the TV — title, live position, pause/seek/quality/next/stop", async ({ browser }) => {
  test.setTimeout(150_000);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US" });
  const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
  await quietHome(tvCtx);
  await mockVideo(phoneCtx);
  await mockVideo(tvCtx);
  const phone = await phoneCtx.newPage();
  const tv = await tvCtx.newPage();

  await phone.goto("/login");
  await phone.getByLabel(/username/i).fill(USER);
  await phone.getByLabel(/password/i).fill(PASS);
  await phone.getByRole("button", { name: /sign in/i }).click();
  await expect(phone).not.toHaveURL(/\/login/);
  const origin = new URL(phone.url()).origin;
  const session = await (await phoneCtx.request.get("/api/v1/auth/session")).json();
  const profiles = await (await phoneCtx.request.get("/api/v1/profiles")).json();
  if (profiles.items.length === 0) {
    const r = await phoneCtx.request.post("/api/v1/profiles", { data: { name: "E2E", color: "#6366f1" }, headers: { "X-CSRF-Token": session.csrf_token, Origin: origin } });
    expect(r.ok()).toBeTruthy();
  }

  await tv.goto("/tv/");
  const codeEl = tv.locator("p.font-mono");
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const code = (await codeEl.textContent())!.trim();
  await phone.goto(`/pair?code=${code}`);
  const deviceName = `E2E YT Remote ${Date.now()}`;
  await phone.getByLabel(/tv name/i).fill(deviceName);
  await phone.getByRole("button", { name: /connect tv/i }).click();
  await expect(tv.locator("p.font-mono")).toHaveCount(0, { timeout: 15_000 });
  const devices = (await (await phoneCtx.request.get("/api/v1/devices")).json()).items as { id: string; name: string }[];
  const deviceId = devices.find((d) => d.name === deviceName)!.id;
  const player = tv.getByTestId("video-player");
  const tvTime = () => tv.locator("[data-testid=video-player] video").evaluate((v: HTMLVideoElement) => v.currentTime);

  try {
    if (await tv.getByRole("heading", { name: /who's watching|кто смотрит/i }).isVisible({ timeout: 3_000 }).catch(() => false)) await tv.keyboard.press("Enter");
    await expect(tv.locator("nav [data-menu]").first()).toBeVisible({ timeout: 30_000 });

    // Nothing plays yet: the remote says so.
    await phone.goto(`/remote/${deviceId}`);
    await expect(phone.getByTestId("remote-status")).toContainText(/online/i);
    await expect(phone.getByTestId("playback-soon")).toBeVisible();

    // The phone sends a video; the remote turns into its controls, live.
    const sent = await phone.evaluate(
      async ({ deviceId, csrf, vid }) => {
        const r = await fetch(`/api/v1/devices/${deviceId}/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
          body: JSON.stringify({ type: "video.play", payload: { video_id: vid } }),
        });
        return (await r.json()) as { ok?: boolean };
      },
      { deviceId, csrf: session.csrf_token as string, vid: VID },
    );
    expect(sent.ok).toBe(true);
    await expect(player).toHaveAttribute("data-video-id", VID, { timeout: 15_000 });
    await expect.poll(tvTime, { timeout: 20_000 }).toBeGreaterThan(0.5);

    const now = phone.getByTestId("now-on-tv");
    await expect(now).toHaveAttribute("data-video-id", VID, { timeout: 15_000 });
    await expect(phone.getByTestId("now-on-tv-title")).toHaveText("Пульт для YouTube");
    await expect(now).toContainText("Cineko Влог");
    const pb = phone.getByTestId("remote-playback");
    await expect(pb).toHaveAttribute("data-kind", "video");
    await expect(phone.getByTestId("playback-soon")).toHaveCount(0);
    await expect(phone.getByTestId("now-status")).toHaveText("Playing", { timeout: 15_000 });

    // Pause / resume from the phone.
    await pb.getByRole("button", { name: "Pause" }).click();
    await expect(player).toHaveAttribute("data-paused", "1", { timeout: 10_000 });
    await expect(phone.getByTestId("now-status")).toHaveText("Paused", { timeout: 10_000 });
    const at = await tvTime();
    await pb.getByRole("button", { name: "Forward 30 seconds" }).click();
    await expect.poll(tvTime, { timeout: 10_000 }).toBeGreaterThan(at + 20);
    await pb.getByRole("button", { name: "Play" }).click();
    await expect(player).toHaveAttribute("data-paused", "0", { timeout: 10_000 });

    // Quality in place: same video, 1080.
    await phone.getByTestId("remote-video-quality").selectOption("1080");
    await expect(player).toHaveAttribute("data-quality", "1080", { timeout: 10_000 });
    await expect(player).toHaveAttribute("data-video-id", VID);
    await expect(phone.getByTestId("remote-video-quality")).toHaveValue("1080", { timeout: 10_000 });

    // «Что дальше»: a related video.
    await phone.getByTestId("remote-video-related").first().click();
    await expect(player).toHaveAttribute("data-video-id", "remotevid02", { timeout: 10_000 });
    await expect(now).toHaveAttribute("data-video-id", "remotevid02", { timeout: 15_000 });
    await phone.screenshot({ path: "test-results/video-shots/web-remote-live.png", fullPage: true });

    // Stop.
    await phone.getByTestId("remote-video-stop").click();
    await expect(player).toHaveCount(0, { timeout: 10_000 });
    await expect(phone.getByTestId("playback-soon")).toBeVisible({ timeout: 15_000 });
  } finally {
    await phoneCtx.request.delete(`/api/v1/devices/${deviceId}`, { headers: { "X-CSRF-Token": session.csrf_token, Origin: origin } }).catch(() => undefined);
    await phoneCtx.close();
    await tvCtx.close();
  }
});
