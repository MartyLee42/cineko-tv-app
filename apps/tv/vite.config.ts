import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const MAIN = fileURLToPath(new URL("./src/main.tsx", import.meta.url));
const BOOT = fileURLToPath(new URL("./src/boot.tsx", import.meta.url));

type Info = { importedIds: readonly string[]; code?: string | null; exports?: readonly string[] };
type Ctx = { getModuleInfo(id: string): Info | null };

/** A workspace package's barrel (packages/<name>/src/index.ts, imported as "@martytv/<name>"). */
const BARREL = /[\\/]packages[\\/]([a-z-]+)[\\/]src[\\/]index\.ts$/;

/** The names `code` imports from "@martytv/<pkg>" (types left out), or "all" (a namespace import). */
function namesFrom(code: string, pkg: string): Set<string> | "all" {
  const names = new Set<string>();
  const re = new RegExp(`(?:import|export)\\s+(type\\s+)?([^;]*?)\\s*from\\s*["']@martytv/${pkg}["']`, "g");
  for (const m of code.matchAll(re)) {
    if (m[1]) continue;
    if (/\*/.test(m[2]!)) return "all";
    for (const part of /\{([^}]*)\}/.exec(m[2]!)?.[1]?.split(",") ?? []) {
      const p = part.trim();
      if (p && !p.startsWith("type ")) names.add(p.split(/\s+as\s+/)[0]!.trim());
    }
  }
  return names;
}

const STAR = /export\s*\*\s*from\s*["']([^"']+)["']/g;

/** The resolved id of a relative specifier among a module's imports. */
function importedPath(ids: readonly string[], from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec);
  return ids.find((m) => m === base || m.startsWith(base + "."));
}

/** Does `id` export `name`, itself or through its own `export * from` (designs.ts via components.tsx)? */
function provides(ctx: Ctx, id: string, name: string, depth = 0): boolean {
  const info = ctx.getModuleInfo(id);
  if (info?.exports?.includes(name)) return true;
  const code = info?.code;
  if (depth > 3 || !code) return false;
  const ids = [...(info?.importedIds ?? [])];
  return [...code.matchAll(STAR)].some((m) => {
    const sub = importedPath(ids, id, m[1]!);
    return !!sub && provides(ctx, sub, name, depth + 1);
  });
}

/** Which of a barrel's modules provide `names` (all of them when unsure). */
function barrelModules(ctx: Ctx, barrel: string, names: Set<string> | "all"): readonly string[] {
  const info = ctx.getModuleInfo(barrel);
  const mods = [...(info?.importedIds ?? [])];
  const code = info?.code;
  if (names === "all" || !code) return mods;
  // export { a, b as c } from "./x": exact names; export * from "./x": what the module provides.
  const named = new Map<string, string>();
  for (const m of code.matchAll(/export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const mod = importedPath(mods, barrel, m[2]!);
    for (const part of m[1]!.split(",")) {
      const p = part.trim().replace(/^type\s+/, "");
      if (p && mod) named.set((p.split(/\s+as\s+/)[1] ?? p.split(/\s+as\s+/)[0]!).trim(), mod);
    }
  }
  const stars = [...code.matchAll(STAR)].map((m) => importedPath(mods, barrel, m[1]!));
  const out = new Set<string>();
  for (const n of names) {
    // Defined in the barrel itself (media-types' helpers): nothing more to follow.
    if (new RegExp(`export\\s+(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+${n}\\b`).test(code)) continue;
    const mod = named.get(n) ?? stars.find((s) => !!s && provides(ctx, s, n));
    if (!mod) return mods;
    out.add(mod);
  }
  return [...out];
}

/**
 * Every module `from` loads statically (dynamic imports not followed). Through
 * a package barrel only the modules whose exports are actually imported: the
 * barrels re-export everything, and following all of it would put every
 * shared helper (the loader picker, the film-theme classifier…) into `core`.
 */
function staticReach(ctx: Ctx, from: string): Set<string> {
  const seen = new Set<string>();
  const todo = [from];
  while (todo.length) {
    const id = todo.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const info = ctx.getModuleInfo(id);
    const ids = [...(info?.importedIds ?? [])];
    const code = info?.code;
    for (const d of ids) {
      const pkg = BARREL.exec(d)?.[1];
      if (!pkg || !code) todo.push(d);
      else {
        // The barrel itself (its own helpers), not everything it re-exports.
        seen.add(d);
        todo.push(...barrelModules(ctx, d, namesFrom(code, pkg)));
      }
    }
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
      // Each design is its own chunk (design/looks/<id>.tsx + its CSS), even
      // the ones a second place uses (the «Матрица» loader draws the rain).
      name: (id: string) => /[\\/]design[\\/]looks[\\/]([a-z0-9]+)\.(tsx|css)$/.exec(id)?.[1] ?? null,
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
