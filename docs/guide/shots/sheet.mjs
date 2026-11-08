// Contact sheet of shots (for review): node sheet.mjs <prefix> <out.jpg> [cols]
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
const require = createRequire("/repo/e2e/package.json");
const { chromium } = require("@playwright/test");
const [prefix, out, cols = "6"] = process.argv.slice(2);
const dir = new URL("../img/", import.meta.url).pathname;
const files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".jpg")).sort();
const html = `<body style="margin:0;background:#333;font:14px sans-serif;color:#fff;display:flex;flex-wrap:wrap">${files.map((f) => `<div style="width:${100 / +cols}%;box-sizing:border-box;padding:4px"><img src="file://${dir}${f}" style="width:100%"><div>${f}</div></div>`).join("")}</body>`;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
(await import("node:fs")).writeFileSync("/tmp/sheet.html", html);
await p.goto("file:///tmp/sheet.html");
await p.waitForTimeout(1500);
await p.screenshot({ path: out, fullPage: true, type: "jpeg", quality: 70 });
await b.close();
