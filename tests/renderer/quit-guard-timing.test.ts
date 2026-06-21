// quit-guard-timing.test.ts — pins the R6 boot-order invariant for the EditorHost refactor.
//
// The SEQUENTIAL quit guard (`window.flowline.onQuitGuard`, post-refactor `shell.onQuitGuard`) MUST be registered
// SYNCHRONOUSLY in the boot's sync zone — BEFORE the boot IIFE awaits the initial-doc PULL (`getInitialDoc`). If a
// refactor slips the registration after that await, a Quit fired during this window's boot round-trip hits a
// not-yet-subscribed renderer; `ipcRenderer.on` has no buffering, so the guard is dropped and MAIN's reply-await
// hangs the whole app (no window ever answers). main.ts boots on import (constructs the view, touches `window`,
// imports styles) so it is NOT runtime-importable under vitest — following the repo's structural-gate idiom
// (check-css / check-host-imports), we assert the invariant on SOURCE ORDER, which is precisely what it is: the
// registration is synchronous top-level boot code; the getInitialDoc pull is the boot IIFE's first await.
//
// Survives the refactor: `shell.onQuitGuard(` still matches `.onQuitGuard(`, and `host.getInitialDoc()` still
// matches `getInitialDoc(`. If S4 moves the registration past the initial-doc await, this test goes red.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "renderer", "main.ts");

/** Strip block + line comments (newlines preserved) so a comment naming an anchor cannot move the match. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

describe("quit-guard boot-order invariant (R6)", () => {
  const code = stripComments(readFileSync(MAIN, "utf8"));

  it("registers the quit guard before the boot awaits getInitialDoc", () => {
    const guardIdx = code.search(/\.onQuitGuard\s*\(/);
    const initialDocIdx = code.search(/getInitialDoc\s*\(/);

    expect(guardIdx, "quit-guard registration `.onQuitGuard(...)` not found in main.ts").toBeGreaterThan(-1);
    expect(initialDocIdx, "boot `getInitialDoc(...)` pull not found in main.ts").toBeGreaterThan(-1);
    // Synchronous registration must precede the boot IIFE's first async step (the initial-doc PULL).
    expect(guardIdx).toBeLessThan(initialDocIdx);
  });
});
