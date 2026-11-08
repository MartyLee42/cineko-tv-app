// Renders the Cineko guides (Russian) from the HTML sources next to this file:
//   cineko-guide.pdf       «Как пользоваться Cineko» (guide.html)
//   cineko-install-tv.pdf  «Как установить Cineko на телевизор» (install-tv.html)
// into docs/guide/out/ (not in git; published as a GitHub release).
// Runs inside the e2e Playwright container (repo mounted at /repo):
//   node /repo/docs/guide/render.mjs [guide|install-tv]
// SITE=<address> replaces {{SITE}} (default: an example address). The look is
// «Каркас»: wave-terrain art with the sun glow is added to the cover and every
// part divider; the design and loading galleries are generated from the app's
// own lists (packages/ui designs, the TV's LOADING_STYLES) and Russian strings.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";

const require = createRequire("/repo/e2e/package.json");
const { chromium } = require("@playwright/test");
const SRC = new URL("./", import.meta.url).pathname;
const OUT = new URL("./out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const SITE = process.env.SITE || "tv.example.com";
const DOCS = { guide: "cineko-guide.pdf", "install-tv": "cineko-install-tv.pdf" };
const only = process.argv.slice(2);

// ---- the app's lists and Russian names
const listFrom = (file, re) => JSON.parse(re.exec(readFileSync(file, "utf8"))[1]);
const DESIGNS = listFrom("/repo/packages/ui/src/designs.ts", /export const DESIGNS: DesignSetting\[\] = (\[[^\]]*\])/);
const LOADERS = listFrom("/repo/apps/tv/src/profile/settings.ts", /export const LOADING_STYLES: readonly LoadingStyle\[\] = (\[[^\]]*\])/);
const LOC = "/repo/packages/ui/src/locales";
const RU = readdirSync(LOC).filter((f) => f.endsWith(".ru.ts")).map((f) => readFileSync(`${LOC}/${f}`, "utf8")).join("\n");
const say = (key) => {
  const m = new RegExp(`"${key.replace(/\./g, "\\.")}": "((?:[^"\\\\]|\\\\.)*)"`).exec(RU);
  return m ? m[1].replace(/\\"/g, '"') : null;
};
// Loader names live under several prefixes (settings.loading.*, loaders2.*, …).
const anyKey = (suffix) => {
  const m = new RegExp(`"[a-z0-9_]+(?:\\.[a-z0-9_]+)*\\.${suffix.replace(/\./g, "\\.")}": "((?:[^"\\\\]|\\\\.)*)"`).exec(RU);
  return m ? m[1].replace(/\\"/g, '"') : null;
};
const loaderName = (l) => say(`settings.loading.${l}`) ?? anyKey(l);
const loaderHint = (l) => say(`settings.loading.${l}_hint`) ?? anyKey(`${l}_hint`);
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");

// ---- «Каркас» wave terrain: wireframe ridges toward a big soft magenta sun.
let tid = 0;
function terrain({ h = 120, rows = 14, sun = 1, stars = 8, seed = 1, fade = 1, cls = "terrain" } = {}) {
  const W = 210;
  const id = `tg${++tid}`;
  const horizon = h * 0.34;
  let rnd = seed * 7919 + 13;
  const r = () => ((rnd = (rnd * 9301 + 49297) % 233280) / 233280);
  const ridges = [];
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1);
    const y = horizon + (h - horizon) * Math.pow(t, 1.55);
    const amp = 1 + 14 * Math.pow(t, 1.4);
    const f1 = 0.035 + r() * 0.02, f2 = 0.09 + r() * 0.05, p1 = r() * 6.28, p2 = r() * 6.28;
    let d = "";
    for (let x = -2; x <= W + 2; x += 1.5) {
      const hill = Math.max(0, Math.sin(x * f1 + p1)) * 0.75 + Math.max(0, Math.sin(x * f2 + p2)) * 0.35;
      d += `${d ? "L" : "M"}${x.toFixed(1)} ${(y - amp * hill).toFixed(2)}`;
    }
    d += `L${W + 2} ${h + 2}L-2 ${h + 2}Z`;
    ridges.push(`<path d="${d}" fill="#0d0420" stroke="#ff4fd8" stroke-opacity="${((0.25 + 0.75 * t) * fade).toFixed(2)}" stroke-width="${(0.16 + 0.4 * t).toFixed(2)}" stroke-linejoin="round"/>`);
  }
  const star = (x, y, s, c) => `<path transform="translate(${x} ${y}) scale(${s})" d="M0-5C.6-1.2 1.2-.6 5 0 1.2.6.6 1.2 0 5-.6 1.2-1.2.6-5 0-1.2-.6-.6-1.2 0-5Z" fill="${c}"/>`;
  const st = Array.from({ length: stars }, (_, i) => star((12 + r() * 186).toFixed(1), (3 + r() * (horizon - 8)).toFixed(1), (0.3 + r() * 0.4).toFixed(2), i % 3 === 0 ? "#ff4fd8" : "#f6efff")).join("");
  return `<svg class="${cls}" viewBox="0 0 ${W} ${h}" style="height:${h}mm" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs><radialGradient id="${id}"><stop offset="0" stop-color="#ff4fd8" stop-opacity=".95"/><stop offset=".35" stop-color="#ff4fd8" stop-opacity=".42"/><stop offset="1" stop-color="#ff4fd8" stop-opacity="0"/></radialGradient>
  <linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d0420" stop-opacity="0"/><stop offset="1" stop-color="#2a0f55" stop-opacity=".9"/></linearGradient></defs>
  <rect width="${W}" height="${horizon}" fill="url(#${id}s)"/>${st}
  <ellipse cx="${W / 2}" cy="${horizon}" rx="${(58 * sun).toFixed(1)}" ry="${(34 * sun).toFixed(1)}" fill="url(#${id})"/>
  <circle cx="${W / 2}" cy="${horizon}" r="${(17 * sun).toFixed(1)}" fill="#ffd2f4" fill-opacity=".5"/>
  ${ridges.join("")}</svg>`;
}

// ---- galleries (end of the guide): every design, every loading animation
// Screens per gallery page (2 columns).
const PER = 6;
function galleries() {
  const fig = (img, name, hint) => existsSync(`${SRC}${img}`) ? `<figure><img src="${img}" alt=""><figcaption><b>${esc(name)}</b>${hint ? esc(hint) : ""}</figcaption></figure>` : "";
  const pages = (part, foot, kicker, title, intro, items) => {
    const out = [];
    for (let i = 0; i < items.length; i += PER) {
      const first = i === 0;
      out.push(`<section class="page"${first ? ` data-toc="${title}"` : ""} data-foot="${foot}">
  <p class="kicker">${kicker}</p><h1>${first ? title : `${title} · ${i / PER + 1}`}</h1>${first ? `<p class="lead">${intro}</p>` : ""}
  <div class="designs gallery">${items.slice(i, i + PER).map((x) => fig(...x)).join("")}</div>
</section>`);
    }
    return out.join("\n");
  };
  const divider = (num, title, part, lead, items, mascot) => `<section class="page divider" data-toc="${title}" data-part="${part}" data-foot="${title}">
  <img class="mascot" src="../../packages/ui/src/marty/${mascot}.webp" alt="">
  <div class="num">${num}</div><h1>${title}</h1><p class="lead">${lead}</p>
  <ul>${items.map((t) => `<li>${t}</li>`).join("")}</ul>
</section>`;
  return [
    divider("03", "Все оформления", "03 · Галереи", "Главный экран телевизора в каждом оформлении — шрифты, цвета, меню и анимации у каждого свои.", [`${DESIGNS.length} оформлений`, "Настройки → Оформление", "«Сюрприз»: новое каждый день или неделю", "Избранные — звёздочкой"], "excited"),
    pages("03", "Галерея · оформления", "Галерея · оформления", "Все оформления", "Выбор: «Настройки» → «Оформление» на телевизоре или телефоне (для профиля).", DESIGNS.map((d) => [`img/tv-60-design-${d}.jpg`, say(`settings.design.${d}`) ?? d, say(`settings.design.${d}_hint`)])),
    divider("04", "Все анимации загрузки", "04 · Галереи", "Пока фильм готовится, телевизор показывает анимацию — от ведёрка попкорна до мини-игры.", [`${LOADERS.length} анимаций`, "Настройки → Анимация загрузки", "«Сюрприз» — каждый раз новая", "«Под фильм» — по жанру"], "popcorn"),
    pages("04", "Галерея · загрузка", "Галерея · загрузка", "Все анимации загрузки", "Экран загрузки в каждом стиле, снятый посередине загрузки. Выбор: настройки телевизора → «Анимация загрузки».", LOADERS.map((l) => [`img/tv-35-loader-${l}.jpg`, loaderName(l) ?? l, loaderHint(l)])),
  ].join("\n");
}

const browser = await chromium.launch();
for (const [name, pdf] of Object.entries(DOCS)) {
  if (only.length && !only.includes(name)) continue;
  const tmp = `${SRC}.render-${name}.html`;
  let html = readFileSync(`${SRC}${name}.html`, "utf8")
    .replace("<!-- {{GALLERIES}} -->", () => galleries())
    .replaceAll("{{SITE}}", SITE)
    .replaceAll("{{DESIGN_COUNT}}", String(DESIGNS.length))
    .replaceAll("{{LOADER_COUNT}}", String(LOADERS.length));
  // Wave terrain behind the cover and each part divider.
  let n = 0;
  html = html.replace(/<section class="page (cover|divider)"([^>]*)>/g, (m, kind) => `${m}${terrain(kind === "cover" ? { h: 150, rows: 16, sun: 1.35, stars: 12, seed: 7 } : { h: 105, rows: 12, sun: 0.9, seed: ++n + 2 })}`);
  // Every other page: a slim, faint terrain strip with a small sun along the bottom.
  html = html.replace(/<section class="page"([^>]*)>/g, (m) => `${m}${terrain({ h: 22, rows: 6, sun: 0.3, stars: 0, seed: ++n + 11, fade: 0.55, cls: "terrain strip" })}`);
  writeFileSync(tmp, html);
  const page = await browser.newPage();
  await page.goto(`file://${tmp}`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const pages = await page.locator(".page").count();
  // Pages clip their overflow: report any page whose content runs into the footer.
  const over = await page.evaluate(() => [...document.querySelectorAll(".page")].map((p, i) => {
    const foot = p.querySelector(".foot");
    const limit = (foot ? foot.getBoundingClientRect().top : p.getBoundingClientRect().bottom) - 2;
    const kids = [...p.children].filter((c) => c !== foot && !c.classList.contains("glow") && !c.classList.contains("terrain") && !c.classList.contains("mascot"));
    const bottom = Math.max(...kids.map((c) => c.getBoundingClientRect().bottom));
    return bottom > limit ? `page ${i + 1}: +${Math.round(bottom - limit)}px` : null;
  }).filter(Boolean));
  if (over.length) console.log(`${name}: overflow on`, over.join(", "));
  await page.pdf({ path: `${OUT}${pdf}`, format: "A4", printBackground: true, preferCSSPageSize: true });
  // PREVIEW=1: page images (out/prev-<name>-NN.png) to check the layout by eye.
  if (process.env.PREVIEW) {
    await page.setViewportSize({ width: 794, height: 1123 });
    const want = process.env.PREVIEW === "1" ? null : new Set(process.env.PREVIEW.split(",").map(Number));
    for (let i = 0; i < pages; i++) {
      if (want && !want.has(i + 1)) continue;
      await page.locator(".page").nth(i).screenshot({ path: `${OUT}prev-${name}-${String(i + 1).padStart(2, "0")}.png` });
    }
  }
  unlinkSync(tmp);
  console.log(`${pdf}: ${pages} pages, ${(statSync(`${OUT}${pdf}`).size / 1024 / 1024).toFixed(1)} MB`);
  await page.close();
}
await browser.close();
