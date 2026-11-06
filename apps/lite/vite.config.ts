/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Two builds from one source tree:
//   --mode web → dist/        (PC + phones, PWA)        base: $LITE_BASE
//   --mode tv  → dist/tv/     (Media Station X / TVs)   base: $LITE_BASE + "tv/"
// LITE_BASE is the GitHub Pages path, e.g. "/cineko-tv-app/" (CI derives it
// from the repository name so forks work).
const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  const tv = mode === "tv";
  let base = process.env.LITE_BASE || "/cineko-tv-app/";
  if (!base.endsWith("/")) base += "/";
  if (!base.startsWith("/")) base = "/" + base;
  return {
    root: resolve(here, tv ? "tv" : "web"),
    base: tv ? base + "tv/" : base,
    plugins: [
      react(),
      // Old TV engines (Tizen 3–4, webOS 3–4, Android 5–7 WebViews in MSX).
      ...(tv ? [legacy({ targets: ["chrome >= 47", "safari >= 10"], modernPolyfills: true })] : []),
    ],
    server: { fs: { allow: [here] }, host: "127.0.0.1" },
    build: {
      outDir: resolve(here, tv ? "dist/tv" : "dist"),
      emptyOutDir: !tv,
      target: tv ? "es2017" : "es2020",
      sourcemap: false,
      chunkSizeWarningLimit: 900,
    },
    test: {
      root: here,
      include: ["src/**/*.test.ts"],
      environment: "node",
    },
  };
});
