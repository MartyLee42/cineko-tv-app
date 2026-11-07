import { defineConfig } from "vitest/config";

// Tests use translate() directly: load both languages' strings first.
// theme-base.css and themes/*.css are read as text (`?raw`) by themeContrast.test.ts: vitest blanks CSS it doesn't include.
export default defineConfig({ test: { setupFiles: ["./src/testSetup.ts"], css: { include: [/theme(-base)?\.css/, /themes\/[\w-]+\.css/] } } });
