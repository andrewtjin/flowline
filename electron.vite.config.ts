// electron.vite.config.ts — the Electron build (main + preload + renderer), used by
// `electron-vite dev`, `electron-vite build`, `electron-vite preview`.
//
// Vitest does NOT read this file — it reads vite.config.ts (the `test` block). Keeping the two configs
// separate means the test runner never has to understand the Electron three-target build, and the app
// build never has to carry test config.
//
// Entry points are electron-vite's defaults — `src/main/index.ts`, `src/preload/index.ts`, and the
// renderer's `index.html` under its root — so no explicit inputs are needed (electron-vite v5 removed
// the old `build.rollupOptions.input` shape). The shared editor core (schema, editor, commands, …)
// stays at src/ and is imported with `../` from the renderer entry. `externalizeDepsPlugin` keeps node
// deps out of the main/preload bundles (they `require` at runtime); the renderer bundles prosemirror
// for the browser.

import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { root: "src/renderer" },
});
