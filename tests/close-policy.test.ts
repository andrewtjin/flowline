// close-policy.test.ts — proof for the PURE close/quit policy.
//
// This is the highest-blast-radius logic in the multi-window shell (wrong-window close = the user loses the WRONG
// doc), so every branch of decideClose + shouldPrevent is asserted here against the close-policy truth table. The
// Electron wiring (main/index.ts) that translates these decisions into BrowserWindow calls is verified visually.

import { describe, it, expect } from "vitest";
import { decideClose, shouldPrevent } from "../src/main/close-policy";

describe("decideClose — the per-window close / quit decision (truth table)", () => {
  it("a NORMAL requestClose closes the SENDER window (never mainWindow, never quit)", () => {
    // Not quitting, sender not yet cleared → close the sender window, and only that window.
    const allowClose = new Set<number>();
    expect(decideClose(7, allowClose, false)).toEqual({ action: "close", winId: 7 });
  });

  it("closes the SENDER window even when OTHER windows are already cleared (no cross-window leakage)", () => {
    // Window 3 is cleared, but the requestClose came from window 7 → still closes 7, not 3.
    const allowClose = new Set<number>([3]);
    expect(decideClose(7, allowClose, false)).toEqual({ action: "close", winId: 7 });
  });

  it("when isQuitting, a requestClose yields { action: 'quit' } — it NEVER closes a lone window itself", () => {
    // During a quit cascade the sequential orchestration owns the flow; a requestClose defers to it.
    const allowClose = new Set<number>();
    expect(decideClose(7, allowClose, true)).toEqual({ action: "quit" });
  });

  it("isQuitting takes precedence even if the sender is already in allowClose", () => {
    // Quit intent is checked FIRST, so an already-cleared sender during a quit still routes to the quit branch.
    const allowClose = new Set<number>([7]);
    expect(decideClose(7, allowClose, true)).toEqual({ action: "quit" });
  });

  it("an ALREADY-allowed sender (not quitting) is a noop — the decision is idempotent", () => {
    // The window was already cleared (its close handler will let it through); re-deciding is redundant.
    const allowClose = new Set<number>([7]);
    expect(decideClose(7, allowClose, false)).toEqual({ action: "noop" });
  });

  it("does not mutate the allowClose Set it is given (pure)", () => {
    const allowClose = new Set<number>([3]);
    decideClose(7, allowClose, false);
    expect([...allowClose]).toEqual([3]);
  });
});

describe("shouldPrevent — should the close handler intercept this window's close?", () => {
  it("INTERCEPTS (true) a window not yet cleared — the renderer must run its unsaved-guard first", () => {
    expect(shouldPrevent(7, new Set<number>())).toBe(true);
  });

  it("LETS THROUGH (false) a window already cleared via requestClose", () => {
    expect(shouldPrevent(7, new Set<number>([7]))).toBe(false);
  });

  it("is per-window: another window being cleared does NOT clear this one", () => {
    // Window 3 is cleared, but window 7's close must still be intercepted.
    expect(shouldPrevent(7, new Set<number>([3]))).toBe(true);
  });
});
