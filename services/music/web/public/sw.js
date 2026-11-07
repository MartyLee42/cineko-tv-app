// Cineko Music service worker. Its scope is the app's base: /music/ on the
// Cineko host, / on Music's own host (MUSIC_DOMAIN). The API is /music/api
// on both.
// - Offline audio: <base>offline/<id> from Cache Storage, with Range support.
// - App shell: the page and its hashed assets, so the app opens offline.
// - Covers of downloaded tracks: /music/api/img from cache when present.
// Everything else goes to the network untouched.

const BASE = new URL(self.registration.scope).pathname;
const escaped = BASE.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const ASSET_RE = new RegExp(escaped + "assets/[^\"' )]+", "g");
const FONT_RE = new RegExp(escaped + "assets/[^\"' )]+\\.woff2?", "g");

// Paths of the app itself (not the APIs: on Music's own host the scope "/"
// also covers /api/ and /music/api/).
function isAppPath(p) {
  if (!p.startsWith(BASE)) return false;
  return !p.startsWith("/api/") && !p.startsWith("/music/api/") && !(BASE === "/" && p.startsWith("/music/"));
}

const SHELL = "mm-shell-v1";
const AUDIO = "mm-audio-v1";
const IMG = "mm-img-v1";

// The page plus every asset it references (hashed JS/CSS, fonts), so the app
// opens offline even if those files were loaded before this worker existed.
async function cacheShell() {
  const c = await caches.open(SHELL);
  const res = await fetch(BASE, { cache: "no-store" });
  if (!res.ok) return;
  const html = await res.clone().text();
  await c.put(BASE, res);
  const assets = [...new Set(html.match(ASSET_RE) || [])];
  const extra = ["manifest.webmanifest", "icon.svg", "icon-192.png", "pulsar.svg"].map((f) => BASE + f);
  await Promise.all(
    [...assets, ...extra].map(async (u) => {
      if (await c.match(u)) return;
      const r = await fetch(u);
      if (r.ok) await c.put(u, r);
      // The CSS pulls fonts: cache those too.
      if (r.ok && u.endsWith(".css")) {
        const css = await (await c.match(u)).text();
        const fonts = [...new Set(css.match(FONT_RE) || [])];
        await Promise.all(fonts.map(async (f) => (await c.match(f)) || fetch(f).then((fr) => fr.ok && c.put(f, fr))));
      }
    }),
  );
}

self.addEventListener("install", (e) => {
  e.waitUntil(cacheShell().catch(() => undefined).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

// The page asks after each load (a new deploy brings new asset names).
self.addEventListener("message", (e) => {
  if (e.data === "cache-shell") e.waitUntil(cacheShell().catch(() => undefined));
});

async function rangeResponse(req, cached) {
  const range = req.headers.get("Range");
  const type = cached.headers.get("Content-Type") || "audio/mpeg";
  if (!range) return cached;
  const blob = await cached.blob();
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? Number(m[1]) : 0;
  let end = m && m[2] ? Number(m[2]) : blob.size - 1;
  if (m && !m[1] && m[2]) {
    start = Math.max(0, blob.size - Number(m[2]));
    end = blob.size - 1;
  }
  end = Math.min(end, blob.size - 1);
  if (start > end) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${blob.size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": type,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${blob.size}`,
      "Accept-Ranges": "bytes",
    },
  });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (url.pathname.startsWith(BASE + "offline/")) {
    e.respondWith(
      caches
        .open(AUDIO)
        .then((c) => c.match(url.pathname))
        .then((hit) => (hit ? rangeResponse(req, hit) : new Response("not downloaded", { status: 404 }))),
    );
    return;
  }

  if (url.pathname === "/music/api/img") {
    e.respondWith(caches.open(IMG).then((c) => c.match(req.url).then((hit) => hit || fetch(req))));
    return;
  }

  if (!isAppPath(url.pathname)) return;

  if (url.pathname.startsWith(BASE + "assets/")) {
    // Hashed file names: cache forever.
    e.respondWith(
      caches.open(SHELL).then((c) =>
        c.match(req).then(
          (hit) =>
            hit ||
            fetch(req).then((res) => {
              if (res.ok) c.put(req, res.clone());
              return res;
            }),
        ),
      ),
    );
    return;
  }

  if (req.mode === "navigate") {
    // Offline: the saved app at once. Online: the network (fresh deploys),
    // but not longer than 4 s — Wi-Fi without internet can hang for minutes.
    const cached = () => caches.open(SHELL).then((c) => c.match(BASE));
    if (self.navigator && self.navigator.onLine === false) {
      e.respondWith(cached().then((hit) => hit || fetch(req)));
      return;
    }
    e.respondWith(
      new Promise((resolve) => {
        let done = false;
        const fallback = () =>
          cached().then((hit) => {
            if (!done && hit) {
              done = true;
              resolve(hit);
            }
          });
        const timer = setTimeout(fallback, 4000);
        fetch(req)
          .then((res) => {
            clearTimeout(timer);
            if (res.ok && (res.headers.get("Content-Type") || "").startsWith("text/html")) {
              const copy = res.clone();
              caches.open(SHELL).then((c) => c.put(BASE, copy));
            }
            if (!done) {
              done = true;
              resolve(res);
            }
          })
          .catch(() => {
            clearTimeout(timer);
            cached().then((hit) => {
              if (!done) {
                done = true;
                resolve(hit || Response.error());
              }
            });
          });
      }),
    );
  }
});
