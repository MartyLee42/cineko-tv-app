// Tiny static server for dist/ under the production base path
// (http://127.0.0.1:4173/cineko-tv-app/). Usage: node scripts/serve.mjs [port]
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join, normalize, resolve } from "node:path";

const dist = resolve(fileURLToPath(new URL("..", import.meta.url)), "dist");
const base = process.env.LITE_BASE || "/cineko-tv-app/";
const port = Number(process.argv[2] || process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff": "font/woff", ".woff2": "font/woff2",
};

createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://x");
  if (!url.pathname.startsWith(base)) {
    res.writeHead(302, { Location: base });
    return res.end();
  }
  let rel = decodeURIComponent(url.pathname.slice(base.length));
  let file = normalize(join(dist, rel));
  if (!file.startsWith(dist)) return res.writeHead(403).end();
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Access-Control-Allow-Origin": "*" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  }
}).listen(port, host, () => console.log(`serving ${dist} at http://${host}:${port}${base}`));
