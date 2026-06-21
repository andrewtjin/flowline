/// <reference types="vite/client" />
import { defineConfig } from "vite";

// Renderer-ROOT vite config (root = src/renderer). It is auto-loaded ONLY by the standalone dev preview
// (`npm run dev` → `vite src/renderer`, which treats src/renderer as the project root and reads this file).
//
// ── SAFETY: this file is INVISIBLE to the Electron build ──────────────────────────────────────────────
// electron-vite (electron.vite.config.ts) resolves its targets by loading ONLY `electron.vite.config.*` and
// then forces `configFile: false` on every sub-build (verified in electron-vite 5.0.0,
// resolveConfig() → `config.configFile = false`). So `electron-vite dev/build/preview` NEVER reads this
// file — the renderer's electron config is exactly `electron.vite.config.ts`'s `renderer` block. The root
// `vite.config.ts` stays Vitest-only (its `test` block); Vitest reads that, not this file.
export default defineConfig({});
