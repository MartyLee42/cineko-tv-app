// Finishes dist/ for GitHub Pages after both Vite builds:
//   dist/msx/start.json  — the Media Station X start parameter file
//   dist/msx/menu.json   — the launcher page (opens the TV build)
//   dist/.nojekyll       — serve files as they are
//
// SITE_URL is the public URL of the site root, e.g.
// https://martylee42.github.io/cineko-tv-app/ (CI passes the Pages URL).
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const here = fileURLToPath(new URL("..", import.meta.url));
const dist = resolve(here, "dist");
const base = process.env.LITE_BASE || "/cineko-tv-app/";
let site = process.env.SITE_URL || `https://martylee42.github.io${base}`;
if (!site.endsWith("/")) site += "/";

if (!existsSync(resolve(dist, "index.html")) || !existsSync(resolve(dist, "tv/index.html"))) {
  console.error("assemble: build the web and tv entries first (npm run build)");
  process.exit(1);
}

mkdirSync(resolve(dist, "msx"), { recursive: true });

const start = {
  name: "Cineko Lite",
  version: "1.0.0",
  parameter: `content:${site}msx/menu.json`,
  welcome: "none",
  launcher: { icon: "play-circle-outline", image: `${site}tv/icon-256.png`, color: "msx-black-soft" },
};

const menu = {
  type: "pages",
  headline: "Cineko Lite",
  pages: [
    {
      items: [
        {
          type: "button",
          layout: "3,0,6,4",
          icon: "play-circle-outline",
          image: `${site}tv/icon-256.png`,
          imageFiller: "height",
          label: "Cineko Lite",
          action: `link:${site}tv/`,
        },
        {
          type: "space",
          layout: "0,4,12,2",
          text: [
            "{col:msx-white}Фильмы и сериалы онлайн: каталог TMDB, озвучки CDNVideoHub.{br}",
            "{col:msx-white-soft}Нажмите OK, чтобы открыть. Всё хранится на этом устройстве.",
          ],
          alignment: "center",
        },
      ],
    },
  ],
};

writeFileSync(resolve(dist, "msx/start.json"), JSON.stringify(start, null, 2) + "\n");
writeFileSync(resolve(dist, "msx/menu.json"), JSON.stringify(menu, null, 2) + "\n");
writeFileSync(resolve(dist, ".nojekyll"), "");
console.log(`assemble: msx/start.json → ${start.parameter}`);
