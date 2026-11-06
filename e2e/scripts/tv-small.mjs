// Small-TV pass: key screens of every design at 1280×720 and 960×540 (the
// 1920×1080 canvas scaled by fit()), plus an audit of each screen: visible
// text below 22 canvas px and text within 48 canvas px of the edge (5 %
// overscan). Usage (e2e container):
//   node scripts/tv-small.mjs [designs…]      e.g. kinozal terminal deco
//   VIEWPORTS=1280x720 node scripts/tv-small.mjs
// Output: scripts/out/small/<viewport>/<design>-<screen>.png and audit.json.
// Never plays anything (playback and live streams are held).
import { chromium, request } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:8080";
const OUT = new URL("./out/small/", import.meta.url);
const CRED = new URL("./out/tv-cred.json", import.meta.url);
const DESIGNS = process.argv.slice(2).length ? process.argv.slice(2) : ["kinozal", "terminal", "projector", "wireframe", "cyberpunk", "deco", "retro80", "retro90", "popart", "constructivism"];
const VIEWPORTS = (process.env.VIEWPORTS ?? "1280x720,960x540").split(",").map((v) => v.split("x").map(Number));
const RAIL = new Set(["kinozal", "deco", "retro80"]);
const MIN_FONT = 22;
const SAFE = 48;

if (!existsSync(CRED)) throw new Error("pair a TV first: node scripts/tv-shots.mjs kinozal");
const credential = JSON.parse(readFileSync(CRED, "utf8")).credential;
const api = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${credential}` } });
const profile = (await (await api.get("/api/v1/profiles")).json()).items[0];
const deviceId = (await (await api.get("/api/v1/devices/me")).json()).id;
const phone = await request.newContext({ baseURL: BASE });
await phone.post("/api/v1/auth/login", { data: { username: "e2e-admin", password: "e2e-password-123" }, headers: { Origin: BASE } });
const csrf = (await (await phone.get("/api/v1/auth/session")).json()).csrf_token;
const openOnTv = (mediaId) => phone.post(`/api/v1/devices/${deviceId}/commands`, { data: { type: "media.open", payload: { media_id: mediaId } }, headers: { "X-CSRF-Token": csrf, Origin: BASE } });
const seriesId = (await (await api.get("/api/v1/catalog/search?q=Breaking%20Bad&kind=series&lang=ru")).json()).items[0].id;

/** In-page audit: small text and text in the overscan band, in canvas coordinates. */
function audit({ min, safe }) {
  const root = document.getElementById("root");
  const r0 = root.getBoundingClientRect();
  const s = r0.width / 1920;
  const out = [];
  const seen = new Set();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hidden = (el) => {
    for (let e = el; e && e !== root; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return true;
    }
    return false;
  };
  while (walker.nextNode()) {
    const t = walker.currentNode;
    const text = (t.textContent ?? "").trim();
    if (!text || text.length < 2) continue;
    const el = t.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const x = (r.left - r0.left) / s, y = (r.top - r0.top) / s, w = r.width / s, h = r.height / s;
    if (x + w <= 0 || y + h <= 0 || x >= 1920 || y >= 1080) continue;
    if (hidden(el)) continue;
    // Covered by an overlay or clipped away: the top element at its centre isn't it (nor inside it).
    const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1), cy = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
    const top = document.elementFromPoint(cx, cy);
    if (top && top !== el && !el.contains(top) && !top.contains(el)) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    const small = fs < min;
    const edge = x < safe || y < safe || x + w > 1920 - safe || y + h > 1080 - safe;
    if (small || edge) out.push({ fs, small, edge, box: [Math.round(x), Math.round(y), Math.round(w), Math.round(h)], cls: String(el.className).slice(0, 90), text: text.slice(0, 48) });
  }
  return out;
}

async function context(browser, [w, h], design, extra = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: "ru-RU" });
  if (!extra.unpaired) {
    await ctx.addInitScript(
      ([c, p]) => {
        localStorage.setItem("martytv.device_credential", c);
        localStorage.setItem("martytv.profile_id", p);
        localStorage.setItem("martytv.locale", "ru");
      },
      [credential, profile.id],
    );
  } else {
    await ctx.addInitScript(() => localStorage.setItem("martytv.locale", "ru"));
  }
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, async (route) => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 200, json: {} });
    const body = await (await route.fetch()).json();
    return route.fulfill({ json: { ...body, design, theme: "dark", onboarding_completed: !extra.onboarding } });
  });
  // Demo releases (never played), held playback and live streams.
  const rel = (id, p) => ({ id, title: `Demo.${id}`, indexer: "RuTracker", size_bytes: 14.6 * 1024 ** 3, seeders: 847, leechers: 3, published_at: null, info_hash: null, resolution: "1080p", video_codec: "h264", hdr: null, audio_codecs: ["ac3"], languages: ["ru"], voiceovers: [{ kind: "dub", studio: null, language: "ru" }], release_group: null, source_quality: "web-dl", year: 2024, seasons: [], episodes: [], is_season_pack: false, confidence: 0.95, score: 1, reasons: [], warnings: [], ...p });
  const items = [rel("a", { resolution: "2160p", hdr: "hdr10", audio_codecs: ["truehd"], size_bytes: 61 * 1024 ** 3 }), rel("b", { indexer: "Kinozal" }), rel("c", { resolution: "720p", indexer: "Rutor" }), rel("d", { voiceovers: [{ kind: "mvo", studio: null, language: "ru" }], indexer: "NNM" })];
  await ctx.route(/\/api\/v1\/media\/[^/]+\/releases/, (route) => route.fulfill({ json: { items, searched_at: new Date().toISOString(), cached: true, indexer_errors: [] } }));
  await ctx.route(/\/api\/v1\/playback\//, () => {});
  await ctx.route(/\/api\/v1\/live\//, () => {});
  // IPTV demo channels.
  const now = Date.now();
  const at = (m) => new Date(now + m * 60000).toISOString();
  const cid = (n) => `c0ffee00-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const names = ["Первый", "Россия 1", "Матч ТВ", "НТВ", "Пятый канал", "Культура", "Кино Хит", "Мульт", "Наука"];
  const list = names.map((name, i) => ({
    id: cid(i + 1), number: i + 1, custom_number: null, name, logo_url: `/api/v1/iptv/logos/${cid(i + 1)}?v=1`, group_id: "news", group: "News", playlist_id: cid(900), favorite: i === 2, hidden: false, offline: false, format: "hls", has_epg: true,
    now: { start: at(-20), stop: at(40), title: "Вечерние новости", description: null, category: null }, next: { start: at(40), stop: at(100), title: "Документальный цикл", description: null, category: null },
  }));
  await ctx.route(/\/api\/v1\/iptv\/channels(\?.*)?$/, (route) => route.fulfill({ json: { items: list, groups: [{ id: "news", name: "News", count: list.length }], favorites_count: 1, last_channel_id: cid(2), server_time: new Date().toISOString() } }));
  await ctx.route(/\/api\/v1\/iptv\/state(\?.*)?$/, (route) => route.fulfill({ json: { available: true, channel_count: list.length, last: null, playlists: [] } }));
  await ctx.route(/\/api\/v1\/iptv\/logos\//, (route) => route.fulfill({ status: 200, contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" rx="18" fill="#1971c2"/></svg>` }));
  return ctx;
}

mkdirSync(OUT, { recursive: true });
const report = {};
const browser = await chromium.launch();

for (const vp of VIEWPORTS) {
  const tag = `${vp[0]}x${vp[1]}`;
  const dir = new URL(`${tag}/`, OUT);
  mkdirSync(dir, { recursive: true });
  for (const design of DESIGNS) {
    const shots = [];
    const take = async (page, name) => {
      await page.screenshot({ path: new URL(`${design}-${name}.png`, dir).pathname });
      const found = await page.evaluate(audit, { min: MIN_FONT, safe: SAFE });
      shots.push({ screen: name, found });
    };
    const menu = async (tv, id, wait = 3000) => {
      await tv.evaluate((m) => document.querySelector(`[data-menu="${m}"]`)?.click(), id);
      await tv.waitForTimeout(wait);
    };
    const ctx = await context(browser, vp, design);
    const tv = await ctx.newPage();
    try {
      await tv.goto(`${BASE}/tv/`);
      await tv.locator(`[data-design-skin="${design}"]`).waitFor({ timeout: 30000 });
      await tv.waitForTimeout(3500);
      await take(tv, "home");
      await openOnTv(seriesId);
      await tv.locator("[data-media-id] h1").waitFor({ timeout: 20000 });
      await tv.waitForTimeout(3500);
      await take(tv, "details-series");
      await tv.keyboard.press("ArrowDown");
      await tv.waitForTimeout(500);
      await tv.keyboard.press("ArrowDown");
      await tv.waitForTimeout(1200);
      await take(tv, "details-episodes");
      // Release picker (Терминал shows its sources table inline in Details).
      await tv.keyboard.press("Escape");
      await tv.waitForTimeout(800);
      if (await tv.locator('[data-focus-key="d-sources"]').count()) {
        await tv.evaluate(() => document.querySelector('[data-focus-key="d-sources"]')?.click());
        await tv.waitForTimeout(1500);
        await take(tv, "release-picker");
        await tv.keyboard.press("Escape");
        await tv.waitForTimeout(800);
      }
      // Player loader (playback is held).
      await tv.evaluate(() => document.querySelector('[data-focus-key="d-play"]')?.click());
      await tv.waitForTimeout(3000);
      await take(tv, "player-loader");
      await tv.keyboard.press("Escape");
      await tv.waitForTimeout(1200);
      await tv.keyboard.press("Escape");
      await tv.waitForTimeout(1200);
      for (const [id, name, wait] of [["movies", "browse", 3500], ["search", "search", 2000], ["tv", "tv", 2500], ["explore", "explore", 5000], ["ask", "ask", 2500], ["history", "history", 2500]]) {
        await menu(tv, id, wait);
        await take(tv, name);
      }
      // Live OSD from the ТВ grid.
      await menu(tv, "tv", 2500);
      await tv.keyboard.press(RAIL.has(design) ? "ArrowRight" : "ArrowDown");
      await tv.waitForTimeout(300);
      await tv.keyboard.press("Enter");
      if (await tv.locator('[data-testid="live-player"]').waitFor({ timeout: 8000 }).then(() => true, () => false)) {
        await tv.waitForTimeout(2000);
        await take(tv, "live-osd");
        await tv.keyboard.press("Enter");
        await tv.waitForTimeout(1000);
        await take(tv, "live-list");
        await tv.keyboard.press("Escape");
        await tv.waitForTimeout(500);
        await tv.keyboard.press("Escape");
        await tv.waitForTimeout(1500);
      }
      // Settings (both pages).
      await menu(tv, "settings", 1500);
      await take(tv, "settings-1");
      for (let i = 0; i < 12; i++) {
        await tv.keyboard.press("ArrowDown");
        await tv.waitForTimeout(120);
      }
      await tv.waitForTimeout(800);
      await take(tv, "settings-2");
      await tv.keyboard.press("Escape");
      await tv.waitForTimeout(800);
      // Profile picker.
      await menu(tv, "profile", 2500);
      await take(tv, "profiles");
    } catch (e) {
      console.log(`[${tag} ${design}] stopped:`, e.message.split("\n")[0]);
    }
    await ctx.close();
    // First-run guide (step 1: look) and pairing (unpaired TV).
    const og = await context(browser, vp, design, { onboarding: true });
    const g = await og.newPage();
    try {
      await g.goto(`${BASE}/tv/`);
      await g.getByTestId("tv-onboarding").waitFor({ timeout: 30000 });
      await g.waitForTimeout(2000);
      await take(g, "onboarding");
    } catch (e) {
      console.log(`[${tag} ${design}] onboarding:`, e.message.split("\n")[0]);
    }
    await og.close();
    if (design === DESIGNS[0]) {
      const pc = await context(browser, vp, design, { unpaired: true });
      const p = await pc.newPage();
      await p.goto(`${BASE}/tv/`);
      await p.waitForTimeout(4000);
      await take(p, "pairing");
      await pc.close();
    }
    report[`${tag}/${design}`] = shots;
    console.log("done", tag, design);
  }
}
writeFileSync(new URL("audit.json", OUT), JSON.stringify(report, null, 1));

// Summary: distinct small texts / edge texts per class.
const small = new Map();
const edge = new Map();
for (const [k, shots] of Object.entries(report)) {
  if (!k.startsWith(`${VIEWPORTS[0][0]}x`)) continue;
  for (const s of shots) {
    for (const f of s.found) {
      const key = `${f.fs}px | ${f.cls}`;
      const m = f.small ? small : edge;
      if (!f.small && !f.edge) continue;
      if (!m.has(key)) m.set(key, new Set());
      m.get(key).add(`${k.split("/")[1]}:${s.screen}: ${f.text} @${f.box.join(",")}`);
    }
  }
}
console.log(`\n== text < ${MIN_FONT}px (${small.size} kinds)`);
for (const [k, v] of small) console.log(k, "\n   ", [...v].slice(0, 3).join("\n    "));
console.log(`\n== text within ${SAFE}px of the edge (${edge.size} kinds)`);
for (const [k, v] of edge) console.log(k, "\n   ", [...v].slice(0, 3).join("\n    "));
await browser.close();
