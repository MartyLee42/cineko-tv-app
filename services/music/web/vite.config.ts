import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served by services/music at /music/. `npm run dev` proxies the API to a
// locally running service (MUSIC_API, default 127.0.0.1:18090) and the
// Cineko login API to MARTYTV_API (default the dev stack on :8080).
export default defineConfig({
  base: "/music/",
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 800 },
  server: {
    port: 5180,
    proxy: {
      "/music/api": process.env.MUSIC_API ?? "http://127.0.0.1:18090",
      "/api": process.env.MARTYTV_API ?? "http://127.0.0.1:8080",
    },
  },
});
