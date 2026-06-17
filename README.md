# Flowline

A fast, lightweight **debate-text editor** built on [ProseMirror](https://prosemirror.net/).
Write, cut, highlight, mute, reorder, save, and `.docx`-export a speech — quickly.

Flowline is **clean-room and standalone**: its own schema, CSS (`fl-` prefix), and native file
envelope (`FLOW\x01`).

## Stack
- TypeScript · ProseMirror (npm packages) · Vite + Vitest · Electron desktop shell.

## Develop
```bash
npm install
npm run dev          # Vite dev server — editor preview at http://localhost:5173
npm test             # Vitest unit/integration tests
npm run check        # full gate: typecheck + lint + schema-hash + tests
```

## Document model
- **Blocks** (all isolating, each with a stable `blockId`): `card` (`tag`/`cite`/`body`),
  `analytic`, `heading` (`level ∈ pocket|hat|block`), `paragraph`.
- **Inline:** `text`, `hard_break`.
- **Marks** (render order highlight → emphasis → muted): `highlight` (`color`),
  `emphasis` (bold + underline + box), `muted` (small font).
