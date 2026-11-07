// Dev tool: a WCAG contrast audit of every design, on the TV app (1920×1080) and the PWA (phone and desktop).
//
//   node scripts/contrast-audit.mjs [tv|web|all] [designs…]      (e2e container, against the dev stack)
//   env: OUT=<dir under scripts/out> (default contrast), SHOTS=1 (save the screenshots too)
//
// The catalog is mocked (no TMDB needed): posters and backdrops are generated SVGs; a backdrop is the
// adversarial case for the design (bright for dark designs, dark for light ones). For every visible text
// node the script measures the text colour (alpha and opacity composited) against the pixels behind it —
// a screenshot taken with all text made transparent, so images, gradients and scrims count — and takes
// the 10th-percentile ratio of the text box. Thresholds: TV 4.5:1 everywhere (read from 3 m); PWA 4.5:1,
// 3:1 for large text (≥ 24px, or bold ≥ 18.66px). Skipped: aria-hidden / punctuation-only text,
// disabled controls (reported as exceptions), gradient-filled text. Focus: the focused control's ring
// (TV .tv-focus.is-focused / PWA :focus-visible) must change ≥ 2 px × perimeter of pixels by ≥ 3:1.
// Output: scripts/out/<OUT>/report.json + summary.txt (+ PNGs with SHOTS=1).
import { chromium, request } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:8080";
const USER = process.env.E2E_USER ?? "e2e-admin";
const PASS = process.env.E2E_PASS ?? "e2e-password-123";
const [modeArg = "all", ...designArgs] = process.argv.slice(2);
const ALL = ["kinozal", "kinozal-light", "terminal", "projector", "wireframe", "cyberpunk", "deco", "retro80", "retro90", "popart", "constructivism", "matrix", "stickerbook", "pocketpet", "odyssey", "mult", "tarkovsky", "silent", "anderson", "noir", "vague", "western", "redroom"];
const RUNS = (designArgs.length ? designArgs : ALL).map((s) => ({ name: s, design: s.split("-")[0], theme: s.endsWith("-light") ? "light" : "dark" }));
const OUT = new URL(`./out/${process.env.OUT ?? "contrast"}/`, import.meta.url);
mkdirSync(OUT, { recursive: true });
const SHOTS = !!process.env.SHOTS;

// ------------------------------------------------------------------ mock catalog
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TITLES = ["Дюна: Часть вторая", "Сталкер", "Зеркало", "Солярис", "Бегущий по лезвию", "Интерстеллар", "Остров собак", "Отель «Гранд Будапешт»", "Мальтийский сокол", "На последнем дыхании", "Хороший, плохой, злой", "Твин Пикс"];
const media = TITLES.map((title, i) => ({
  id: uuid(i + 1), kind: i % 4 === 3 ? "series" : "movie", tmdb_id: 1000 + i, title, original_title: `Original Title ${i + 1}`,
  year: 1970 + i * 4, release_date: `${1970 + i * 4}-05-0${(i % 9) + 1}`, overview: "Пустынная планета, древние пророчества и борьба за власть. Длинное описание, чтобы проверить контраст основного текста на странице.",
  poster_path: `/poster${i % 6}.svg`, backdrop_path: `/backdrop${i % 3}.svg`, rating: 6.4 + (i % 4) * 0.6, vote_count: 1200, kp_rating: 7.1, imdb_rating: 7.8,
  genre_ids: [878, 18], award_badge: i === 1 ? { group: "cannes", count: 1 } : null,
  me: { progress_percent: i === 0 ? 0.4 : null, completed: i === 2, in_watchlist: i === 1, favorite: false, rating: null, note: null },
}));
const MOVIE = media[0];
const detail = (m) => ({
  ...m, tagline: "Будущее принадлежит смелым", runtime: 166, status: "Released", original_language: "en",
  genres: [{ id: 878, name: "Фантастика" }, { id: 18, name: "Драма" }, { id: 12, name: "Приключения" }], countries: ["US", "CA"],
  cast: ["Тимоти Шаламе", "Зендея", "Ребекка Фергюсон", "Хавьер Бардем", "Остин Батлер"].map((name, i) => ({ person_tmdb_id: 500 + i, name, character: `Персонаж ${i + 1}`, profile_path: `/poster${i % 6}.svg`, order: i })),
  crew: [{ person_tmdb_id: 600, name: "Дени Вильнёв", job: "Director", department: "Directing", profile_path: null }, { person_tmdb_id: 601, name: "Ханс Циммер", job: "Original Music Composer", department: "Sound", profile_path: null }],
  seasons: m.kind === "series" ? [1, 2].map((n) => ({ season_number: n, name: `Сезон ${n}`, overview: "", air_date: "2017-05-21", episode_count: 8, poster_path: null })) : [],
  number_of_seasons: m.kind === "series" ? 2 : null, number_of_episodes: m.kind === "series" ? 16 : null, last_air_date: null,
  external_ids: { tmdb: m.tmdb_id, imdb: "tt0000001", tvdb: null, kinopoisk: null }, trailer: null, awards: [],
});
const page = (items) => ({ items, page: 1, total_pages: 1, total_results: items.length });
const now = new Date();
const prog = (m, p) => ({ media_id: m.id, episode_id: null, season_number: null, episode_number: null, position_seconds: 3600, duration_seconds: 9960, percent: 0.36, completed: false, completed_at: null, updated_at: now.toISOString(), device_id: null, source_id: null, ...p });
const HOME_ROWS = [["trending", "all", "trending"], ["popular_movies", "movie", "popular"], ["popular_series", "series", "popular"], ["top_rated_movies", "movie", "top_rated"]].map(([key, kind, list], r) => ({ key, kind, list, items: media.slice(r % 3).concat(media.slice(0, r % 3)) }));

/** Generated artwork. Posters: saturated two-tone; backdrops: bright / mid / dark photo-like gradients with texture. */
function svgFor(file, scheme) {
  const k = Number((/(\d)/.exec(file) ?? [0, 0])[1]);
  if (file.startsWith("poster")) {
    const pal = [["#c0392b", "#f1c40f"], ["#1e3a8a", "#38bdf8"], ["#14532d", "#a3e635"], ["#581c87", "#f472b6"], ["#292524", "#f5f5f4"], ["#7c2d12", "#fdba74"]][k % 6];
    return `<svg xmlns="http://www.w3.org/2000/svg" width="342" height="513"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${pal[0]}"/><stop offset="1" stop-color="${pal[1]}"/></linearGradient></defs><rect width="342" height="513" fill="url(#g)"/><circle cx="171" cy="200" r="90" fill="${pal[1]}" opacity=".7"/><rect x="40" y="380" width="262" height="40" fill="${pal[0]}"/></svg>`;
  }
  // The adversarial backdrop: dark designs get a bright sky, light designs a night scene; texture on top.
  const bright = scheme === "light" ? k === 2 : k !== 2;
  const [a, b, c] = bright ? ["#f8f4ea", "#e6d9bf", "#bfa98a"] : ["#06070a", "#1a1f2b", "#3a4252"];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset=".6" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/>${Array.from({ length: 24 }, (_, i) => `<rect x="${(i * 211) % 1280}" y="${(i * 137) % 720}" width="${60 + (i % 5) * 40}" height="${20 + (i % 3) * 30}" fill="${i % 2 ? a : c}" opacity=".5"/>`).join("")}</svg>`;
}

async function mockCatalog(ctx, scheme) {
  const json = (route, body) => route.fulfill({ json: body });
  await ctx.route(/\/api\/v1\/images\//, (route) => {
    const file = new URL(route.request().url()).pathname.split("/").pop();
    return route.fulfill({ contentType: "image/svg+xml", body: svgFor(file, scheme) });
  });
  await ctx.route(/\/api\/v1\/catalog\/config/, (r) => json(r, { image_base_url: "/api/v1/images", poster_sizes: ["w185", "w342", "w500"], backdrop_sizes: ["w780", "w1280"], profile_sizes: ["w185"], still_sizes: ["w300"], attribution: "This product uses the TMDB API but is not endorsed or certified by TMDB.", region: "RU", available: true }));
  await ctx.route(/\/api\/v1\/catalog\/home/, (r) => json(r, { rows: HOME_ROWS }));
  await ctx.route(/\/api\/v1\/catalog\/(lists|discover|search)/, (r) => json(r, page(media)));
  await ctx.route(/\/api\/v1\/catalog\/genres/, (r) => json(r, { items: [{ id: 878, name: "Фантастика" }, { id: 18, name: "Драма" }, { id: 35, name: "Комедия" }] }));
  await ctx.route(/\/api\/v1\/media\/[^/]+(\?|$)/, (r) => {
    const id = new URL(r.request().url()).pathname.split("/").pop();
    return json(r, detail(media.find((m) => m.id === id) ?? MOVIE));
  });
  await ctx.route(/\/api\/v1\/media\/[^/]+\/(similar|recommendations)/, (r) => json(r, page(media.slice(3))));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/seasons\//, (r) => json(r, { season_number: 1, name: "Сезон 1", overview: "", air_date: "2017-05-21", poster_path: null, episodes: [1, 2, 3].map((n) => ({ id: uuid(900 + n), episode_number: n, season_number: 1, name: `Серия ${n}`, overview: "Описание серии.", air_date: "2017-05-21", runtime: 52, still_path: "/backdrop1.svg", rating: 8.1 })) }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/progress/, (r) => {
    const id = new URL(r.request().url()).pathname.split("/")[4];
    const m = media.find((x) => x.id === id) ?? MOVIE;
    return json(r, { media_id: m.id, kind: m.kind, movie: m.kind === "movie" ? prog(m, { percent: 1, completed: true, completed_at: now.toISOString() }) : null, episodes: [], seasons: [], next_up: null });
  });
  await ctx.route(/\/api\/v1\/media\/[^/]+\/(providers|quotes|facts|companion|online)/, (r) => json(r, { items: [] }));
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/continue-watching/, (r) => json(r, { items: [{ media: media[0], progress: prog(media[0]) }, { media: media[5], progress: prog(media[5], { percent: 0.7 }) }] }));
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/history/, (r) => json(r, { items: [{ media: { ...media[4], me: { ...media[4].me, rating: null } }, progress: prog(media[4], { percent: 1, completed: true, completed_at: new Date(Date.now() - 3600e3).toISOString() }) }], next_cursor: null }));
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/ratings\//, (r) => json(r, { rating: 8 }));
  await ctx.route(/\/api\/v1\/media\/[^/]+\/releases/, (r) => json(r, { items: [], searched_at: now.toISOString(), cached: true, indexer_errors: [] }));
}

const settingsRoute = (run) => async (route) => {
  if (route.request().method() !== "GET") return route.fulfill({ status: 200, json: {} });
  const body = await (await route.fetch()).json();
  return route.fulfill({ json: { ...body, design: run.design, theme: run.theme, onboarding_completed: true, seasonal_effects: "off", design_intro: false, intro: false } });
};

// ------------------------------------------------------------------ in-page measuring
const FREEZE = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";
// In a cascade layer: layered !important beats every unlayered !important colour of the app.
const HIDE_TEXT = "@layer mtaudit{*,*::before,*::after,*::placeholder,*::marker{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;text-decoration-color:transparent!important;-webkit-text-stroke-color:transparent!important}}";

/** Fixed decorations at the viewport edges drawn by ::before/::after (not hit-testable): text that
 *  scrolls under them is partly hidden while it passes. Matched by design + where the text box is. */
const EDGE_DECOR = {
  // «Красная комната»: 12 px red curtains down both sides, a 14 px zigzag floor at the bottom (TV: 50 px floor).
  redroom: { side: 16, bottom: 18, tvBottom: 60, why: "under the fixed curtains/floor strip (scrolls clear)" },
  // «Тамагочи» (TV): the pastel toy shell frames the LCD; a row's last card slides under its edge.
  pocketpet: { side: 48, bottom: 0, tvBottom: 0, why: "under the toy shell's frame (row scrolls clear)" },
};
function edgeDecoration(design, m) {
  const d = EDGE_DECOR[design.split("-")[0]];
  if (!d || !m.box) return null;
  const [l, , r, b] = m.box, [W, H] = m.viewport;
  return l < d.side || r > W - d.side || b > H - (m.tv ? d.tvBottom : d.bottom) ? d.why : null;
}

/** Runs in the page: every visible text node (grouped by its element) with colour, size and boxes. */
function collectText() {
  const parse = (s) => {
    const m = /rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[, /]+([\d.]+%?))?\)/.exec(s);
    if (!m) return null;
    let a = m[4] == null ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [+m[1], +m[2], +m[3], a];
  };
  const W = innerWidth, H = innerHeight;
  const pe = document.createElement("style");
  pe.textContent = "*{pointer-events:auto!important}";
  document.head.appendChild(pe);
  const tok = (n) => (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "").replace(/\s/g, "");
  const ink = tok("--mt-text");
  const tokens = { ok: tok("--mt-ok"), danger: tok("--mt-danger"), warn: tok("--mt-warn"), accent: tok("--mt-accent"), "accent-text": tok("--mt-accent-text"), "accent-strong": tok("--mt-accent-strong") };
  // Is `el` hidden at (x, y)? Any layer stacked above it with text, an opaque fill or an opaque picture.
  // Text-less see-through layers (scanlines, frames, vignettes) don't hide it: they are in the
  // screenshot, so they count against the contrast.
  const hidden = (el, x, y) => {
    for (const e of document.elementsFromPoint(x, y)) {
      if (e === el || el.contains(e) || e.contains(el)) return false;
      const s = getComputedStyle(e);
      if (parseFloat(s.opacity) < 0.9) continue;
      if ((e.textContent ?? "").trim() && e.childElementCount === 0) return true;
      if (/^(IMG|VIDEO|CANVAS)$/.test(e.tagName)) return true;
      const bg = parse(s.backgroundColor);
      if (bg && bg[3] >= 0.9) return true;
    }
    return false;
  };
  // Sticky/fixed bars at the top and bottom edges of the viewport (header, tab bar).
  const bars = [...document.querySelectorAll("header, nav, [data-testid=status-ticker]")].filter((b) => /sticky|fixed/.test(getComputedStyle(b).position));
  let barTop = 0, barBottom = H;
  for (const b of bars) {
    const r = b.getBoundingClientRect();
    if (r.height > H / 3 || r.width < W / 2) continue;
    if (r.top <= 1) barTop = Math.max(barTop, r.bottom + 4);
    else if (r.bottom >= H - 1) barBottom = Math.min(barBottom, r.top - 4);
  }
  const byEl = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n; (n = walker.nextNode()); ) {
    const text = n.nodeValue.replace(/\s+/g, " ").trim();
    if (!text || !/[\p{L}\p{N}]/u.test(text)) continue;
    const el = n.parentElement;
    if (!el || el.closest("script,style,noscript,template,title")) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility !== "visible" || cs.display === "none") continue;
    let op = 1;
    for (let e = el; e; e = e.parentElement) op *= parseFloat(getComputedStyle(e).opacity);
    if (op < 0.05) continue;
    range.selectNodeContents(n);
    // Clip by overflow ancestors, the viewport and the pinned bars (outside them).
    let clip = { l: 0, t: 0, r: W, b: H };
    if (!bars.some((b) => b.contains(el))) clip = { ...clip, t: barTop, b: barBottom };
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.overflowX !== "visible" || s.overflowY !== "visible" || s.clipPath !== "none") {
        const r = e.getBoundingClientRect();
        clip = { l: Math.max(clip.l, r.left), t: Math.max(clip.t, r.top), r: Math.min(clip.r, r.right), b: Math.min(clip.b, r.bottom) };
      }
    }
    const rects = [];
    for (const r of range.getClientRects()) {
      const x = { l: Math.max(r.left, clip.l), t: Math.max(r.top, clip.t), r: Math.min(r.right, clip.r), b: Math.min(r.bottom, clip.b) };
      if (x.r - x.l < 2 || x.b - x.t < 4) continue;
      if (hidden(el, (x.l + x.r) / 2, (x.t + x.b) / 2)) continue;
      rects.push([Math.round(x.l), Math.round(x.t), Math.round(x.r), Math.round(x.b)]);
    }
    if (!rects.length) continue;
    let item = byEl.get(el);
    if (!item) {
      const fill = cs.webkitTextFillColor && cs.webkitTextFillColor !== cs.color ? cs.webkitTextFillColor : cs.color;
      const fg = parse(fill) ?? parse(cs.color);
      const desc = el.tagName.toLowerCase() + (el.dataset.testid ? `[${el.dataset.testid}]` : "") + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).slice(0, 4).join(".") : "");
      const path = [];
      for (let e = el.parentElement, i = 0; e && i < 3; e = e.parentElement, i++) path.push(e.tagName.toLowerCase() + (e.dataset.testid ? `[${e.dataset.testid}]` : "") + (e.dataset.focusKey ? `[fk=${e.dataset.focusKey}]` : "") + (typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : ""));
      const size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight, 10) || 400;
      const rgb = fg ? `${fg[0]},${fg[1]},${fg[2]}` : "";
      const status = rgb === ink ? null : Object.keys(tokens).find((k) => tokens[k] && tokens[k] === rgb) ?? null;
      item = {
        text: "", desc, path: path.join(" < "), size, weight, fg, op,
        bgClip: /text/.test(cs.backgroundClip + cs.webkitBackgroundClip) && cs.backgroundImage !== "none",
        shadow: cs.textShadow !== "none" ? cs.textShadow.slice(0, 60) : null,
        aria: !!el.closest("[aria-hidden=true]"),
        rotated: (() => { for (let e = el; e; e = e.parentElement) { const t = getComputedStyle(e).transform; if (t && t !== "none" && !/^matrix\(([-\d.e]+), 0, 0,/.test(t)) return true; } return false; })(),
        disabled: !!el.closest(":disabled,[aria-disabled=true]"),
        status, rects: [],
      };
      byEl.set(el, item);
    }
    if (item.text.length < 60) item.text = (item.text + " " + text).trim().slice(0, 60);
    item.rects.push(...rects);
  }
  pe.remove();
  return [...byEl.values()];
}

/** Runs in the page: contrast of each item against a text-less screenshot (base64 PNG). */
async function measure([png, items, tv]) {
  const img = await new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = "data:image/png;base64," + png; });
  const cv = document.createElement("canvas");
  cv.width = img.width; cv.height = img.height;
  const g = cv.getContext("2d");
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height).data;
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const L = (r, gg, b) => 0.2126 * lin(r) + 0.7152 * lin(gg) + 0.0722 * lin(b);
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  return items.map((it) => {
    if (!it.fg) return { ...it, ratio: null };
    const a = it.fg[3] * it.op;
    const rs = [];
    let sr = 0, sg = 0, sb = 0;
    // The glyphs sit in the middle of the line box: sample its central 70% (not the leading or a
    // rounded pill's corners).
    for (const [l0, t0, r0, b0] of it.rects) {
      const ih = Math.round((b0 - t0) * 0.15), l = l0 + 1, r = r0 - 1, t = t0 + ih, b = b0 - ih;
      const step = Math.max(1, Math.floor(Math.min(r - l, b - t) / 8));
      for (let y = t; y < b; y += step) for (let x = l; x < r; x += step) {
        const k = (y * img.width + x) * 4;
        const br = d[k], bg = d[k + 1], bb = d[k + 2];
        const fr = a * it.fg[0] + (1 - a) * br, fgc = a * it.fg[1] + (1 - a) * bg, fb = a * it.fg[2] + (1 - a) * bb;
        rs.push(ratio(L(fr, fgc, fb), L(br, bg, bb)));
        sr += br; sg += bg; sb += bb;
      }
    }
    if (!rs.length) return { ...it, ratio: null };
    rs.sort((x, y) => x - y);
    const p10 = rs[Math.floor(rs.length * 0.1)];
    const large = it.size >= 24 || (it.weight >= 700 && it.size >= 18.66);
    const need = tv ? 4.5 : large ? 3 : 4.5;
    const n = rs.length;
    const box = [Math.min(...it.rects.map((x) => x[0])), Math.min(...it.rects.map((x) => x[1])), Math.max(...it.rects.map((x) => x[2])), Math.max(...it.rects.map((x) => x[3]))];
    return { ...it, rects: undefined, box, viewport: [innerWidth, innerHeight], tv, ratio: Math.round(p10 * 100) / 100, median: Math.round(rs[n >> 1] * 100) / 100, need, bg: [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)] };
  });
}

/** Runs in the page: how much of a ring around `box` changes by ≥ 3:1 between two screenshots. */
async function focusChange([a, b, box]) {
  const load = (s) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = "data:image/png;base64," + s; });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  const px = (i) => { const c = document.createElement("canvas"); c.width = i.width; c.height = i.height; const g = c.getContext("2d"); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
  const da = px(ia), db = px(ib);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const L = (d, k) => 0.2126 * lin(d[k]) + 0.7152 * lin(d[k + 1]) + 0.0722 * lin(d[k + 2]);
  const [l, t, r, bt] = box;
  const PAD = 14, IN = 6;
  let changed = 0;
  for (let y = Math.max(0, t - PAD); y < Math.min(ia.height, bt + PAD); y++) for (let x = Math.max(0, l - PAD); x < Math.min(ia.width, r + PAD); x++) {
    const inner = x >= l + IN && x < r - IN && y >= t + IN && y < bt - IN;
    if (inner) continue;
    const k = (y * ia.width + x) * 4;
    const la = L(da, k), lb = L(db, k);
    if ((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05) >= 3) changed++;
  }
  const need = 2 * 2 * ((r - l) + (bt - t));
  return { changed, need, score: Math.round((changed / need) * 100) / 100 };
}

const report = { generated: new Date().toISOString(), runs: [] };
const results = []; // { app, design, screen, items[] }

/** The PWA scrolls: audit up to `pages` viewport-heights of it (each step a separate screen "<name>@<n>"). */
async function auditPages(p, app, design, screen, pages = 3) {
  for (let i = 0; i < pages; i++) {
    if (i > 0) {
      const moved = await p.evaluate((k) => { const y = scrollY; scrollTo(0, Math.round(k * innerHeight * 0.85)); return scrollY !== y; }, i);
      if (!moved) break;
      await p.waitForTimeout(500);
    }
    await audit(p, app, design, i ? `${screen}@${i}` : screen, false);
  }
  await p.evaluate(() => scrollTo(0, 0));
}

async function audit(p, app, design, screen, tv) {
  await p.mouse.move(0, 0);
  await p.waitForTimeout(250);
  const items = await p.evaluate(collectText);
  if (SHOTS) await p.screenshot({ path: new URL(`${app}-${design}-${screen}.png`, OUT).pathname });
  const style = await p.addStyleTag({ content: HIDE_TEXT });
  await p.waitForTimeout(60);
  const png = (await p.screenshot()).toString("base64");
  await style.evaluate((s) => s.remove());
  const measured = await p.evaluate(measure, [png, items, tv]);
  const fails = [], exceptions = [];
  for (const m of measured) {
    if (m.ratio == null) continue;
    const why = m.aria ? "aria-hidden (decorative)" : m.disabled ? "disabled" : m.bgClip || (m.fg && m.fg[3] === 0) ? "gradient/clip text" : m.rotated ? "rotated (box overlaps neighbours)" : edgeDecoration(design, m) ?? null;
    if (m.ratio < m.need) (why ? exceptions : fails).push({ ...m, why });
  }
  results.push({ app, design, screen, checked: measured.filter((m) => m.ratio != null).length, fails, exceptions });
  console.log(`${app.padEnd(9)} ${design.padEnd(15)} ${screen.padEnd(10)} checked ${String(measured.length).padStart(3)}  fail ${fails.length}${exceptions.length ? `  (exceptions ${exceptions.length})` : ""}`);
}

async function focusAudit(p, app, design, screen, getBox, unfocus, refocus, fallback) {
  const box = await getBox();
  if (!box) return;
  const clip = { x: Math.max(0, box[0] - 20), y: Math.max(0, box[1] - 20), width: box[2] - box[0] + 40, height: box[3] - box[1] + 40 };
  const vp = p.viewportSize();
  clip.width = Math.min(clip.width, vp.width - clip.x);
  clip.height = Math.min(clip.height, vp.height - clip.y);
  const local = [box[0] - clip.x, box[1] - clip.y, box[2] - clip.x, box[3] - clip.y];
  const a = (await p.screenshot({ clip })).toString("base64");
  await unfocus();
  await p.waitForTimeout(150);
  // The same element, unfocused, in the same place (a scrolled row can't be compared).
  const moved = await p.evaluate((b) => { const e = window.__mtAuditEl; if (!e) return true; const r = e.getBoundingClientRect(); return Math.abs(r.left - b[0]) > 2 || Math.abs(r.top - b[1]) > 2 || e === document.activeElement || e.classList.contains("is-focused"); }, box);
  const b = (await p.screenshot({ clip })).toString("base64");
  await refocus();
  await p.waitForTimeout(150);
  if (moved) {
    console.log(`${app.padEnd(9)} ${design.padEnd(15)} ${(screen + ":focus").padEnd(10)} not measured (focus did not move cleanly)`);
    return;
  }
  const r = await p.evaluate(focusChange, [a, b, local]);
  // Nothing changed: the focused look comes from elsewhere (a parent, a ring element) — move focus with
  // the remote instead (only where that doesn't scroll, e.g. down a settings list).
  if (r.changed === 0 && fallback) return focusAudit(p, app, design, screen, getBox, fallback[0], fallback[1]);
  results.push({ app, design, screen: `${screen}:focus`, focus: r, fails: r.score < 0.8 ? [{ text: "(focus indicator)", ratio: r.score, need: 0.8 }] : [], exceptions: [] });
  console.log(`${app.padEnd(9)} ${design.padEnd(15)} ${(screen + ":focus").padEnd(10)} ring ${r.changed}/${r.need} px ≥3:1 → ${r.score >= 0.8 ? "ok" : "WEAK"}`);
}

const browser = await chromium.launch();

// ------------------------------------------------------------------ TV
async function tvCredential() {
  const CRED = new URL("./out/tv-cred.json", import.meta.url);
  if (existsSync(CRED)) return JSON.parse(readFileSync(CRED, "utf8")).credential;
  const phoneCtx = await browser.newContext();
  const phone = await phoneCtx.newPage();
  await phone.goto(`${BASE}/login`);
  await phone.getByLabel(/username/i).fill(USER);
  await phone.getByLabel(/password/i).fill(PASS);
  await phone.getByRole("button", { name: /sign in/i }).click();
  await phone.getByRole("heading", { name: /welcome/i }).waitFor();
  const session = await (await phoneCtx.request.get(`${BASE}/api/v1/auth/session`)).json();
  const profiles = await (await phoneCtx.request.get(`${BASE}/api/v1/profiles`)).json();
  if (profiles.items.length === 0) await phoneCtx.request.post(`${BASE}/api/v1/profiles`, { data: { name: "Дом", color: "#6366f1" }, headers: { "X-CSRF-Token": session.csrf_token, Origin: BASE } });
  const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const tv = await tvCtx.newPage();
  await tv.goto(`${BASE}/tv/`);
  await tv.waitForFunction(() => /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(document.querySelector("p.font-mono")?.textContent ?? ""));
  const code = (await tv.locator("p.font-mono").textContent()).trim();
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

async function runTv(run, credential, profile) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: "ru-RU", reducedMotion: "reduce" });
  await ctx.addInitScript(([c, p, css]) => {
    localStorage.setItem("martytv.device_credential", c);
    localStorage.setItem("martytv.profile_id", p);
    localStorage.setItem("martytv.locale", "ru");
    localStorage.setItem("martytv.calm_motion", "1");
    document.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s); });
  }, [credential, profile.id, FREEZE]);
  await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, settingsRoute(run));
  const scheme = ["pocketpet", "odyssey", "mult", "anderson", "western"].includes(run.design) || run.theme === "light" ? "light" : "dark";
  await mockCatalog(ctx, scheme);
  await ctx.route(/\/api\/v1\/playback\//, () => {}); // the loader stays up; nothing ever plays
  const tv = await ctx.newPage();
  tv.on("pageerror", (e) => console.log(`[tv ${run.name}] pageerror`, e.message));
  await tv.goto(`${BASE}/tv/`);
  await tv.locator(`[data-design-skin="${run.design}"]`).waitFor({ timeout: 30000 });
  await tv.waitForTimeout(3500);
  await audit(tv, "tv", run.name, "home", true);
  const focusedBox = () => tv.evaluate(() => { const e = document.querySelector(".tv-focus.is-focused"); window.__mtAuditEl = e; if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; });
  // Unfocused look of the same element in place (moving focus would scroll rows): drop is-focused and
  // the classes a focused control adds (those an unfocused sibling control doesn't have).
  const unfocus = () => tv.evaluate(() => {
    const e = window.__mtAuditEl;
    if (!e) return;
    const sib = [...document.querySelectorAll(".tv-focus:not(.is-focused)")].find((x) => x.tagName === e.tagName && x.parentElement?.parentElement === e.parentElement?.parentElement);
    const drop = [...e.classList].filter((c) => c === "is-focused" || (sib && c !== "tv-focus" && !sib.classList.contains(c) && !/^(w-|h-|min-|max-|ml-|mr-|mt-|mb-|mx-|my-|p[xytrbl]?-|shrink|grow|basis|flex-1)/.test(c)));
    window.__mtDropped = drop;
    e.classList.remove(...drop);
  });
  const refocus = () => tv.evaluate(() => { const e = window.__mtAuditEl; if (e) e.classList.add(...(window.__mtDropped ?? [])); });
  // Into a poster row (skip "continue watching": OK there would start playback).
  await tv.keyboard.press("ArrowDown");
  await tv.waitForTimeout(700);
  if (await tv.locator('[data-focus-key*="continue"].is-focused, [data-focus-key*="continue"] .is-focused').count()) {
    await tv.keyboard.press("ArrowDown");
    await tv.waitForTimeout(700);
  }
  await tv.keyboard.press("ArrowRight");
  await tv.waitForTimeout(900);
  await audit(tv, "tv", run.name, "row", true);
  await focusAudit(tv, "tv", run.name, "row", focusedBox, unfocus, refocus);
  await tv.keyboard.press("Enter");
  try {
    await tv.locator("[data-media-id] h1").waitFor({ timeout: 15000 });
    await tv.waitForTimeout(3000);
    await audit(tv, "tv", run.name, "details", true);
    await focusAudit(tv, "tv", run.name, "details", focusedBox, unfocus, refocus);
    await tv.evaluate(() => (document.querySelector('[data-focus-key="d-play"], .tv-focus.is-focused'))?.click());
    await tv.waitForTimeout(2500);
    await audit(tv, "tv", run.name, "loader", true);
    await tv.keyboard.press("Escape");
    await tv.waitForTimeout(1000);
    await tv.keyboard.press("Escape");
    await tv.waitForTimeout(800);
  } catch (e) {
    console.log(`[tv ${run.name}] no details: ${e.message.split("\n")[0]}`);
  }
  await tv.evaluate(() => (document.querySelector('[data-menu="settings"]'))?.click());
  try {
    await tv.locator('[data-testid="tv-settings"]').waitFor({ timeout: 8000 });
    await tv.waitForTimeout(1200);
    await audit(tv, "tv", run.name, "settings", true);
    await focusAudit(tv, "tv", run.name, "settings", focusedBox, unfocus, refocus, [() => tv.keyboard.press("ArrowDown"), () => tv.keyboard.press("ArrowUp")]);
  } catch {
    console.log(`[tv ${run.name}] no settings`);
  }
  await ctx.close();
}

// ------------------------------------------------------------------ PWA
async function webLogin() {
  const login = await browser.newContext();
  const lp = await login.newPage();
  await lp.goto(`${BASE}/login`);
  await lp.getByLabel(/username/i).fill(USER);
  await lp.getByLabel(/password/i).fill(PASS);
  await lp.getByRole("button", { name: /sign in/i }).click();
  await lp.getByRole("heading", { name: /welcome/i }).waitFor();
  const state = await login.storageState();
  const session = await (await login.request.get(`${BASE}/api/v1/auth/session`)).json();
  const profileId = (await (await login.request.get(`${BASE}/api/v1/profiles`)).json()).items[0].id;
  await login.close();
  return { state, session, profileId };
}

async function runWeb(run, { state, session, profileId }) {
  for (const [tag, viewport] of [["phone", { width: 390, height: 844 }], ["desk", { width: 1440, height: 900 }]]) {
    const ctx = await browser.newContext({ viewport, storageState: state, locale: "ru-RU", reducedMotion: "reduce" });
    await ctx.addInitScript(([u, p, d, th, css]) => {
      localStorage.setItem(`martytv.active_profile.${u}`, p);
      localStorage.setItem("martytv.design", d);
      localStorage.setItem("martytv.theme", th);
      localStorage.setItem("martytv.locale", "ru");
      document.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s); });
    }, [session.user.id, profileId, run.design, run.theme, FREEZE]);
    await ctx.route(/\/api\/v1\/profiles\/[^/]+\/settings/, settingsRoute(run));
    const scheme = ["pocketpet", "odyssey", "mult", "anderson", "western"].includes(run.design) || run.theme === "light" ? "light" : "dark";
    await mockCatalog(ctx, scheme);
    const p = await ctx.newPage();
    p.on("pageerror", (e) => console.log(`[web ${run.name}] pageerror`, e.message));
    const name = `${run.name}`;
    await p.goto(`${BASE}/`);
    await p.waitForTimeout(2500);
    await auditPages(p, `web-${tag}`, name, "home");
    // The rate prompt → «Спасибо!»
    const rate = p.locator('[data-testid="rate-prompt"] [role="radio"]').nth(7);
    if (await rate.count()) {
      await rate.click();
      await p.waitForTimeout(400);
      await audit(p, `web-${tag}`, name, "thanks", false);
    }
    await p.goto(`${BASE}/title/${MOVIE.id}`);
    await p.waitForTimeout(2500);
    await auditPages(p, `web-${tag}`, name, "title");
    // Focus ring: keyboard modality (Tab), then a typical control of the page: the «watched» toggle.
    await p.keyboard.press("Tab");
    await p.evaluate(() => document.querySelector('[data-testid="toggle-watched"]')?.focus());
    const actBox = () => p.evaluate(() => { const e = document.activeElement; window.__mtAuditEl = e; if (!e || e === document.body) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; });
    await p.evaluate(() => document.activeElement?.scrollIntoView({ block: "center" }));
    await focusAudit(p, `web-${tag}`, name, "title", actBox, () => p.evaluate(() => document.activeElement?.blur()), async () => {});
    await p.goto(`${BASE}/search?q=${encodeURIComponent("дюна")}`);
    await p.waitForTimeout(2000);
    await auditPages(p, `web-${tag}`, name, "search");
    await p.goto(`${BASE}/settings`);
    await p.waitForTimeout(2000);
    await auditPages(p, `web-${tag}`, name, "settings");
    await ctx.close();
  }
}

const mode = modeArg;
if (mode === "tv" || mode === "all") {
  const credential = await tvCredential();
  const api = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${credential}` } });
  const profile = (await (await api.get("/api/v1/profiles")).json()).items[0];
  for (const run of RUNS) await runTv(run, credential, profile).catch((e) => console.log(`[tv ${run.name}] FAILED`, e.message.split("\n")[0]));
}
if (mode === "web" || mode === "all") {
  const login = await webLogin();
  for (const run of RUNS) await runWeb(run, login).catch((e) => console.log(`[web ${run.name}] FAILED`, e.message.split("\n")[0]));
}
await browser.close();

// ------------------------------------------------------------------ report
report.runs = results;
writeFileSync(new URL("report.json", OUT), JSON.stringify(report, null, 1));
const lines = [];
const per = new Map();
for (const r of results) {
  const k = `${r.design}\t${r.app.startsWith("tv") ? "tv" : "web"}`;
  per.set(k, (per.get(k) ?? 0) + r.fails.length);
}
lines.push("failures per design (tv / web phone+desk):");
for (const run of RUNS) lines.push(`  ${run.name.padEnd(15)} tv ${String(per.get(`${run.name}\ttv`) ?? "-").padStart(3)}   web ${String(per.get(`${run.name}\tweb`) ?? "-").padStart(3)}`);
lines.push(`total: ${results.reduce((s, r) => s + r.fails.length, 0)}`);
lines.push("");
for (const r of results) {
  for (const f of r.fails) lines.push(`${r.app} ${r.design} ${r.screen}: ${f.ratio}:1 < ${f.need}  "${f.text}"  ${f.desc ?? ""}${f.status ? ` [status:${f.status}]` : ""}  fg=${f.fg ? f.fg.join(",") : ""} op=${f.op ?? ""} bg≈${f.bg ? f.bg.join(",") : ""}  (${f.size ?? ""}px/${f.weight ?? ""})  < ${f.path ?? ""}`);
  for (const f of r.exceptions) lines.push(`  (exception: ${f.why}) ${r.app} ${r.design} ${r.screen}: ${f.ratio}:1 "${f.text}" ${f.desc}`);
}
writeFileSync(new URL("summary.txt", OUT), lines.join("\n") + "\n");
console.log(lines.slice(0, RUNS.length + 3).join("\n"));
