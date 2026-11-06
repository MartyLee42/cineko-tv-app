import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/schema.d.ts", "services/**", "**/dev-dist/**", ".cache/**", "**/playwright-report/**", "**/test-results/**", ".claude/**", "apps/lite/**", "docs/guide/**", "docs/research/**", "e2e/scripts/guide-shots.mjs", "e2e/scripts/install-guide.mjs", "e2e/fixtures/**/*.ts", "e2e/scripts/out/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Playwright scripts: code inside page.evaluate() runs in the browser.
    files: ["e2e/scripts/**/*.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["**/public/**/*sw.js"],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { ...globals.node } },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
