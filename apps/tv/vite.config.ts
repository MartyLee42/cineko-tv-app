import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("./src/main.tsx", import.meta.url));
const BOOT = fileURLToPath(new URL("./src/boot.tsx", import.meta.url));

type Ctx = { getModuleInfo(id: string): { importedIds: readonly string[] } | null };

/** Every module `from` loads statically (dynamic imports not followed). */
function staticReach(ctx: Ctx, from: string): Set<string> {
  const seen = new Set<string>();
  const todo = [from];
  while (todo.length) {
    const id = todo.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of ctx.getModuleInfo(id)?.importedIds ?? []) todo.push(d);
  }
  return seen;
}

/**
 * Chunks (src/lazy.tsx splits the screens): main.tsx → boot.tsx is itself a
 * dynamic import (the tablet redirect runs first), so by default every module
 * boot shares with a lazy screen became its own small chunk (~25 requests on
 * a high-latency link). Instead: what boot needs statically goes into two
 * chunks fetched in parallel with it — `vendor` (React, react-query, focus
 * engine: changes rarely, stays cached across releases) and `core` (the app)
 * — and what only lazy chunks share goes into one `shared` chunk (optional
 * features excepted: see `season`).
 */
function chunkGroups() {
  let cache: { boot: Set<string>; main: Set<string> } | null = null;
  const reach = (ctx: Ctx) => (cache ??= { boot: staticReach(ctx, BOOT), main: staticReach(ctx, MAIN) });
  return [
    {
      name: (id: string, ctx: Ctx) => {
        const r = reach(ctx);
        if (id === BOOT || !r.boot.has(id) || r.main.has(id)) return null;
        // Libraries and the transpiler's helpers ("\0@oxc-project+runtime…") go to
        // vendor, so core imports vendor and never the reverse (no chunk cycle).
        return /[\\/]node_modules[\\/]/.test(id) || id.startsWith("\0") ? "vendor" : "core";
      },
      priority: 2,
      includeDependenciesRecursively: false,
    },
    {
      // Optional features stay apart from `shared` even when two chunks use
      // them (the holiday layer: Home's layer and Settings' preview), so TVs
      // that never show them never fetch them.
      name: (id: string) => (/[\\/]packages[\\/]ui[\\/]src[\\/](SeasonLayer|seasonSprites)\.tsx$/.test(id) ? "season" : null),
      priority: 3,
      includeDependenciesRecursively: false,
    },
    {
      name: (id: string, ctx: Ctx) => (reach(ctx).main.has(id) ? null : "shared"),
      minShareCount: 2,
      priority: 1,
      includeDependenciesRecursively: false,
    },
  ];
}

const hmrPort = process.env.HMR_CLIENT_PORT ? Number(process.env.HMR_CLIENT_PORT) : undefined;

// The TV app is served under /tv/ on the same origin as the API and the PWA.
// plugin-legacy adds an ES5 + polyfill bundle for older TV browser engines
// (Tizen/webOS/Android TV WebViews) that cannot run modern modules.
export default defineConfig({
  base: "/tv/",
  plugins: [
    react(),
    legacy({
      targets: ["chrome >= 53", "safari >= 11"],
      modernPolyfills: true,
    }),
  ],
  server: {
    host: true,
    port: 5174,
    strictPort: true,
    hmr: hmrPort ? { clientPort: hmrPort } : undefined,
    allowedHosts: true,
  },
  build: {
    target: "es2017",
    sourcemap: true,
    rolldownOptions: { output: { codeSplitting: { groups: chunkGroups() } } },
  },
  define: { __MARTYTV_RELEASE__: JSON.stringify(process.env.MARTYTV_VERSION || "dev") }, // build id for client error reports
});
