import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// The app's Vite config plus a setup that loads both languages' strings
// (in the app they are loaded on demand before the first render).
export default mergeConfig(viteConfig, defineConfig({ test: { setupFiles: ["./src/testSetup.ts"] } }));
