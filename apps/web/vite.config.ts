import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// In Docker dev, Caddy (port 8080) fronts Vite, so HMR must use Caddy's port.
const hmrPort = process.env.HMR_CLIENT_PORT ? Number(process.env.HMR_CLIENT_PORT) : undefined;

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.png", "apple-touch-icon.png"],
      manifest: {
        id: "/",
        name: "Cineko",
        short_name: "Cineko",
        description: "Домашний кинотеатр: фильмы, сериалы, ТВ и видео — на телефоне и телевизоре",
        lang: "ru",
        categories: ["entertainment", "video"],
        theme_color: "#08090c",
        background_color: "#08090c",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      workbox: {
        // Precache the app shell. At runtime, cache catalog metadata and TMDB
        // images only; auth/devices/profiles/pairing/realtime and (later) video
        // streams are never cached. Both caches are deleted on sign-out
        // (src/catalog/cache.ts). Video (/api/v1/stream/…, used by the
        // in-browser player with Range requests) must never match a route
        // below: unmatched requests bypass the service worker entirely.
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        // hls.js loads on demand (anime/online streams only); keep it out of the precache.
        globIgnores: ["**/hls-*.js", "**/hls.light-*.js"],
        navigateFallback: "/index.html",
        // Videos saved for offline play (/offline-video/<id>, Range support): src/offline/device.ts.
        importScripts: ["/offline-video-sw.js"],
        // /music: Cineko Music, a separate app (services/music) on the same origin.
        navigateFallbackDenylist: [/^\/docs\//, /^\/api\//, /^\/tv\//, /^\/demo_tv/, /^\/msx\//, /^\/music(\/|$)/, /^\/healthz/, /^\/readyz/],
        runtimeCaching: [
          {
            // Per-profile responses (watch state in `me`, progress) must be
            // fresh: network first, the cache only as an offline fallback.
            urlPattern: ({ url, sameOrigin }) =>
              sameOrigin &&
              /^\/api\/v1\/(catalog|media)\//.test(url.pathname) &&
              (url.searchParams.has("profile_id") || url.pathname.endsWith("/progress")),
            method: "GET",
            handler: "NetworkFirst",
            options: {
              cacheName: "martytv-meta",
              networkTimeoutSeconds: 6,
              expiration: { maxEntries: 200, maxAgeSeconds: 24 * 60 * 60 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: ({ url, sameOrigin }) => sameOrigin && /^\/api\/v1\/(catalog|media)\//.test(url.pathname),
            method: "GET",
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "martytv-meta",
              expiration: { maxEntries: 200, maxAgeSeconds: 24 * 60 * 60 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: ({ url, sameOrigin }) =>
              url.hostname === "image.tmdb.org" || (sameOrigin && url.pathname.startsWith("/api/v1/images/")),
            method: "GET",
            handler: "CacheFirst",
            options: {
              cacheName: "martytv-images",
              expiration: { maxEntries: 500, maxAgeSeconds: 30 * 24 * 60 * 60, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    hmr: hmrPort ? { clientPort: hmrPort } : undefined,
    allowedHosts: true,
  },
  build: { target: "es2020", sourcemap: true },
  define: { __MARTYTV_RELEASE__: JSON.stringify(process.env.MARTYTV_VERSION || "dev") }, // build id for client error reports
});
