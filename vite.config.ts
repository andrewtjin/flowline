/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// Vitest-ONLY config (the `test` block). The app build is owned by electron.vite.config.ts; the
// renderer dev/preview server is `vite src/renderer` (its index.html lives at src/renderer/index.html).
// Vitest reads this file (not electron.vite.config.ts), so the test runner never has to understand the
// three-target Electron build.
export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
  },
});
