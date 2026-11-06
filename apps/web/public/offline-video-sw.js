// Imported into the PWA service worker (workbox importScripts, vite.config.ts).
// Serves videos saved for offline play (src/offline/device.ts) from Cache
// Storage at /offline-video/<id>, with HTTP Range support so <video> can seek.
// Registered before workbox's own listener; no workbox route matches this
// path, so only this handler responds.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/offline-video/")) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open("martytv-offline-video-v1");
      const hit = await cache.match(url.pathname);
      if (!hit) return new Response("not on this device", { status: 404 });
      const type = hit.headers.get("Content-Type") || "video/mp4";
      // Blobs from Cache Storage are disk-backed: slicing doesn't read the whole file.
      const blob = await hit.blob();
      const size = blob.size;
      const range = req.headers.get("Range");
      if (!range) {
        return new Response(blob, { status: 200, headers: { "Content-Type": type, "Content-Length": String(size), "Accept-Ranges": "bytes" } });
      }
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? Number(m[1]) : 0;
      let end = m && m[2] ? Number(m[2]) : size - 1;
      if (m && !m[1] && m[2]) {
        start = Math.max(0, size - Number(m[2]));
        end = size - 1;
      }
      end = Math.min(end, size - 1);
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      }
      return new Response(blob.slice(start, end + 1), {
        status: 206,
        headers: {
          "Content-Type": type,
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Accept-Ranges": "bytes",
        },
      });
    })(),
  );
});
