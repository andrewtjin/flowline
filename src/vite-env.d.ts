/// <reference types="vite/client" />
// Vite ambient types: gives `import.meta.env` (DEV/PROD/MODE/…) a type. The renderer uses
// `import.meta.env.DEV` to gate a DEV-only e2e affordance that Vite statically replaces (and
// tree-shakes) in the production build. Type-only file — no runtime output.

// Type the preload bridge on `window`. Optional because the bare browser dev preview
// (`npm run dev`, no Electron preload) has no `window.flowline` — the renderer guards on it.
import type { FlowlineBridge } from "./persistence/bridge";
declare global {
  interface Window {
    flowline?: FlowlineBridge;
  }
}
