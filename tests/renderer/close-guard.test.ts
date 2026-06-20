// close-guard.test.ts — the PURE web close-guard decision (close-guard.ts) + the Save accelerator predicate
// (web-keys.ts). E10b-S1 / S5 / S6.
//
// The close-guard is the highest-blast-radius web logic ("did we just drop the user's unsaved work?"), so every
// branch of the truth table is asserted here, mirroring the desktop close-policy.test.ts. The Save-chord predicate
// (S1's "Ctrl/Cmd+S is intercepted") is tested as a pure function so the inline DOM handler in main.ts stays thin.

import { describe, it, expect } from "vitest";
import { needsClosePrompt, resolveClose } from "../../src/renderer/close-guard";
import { isSaveChord, isSaveAsChord, isNewChord } from "../../src/renderer/web-keys";
import type { KeyChord } from "../../src/renderer/web-keys";

describe("needsClosePrompt — clean closes silently (S5)", () => {
  it("a CLEAN doc needs NO prompt (closes immediately)", () => {
    expect(needsClosePrompt(false)).toBe(false);
  });
  it("a DIRTY doc needs the prompt", () => {
    expect(needsClosePrompt(true)).toBe(true);
  });
});

describe("resolveClose — the 3-way unsaved-changes decision (S5/S6 truth table)", () => {
  it("no prompt shown (undefined choice = clean doc) → close", () => {
    expect(resolveClose(undefined, false)).toBe("close");
    expect(resolveClose(undefined, true)).toBe("close");
  });
  it("cancel → abort (keep the doc open) regardless of save state", () => {
    expect(resolveClose("cancel", false)).toBe("abort");
    expect(resolveClose("cancel", true)).toBe("abort");
  });
  it("discard → close (drop the edits) regardless of save state", () => {
    expect(resolveClose("discard", false)).toBe("close");
    expect(resolveClose("discard", true)).toBe("close");
  });
  it("save + the save SUCCEEDED → close", () => {
    expect(resolveClose("save", true)).toBe("close");
  });
  it("save but the save FAILED / was cancelled (still dirty) → abort (never silently lose work)", () => {
    expect(resolveClose("save", false)).toBe("abort");
  });
});

describe("isSaveChord / isSaveAsChord — the Save accelerator predicate (S1)", () => {
  const chord = (over: Partial<KeyChord>): KeyChord => ({ key: "s", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over });

  it("Ctrl+S is a Save chord", () => {
    expect(isSaveChord(chord({ ctrlKey: true }))).toBe(true);
  });
  it("Cmd+S (metaKey, macOS) is a Save chord", () => {
    expect(isSaveChord(chord({ metaKey: true }))).toBe(true);
  });
  it("uppercase S (Shift may uppercase key) still matches", () => {
    expect(isSaveChord(chord({ ctrlKey: true, key: "S", shiftKey: true }))).toBe(true);
  });
  it("plain S (no modifier) is NOT a Save chord — we must not hijack typing", () => {
    expect(isSaveChord(chord({}))).toBe(false);
  });
  it("Alt+Ctrl+S is NOT a Save chord (a different reserved chord)", () => {
    expect(isSaveChord(chord({ ctrlKey: true, altKey: true }))).toBe(false);
  });
  it("Ctrl+other-key is NOT a Save chord", () => {
    expect(isSaveChord(chord({ ctrlKey: true, key: "a" }))).toBe(false);
  });
  it("Save-AS adds Shift; Save (no Shift) is not Save-As", () => {
    expect(isSaveAsChord(chord({ ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isSaveAsChord(chord({ ctrlKey: true }))).toBe(false);
  });
});

describe("isNewChord — the web New accelerator (Ctrl+M, ctrl-only; NOT reserved Ctrl+N nor AT-grabbed Ctrl+Alt+N)", () => {
  const chord = (over: Partial<KeyChord>): KeyChord => ({ key: "m", code: "KeyM", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over });

  it("Ctrl+M is a New chord", () => {
    expect(isNewChord(chord({ ctrlKey: true }))).toBe(true);
  });
  it("matches by physical code KeyM even when the produced key is remapped", () => {
    expect(isNewChord(chord({ ctrlKey: true, key: "µ", code: "KeyM" }))).toBe(true);
  });
  it("Cmd+M (metaKey) is NOT a New chord — ⌘M is macOS 'minimize window', so we never claim meta+M", () => {
    expect(isNewChord(chord({ metaKey: true }))).toBe(false);
  });
  it("Ctrl+Shift+M is NOT a New chord (collides with Firefox Responsive Design Mode)", () => {
    expect(isNewChord(chord({ ctrlKey: true, shiftKey: true }))).toBe(false);
  });
  it("Ctrl+Alt+M is NOT a New chord (Windows AltGr / AT-grabbed — the very failure we are avoiding)", () => {
    expect(isNewChord(chord({ ctrlKey: true, altKey: true }))).toBe(false);
  });
  it("plain Ctrl+N is NOT a New chord — browser-reserved (new window), uncancelable, never claimed", () => {
    expect(isNewChord(chord({ ctrlKey: true, key: "n", code: "KeyN" }))).toBe(false);
  });
  it("plain M (no modifier) is NOT a New chord — we must not hijack typing", () => {
    expect(isNewChord(chord({}))).toBe(false);
  });
});
