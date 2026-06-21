// runtime-fkeys.test.ts — E6/E11: proves the structural F-key wiring, especially F8→toggleCite (schema v5
// made cite an inline MARK; the binding keeps the Cite toolbar button's "F8" hint truthful). Asserts the
// shared binding MAP that BOTH the single-mode and unit-mode plugin lists consume, so the proof is
// mode-agnostic and needs no mounted view.

import { describe, it, expect } from "vitest";
import { structuralKeyBindings } from "../src/renderer/runtime";
import { toggleCite } from "../src/commands";

describe("structural F-key bindings (E6/E11)", () => {
  it("binds F8 to toggleCite so the Cite hint is truthful (cite is a mark now)", () => {
    expect(structuralKeyBindings.F8).toBe(toggleCite);
  });

  it("keeps the heading + tag + analytic structural keys present", () => {
    // F4/F5/F6 (headings) and F7 (tag) and Mod-F7 (analytic) are factory-built commands (a fresh instance per
    // call), so assert by existence/type; F8 is the only direct-command reference, asserted by reference equality above.
    for (const k of ["F4", "F5", "F6", "F7", "Mod-F7"]) {
      expect(typeof structuralKeyBindings[k]).toBe("function");
    }
  });
});
