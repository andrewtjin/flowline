// commands.test.ts — unit tests for the mark commands (cheap, jsdom, no browser).
// Proves the command LOGIC and the no-caret-jump invariant at the state level;
// the real-browser proof (DOM selection survives re-render) is the Playwright e2e/marks.spec.ts.

import { describe, it, expect } from "vitest";
import { EditorState, TextSelection, Selection } from "prosemirror-state";
import type { Command } from "prosemirror-state";
import { schema } from "../src/schema";
import {
  toggleHighlight,
  toggleEmphasis,
  toggleMuted,
  toggleUnderline,
  toggleStrong,
  clearMarks,
  clearFormatting,
  caretToDocEnd,
} from "../src/commands";

const hl = schema.marks.highlight;
const em = schema.marks.emphasis;
const mu = schema.marks.muted;
const ul = schema.marks.underline;
const st = schema.marks.strong;

// A single-paragraph doc. Text content begins at pos 1; the paragraph closes at content.size - 1.
function paraState(text = "hello world"): EditorState {
  const doc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create({ blockId: "p1" }, schema.text(text))]);
  return EditorState.create({ schema, doc });
}
function selectAll(state: EditorState): EditorState {
  const to = state.doc.content.size - 1;
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, to)));
}
function cursorAt(state: EditorState, pos: number): EditorState {
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}
// Run a command with a capturing dispatch; return whether it ran and the resulting state.
function run(state: EditorState, cmd: Command): { ok: boolean; state: EditorState } {
  let next = state;
  const ok = cmd(state, (tr) => {
    next = state.apply(tr);
  });
  return { ok: !!ok, state: next };
}
// The set of highlight colours present on text in the doc.
function highlightColors(state: EditorState): Set<string> {
  const set = new Set<string>();
  state.doc.descendants((n) => {
    if (n.isText) for (const m of n.marks) if (m.type === hl) set.add(m.attrs.color as string);
  });
  return set;
}

describe("toggleHighlight", () => {
  it("adds the chosen colour across a selection and PRESERVES the selection", () => {
    const s0 = selectAll(paraState());
    const { ok, state: s1 } = run(s0, toggleHighlight("blue"));
    expect(ok).toBe(true);
    expect(highlightColors(s1)).toEqual(new Set(["blue"]));
    expect(s1.selection.from).toBe(s0.selection.from);
    expect(s1.selection.to).toBe(s0.selection.to);
  });

  it("toggles OFF when the whole selection already has that colour", () => {
    const s1 = run(selectAll(paraState()), toggleHighlight("blue")).state;
    const s2 = run(s1, toggleHighlight("blue")).state;
    expect(highlightColors(s2)).toEqual(new Set());
  });

  it("SWITCHES colour rather than stacking (blue -> green)", () => {
    const s1 = run(selectAll(paraState()), toggleHighlight("blue")).state;
    const s2 = run(s1, toggleHighlight("green")).state;
    expect(highlightColors(s2)).toEqual(new Set(["green"]));
  });

  it("at a bare cursor, sets a stored mark so the next typed run is highlighted", () => {
    const sc = cursorAt(paraState(), 1);
    const { ok, state } = run(sc, toggleHighlight("yellow"));
    expect(ok).toBe(true);
    expect(state.storedMarks?.some((m) => m.type === hl && m.attrs.color === "yellow")).toBe(true);
  });
});

describe("toggleEmphasis / toggleMuted", () => {
  it("emphasis applies across the selection and preserves it", () => {
    const s0 = selectAll(paraState());
    const { state: s1 } = run(s0, toggleEmphasis);
    expect(s1.doc.rangeHasMark(s1.selection.from, s1.selection.to, em)).toBe(true);
    expect(s1.selection.from).toBe(s0.selection.from);
    expect(s1.selection.to).toBe(s0.selection.to);
  });

  it("applying muted over emphasis EVICTS emphasis (symmetric excludes)", () => {
    const s1 = run(selectAll(paraState()), toggleEmphasis).state;
    const s2 = run(s1, toggleMuted).state;
    expect(s2.doc.rangeHasMark(s2.selection.from, s2.selection.to, mu)).toBe(true);
    expect(s2.doc.rangeHasMark(s2.selection.from, s2.selection.to, em)).toBe(false);
  });
});

describe("toggleUnderline (schema v2)", () => {
  it("applies underline across the selection, preserving it", () => {
    const s0 = selectAll(paraState());
    const { ok, state: s1 } = run(s0, toggleUnderline);
    expect(ok).toBe(true);
    expect(s1.doc.rangeHasMark(s1.selection.from, s1.selection.to, ul)).toBe(true);
    expect(s1.selection.from).toBe(s0.selection.from);
    expect(s1.selection.to).toBe(s0.selection.to);
  });
  it("LAYERS with highlight — neither evicts the other (no excludes)", () => {
    const s1 = run(selectAll(paraState()), toggleHighlight("yellow")).state;
    const s2 = run(s1, toggleUnderline).state;
    expect(s2.doc.rangeHasMark(s2.selection.from, s2.selection.to, ul)).toBe(true);
    expect(s2.doc.rangeHasMark(s2.selection.from, s2.selection.to, hl)).toBe(true);
  });
});

describe("toggleStrong (schema v3)", () => {
  it("applies strong across the selection, preserving it", () => {
    const s0 = selectAll(paraState());
    const { ok, state: s1 } = run(s0, toggleStrong);
    expect(ok).toBe(true);
    expect(s1.doc.rangeHasMark(s1.selection.from, s1.selection.to, st)).toBe(true);
    expect(s1.selection.from).toBe(s0.selection.from);
    expect(s1.selection.to).toBe(s0.selection.to);
  });
  it("toggles OFF on a second invocation", () => {
    const s1 = run(selectAll(paraState()), toggleStrong).state;
    const s2 = run(s1, toggleStrong).state;
    expect(s2.doc.rangeHasMark(s2.selection.from, s2.selection.to, st)).toBe(false);
  });
  it("LAYERS with highlight and underline — none evicts another", () => {
    const s1 = run(selectAll(paraState()), toggleHighlight("blue")).state;
    const s2 = run(s1, toggleUnderline).state;
    const s3 = run(s2, toggleStrong).state;
    const { from, to } = s3.selection;
    expect(s3.doc.rangeHasMark(from, to, st)).toBe(true);
    expect(s3.doc.rangeHasMark(from, to, ul)).toBe(true);
    expect(s3.doc.rangeHasMark(from, to, hl)).toBe(true);
  });
});

describe("clearMarks (F12)", () => {
  it("strips every inline mark from the selection, preserving the selection and text", () => {
    let s = run(selectAll(paraState()), toggleHighlight("yellow")).state;
    s = run(s, toggleUnderline).state;
    s = run(s, toggleStrong).state;
    const s0 = s;
    const { ok, state: cleared } = run(s0, clearMarks);
    expect(ok).toBe(true);
    const { from, to } = cleared.selection;
    expect(cleared.doc.rangeHasMark(from, to, hl)).toBe(false);
    expect(cleared.doc.rangeHasMark(from, to, ul)).toBe(false);
    expect(cleared.doc.rangeHasMark(from, to, st)).toBe(false);
    expect(cleared.doc.rangeHasMark(from, to, em)).toBe(false);
    expect(cleared.doc.rangeHasMark(from, to, mu)).toBe(false);
    expect(cleared.doc.textContent).toBe("hello world"); // text untouched
    expect(cleared.selection.from).toBe(s0.selection.from);
    expect(cleared.selection.to).toBe(s0.selection.to);
  });
  it("at a bare cursor clears the stored marks so the next typed run is plain", () => {
    const stored = run(cursorAt(paraState(), 1), toggleHighlight("yellow")).state;
    expect(stored.storedMarks?.some((m) => m.type === hl)).toBe(true);
    const { ok, state: cleared } = run(stored, clearMarks);
    expect(ok).toBe(true);
    expect(cleared.storedMarks?.some((m) => m.type === hl) ?? false).toBe(false);
  });
  it("returns false on an unmarked bare cursor (does not swallow the F12 keystroke)", () => {
    const { ok, dispatches } = (() => {
      const s = cursorAt(paraState(), 1);
      let n = 0;
      const okv = clearMarks(s, () => {
        n++;
      });
      return { ok: !!okv, dispatches: n };
    })();
    expect(ok).toBe(false);
    expect(dispatches).toBe(0);
  });
});

// clearFormatting's MARK-stripping behaviour must match clearMarks on a plain paragraph (no block reset
// happens here — a paragraph is already plain). The heading/analytic → paragraph RESET, and the
// card-marks-only case, are proven in block-semantics.test.ts where heading/analytic/card builders live.
describe("clearFormatting (F12) — mark parity on a plain paragraph", () => {
  it("strips every inline mark across a selection, preserving selection + text (in ONE transaction)", () => {
    let s = run(selectAll(paraState()), toggleHighlight("yellow")).state;
    s = run(s, toggleUnderline).state;
    s = run(s, toggleStrong).state;
    const s0 = s;
    let n = 0;
    let cleared = s0;
    const ok = clearFormatting(s0, (tr) => {
      n++;
      cleared = s0.apply(tr);
    });
    expect(ok).toBe(true);
    expect(n).toBe(1); // exactly one transaction
    const { from, to } = cleared.selection;
    expect(cleared.doc.rangeHasMark(from, to, hl)).toBe(false);
    expect(cleared.doc.rangeHasMark(from, to, ul)).toBe(false);
    expect(cleared.doc.rangeHasMark(from, to, st)).toBe(false);
    expect(cleared.doc.textContent).toBe("hello world");
    expect(cleared.doc.child(0).type.name).toBe("paragraph"); // a paragraph stays a paragraph
    expect(cleared.selection.from).toBe(s0.selection.from);
    expect(cleared.selection.to).toBe(s0.selection.to);
  });

  it("at a bare cursor clears the stored marks (next typed run is plain)", () => {
    const stored = run(cursorAt(paraState(), 1), toggleHighlight("yellow")).state;
    const { ok, state: cleared } = run(stored, clearFormatting);
    expect(ok).toBe(true);
    expect(cleared.storedMarks?.some((m) => m.type === hl) ?? false).toBe(false);
  });

  it("returns false on a bare cursor in a plain, unmarked paragraph (F12 falls through)", () => {
    let n = 0;
    const ok = clearFormatting(cursorAt(paraState(), 1), () => {
      n++;
    });
    expect(!!ok).toBe(false);
    expect(n).toBe(0);
  });
});

// caretToDocEnd is the unit-testable core of the click-below-content affordance. The DOM geometry
// that decides "below all content" is verified manually (jsdom has no layout); here we prove the command
// lands the caret at Selection.atEnd(doc), independent of where the selection started.
describe("caretToDocEnd", () => {
  function multiDoc(): EditorState {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ blockId: "p1" }, schema.text("first")),
      schema.nodes.paragraph.create({ blockId: "p2" }, schema.text("last block")),
    ]);
    return EditorState.create({ schema, doc });
  }

  it("moves the selection to Selection.atEnd(doc) from a caret in the FIRST block", () => {
    const s0 = cursorAt(multiDoc(), 1); // inside the first paragraph
    let next = s0;
    let n = 0;
    const ok = caretToDocEnd(s0, (tr) => {
      n++;
      next = s0.apply(tr);
    });
    expect(ok).toBe(true);
    expect(n).toBe(1);
    const expected = Selection.atEnd(s0.doc);
    expect(next.selection.from).toBe(expected.from);
    expect(next.selection.to).toBe(expected.to);
    // and that is the end of the LAST block's content
    expect(next.selection.$from.node(1).attrs.blockId).toBe("p2");
    expect(next.selection.$from.parentOffset).toBe("last block".length);
  });

  it("is idempotent when the caret is already at the doc end", () => {
    const s0 = multiDoc();
    const atEnd = s0.apply(s0.tr.setSelection(Selection.atEnd(s0.doc)));
    const { state: next } = run(atEnd, caretToDocEnd);
    expect(next.selection.from).toBe(Selection.atEnd(s0.doc).from);
  });

  it("returns true even with no dispatch (probe), without throwing", () => {
    expect(!!caretToDocEnd(multiDoc(), undefined)).toBe(true);
  });
});
