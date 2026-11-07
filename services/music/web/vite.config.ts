import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Built twice (npm run build): base /music/ (dist/, served by services/music
// at /music/ on the Cineko host) and base / (dist-root/, Cineko Music on its
// own host, MUSIC_DOMAIN). The API stays at /music/api on both.
// `npm run dev` proxies the API to a locally running service (MUSIC_API,
// default 127.0.0.1:18090) and the Cineko login API to MARTYTV_API (default
// the dev stack on :8080).

/** The web app manifest for one base: its own id, start_url and scope, so the
 *  app on Music's own host installs as a separate PWA next to Cineko. */
export function manifest(base: string): string {
  return JSON.stringify(
    {
      id: base,
      name: "Cineko Music",
      short_name: "Music",
      description: "Домашняя музыка: поиск, плейлисты, лосслесс из торрентов",
      lang: "ru",
      start_url: base,
      scope: base,
      display: "standalone",
      background_color: "#0b0c0f",
      theme_color: "#0b0c0f",
      icons: [
        { src: `${base}icon.svg`, sizes: "any", type: "image/svg+xml" },
        { src: `${base}icon-192.png`, sizes: "192x192", type: "image/png" },
        { src: `${base}icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any maskable" },
      ],
    },
    null,
    2,
  );
}

function webManifest(): Plugin {
  let base = "/";
  return {
    name: "music-manifest",
    configResolved(c) {
      base = c.base;
    },
    configureServer(server) {
      server.middlewares.use(`${base}manifest.webmanifest`, (_req, res) => {
        res.setHeader("Content-Type", "application/manifest+json");
        res.end(manifest(base));
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "manifest.webmanifest", source: manifest(base) });
    },
  };
}

export default defineConfig({
  base: "/music/",
  plugins: [react(), webManifest()],
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 800 },
  server: {
    port: 5180,
    proxy: {
      "/music/api": process.env.MUSIC_API ?? "http://127.0.0.1:18090",
      "/api": process.env.MARTYTV_API ?? "http://127.0.0.1:8080",
    },
  },
});
