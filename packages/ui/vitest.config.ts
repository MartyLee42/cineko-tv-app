import { defineConfig } from "vitest/config";

// Tests use translate() directly: load both languages' strings first.
export default defineConfig({ test: { setupFiles: ["./src/testSetup.ts"] } });
