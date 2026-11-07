// Imported into the PWA service worker (workbox importScripts, vite.config.ts).
// Serves videos saved for offline play (src/offline/device.ts) from Cache
// Storage at /offline-video/<id>, with HTTP Range support so <video> can seek.
// Registered before workbox's own listener; no workbox route matches this
// path, so only this handler responds.
//
// Layout: /offline-video/<id>/m is the manifest {size, chunk, count, type},
// /offline-video/<id>/c/<n> the chunks. Saves from older builds are one entry
// at /offline-video/<id>. Partial downloads have no manifest: 404.
const OFFLINE_CACHE = "martytv-offline-video-v1";

function rangeOf(header, size) {
  const m = /bytes=(\d*)-(\d*)/.exec(header || "");
  if (!m) return null;
  let start = m[1] ? Number(m[1]) : 0;
  let end = m[2] ? Number(m[2]) : size - 1;
  if (!m[1] && m[2]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  }
  end = Math.min(end, size - 1);
  return start > end || start >= size ? false : [start, end];
}

/** Bytes start…end (inclusive) as a stream, reading one chunk at a time. */
function chunkStream(cache, base, man, start, end) {
  let n = Math.floor(start / man.chunk);
  const last = Math.floor(end / man.chunk);
  return new ReadableStream({
    async pull(ctrl) {
      if (n > last) return ctrl.close();
      const hit = await cache.match(`${base}/c/${n}`);
      if (!hit) return ctrl.error(new Error("missing chunk " + n));
      const buf = new Uint8Array(await hit.arrayBuffer());
      const from = n === Math.floor(start / man.chunk) ? start % man.chunk : 0;
      const to = n === last ? (end % man.chunk) + 1 : buf.byteLength;
      ctrl.enqueue(buf.subarray(from, to));
      n += 1;
    },
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/offline-video/")) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(OFFLINE_CACHE);
      const base = url.pathname;
      const range = req.headers.get("Range");
      const mres = await cache.match(`${base}/m`);
      let size;
      let type;
      let body;
      if (mres) {
        const man = await mres.json();
        size = man.size;
        type = man.type || "video/mp4";
        body = (start, end) => chunkStream(cache, base, man, start, end);
      } else {
        const hit = await cache.match(base);
        if (!hit) return new Response("not on this device", { status: 404 });
        type = hit.headers.get("Content-Type") || "video/mp4";
        // Blobs from Cache Storage are disk-backed: slicing doesn't read the whole file.
        const blob = await hit.blob();
        size = blob.size;
        body = (start, end) => blob.slice(start, end + 1);
      }
      const head = { "Content-Type": type, "Accept-Ranges": "bytes" };
      const r = range ? rangeOf(range, size) : null;
      if (r === false) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      if (!r) return new Response(body(0, size - 1), { status: 200, headers: { ...head, "Content-Length": String(size) } });
      const [start, end] = r;
      return new Response(body(start, end), {
        status: 206,
        headers: { ...head, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}` },
      });
    })(),
  );
});
