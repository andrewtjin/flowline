// check-renderer-seam.ts — CI gate: the EditorHost platform seam stays collapsed (EditorHost refactor §S6, durable).
//
// Walks every `.ts`/`.tsx` under `src/renderer/` EXCEPT `src/renderer/host/` (the seam's inside — DesktopHost
// forwards to `window.flowline`, resolveHost reads it) and fails the build on any leak found by `findSeamViolations`:
// a reintroduced `isWeb` predicate, or a capability access THROUGH `window.flowline` (`.x` / `?.x` / `!.x` / `["x"]`).
// The lone composition-root read `const bridge = window.flowline` is a bare value handoff (no member access) and
// passes. This pins the refactor's core invariant: the platform decision is made once, at the composition root.
// See `_renderer-seam.ts` for the rules + the deliberate heuristic bound (it cannot follow an alias).

import { readFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { walkSourceFiles } from "./_scan-utils";
import { findSeamViolations } from "./_renderer-seam";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RENDERER = join(ROOT, "src", "renderer");
const HOST = join(RENDERER, "host");

const problems: string[] = [];
for (const file of walkSourceFiles(RENDERER, { exts: new Set([".ts", ".tsx"]) })) {
  // Exempt ONLY the exact src/renderer/host/ subtree (not any coincidental dir merely named "host"): that subtree
  // IS the platform layer whose whole job is to own the window.flowline calls.
  if (file === HOST || file.startsWith(HOST + sep)) continue;
  const rel = relative(ROOT, file);
  for (const v of findSeamViolations(readFileSync(file, "utf8"))) {
    problems.push(`${rel}:${v.line}: ${v.message}`);
  }
}

if (problems.length) {
  console.error("✗ renderer-seam gate FAILED — the platform seam leaked outside src/renderer/host/:");
  problems.forEach((p) => console.error("  " + p));
  process.exit(1);
}
console.log("✓ renderer-seam gate: no `isWeb` and no `window.flowline` capability access outside src/renderer/host/");
