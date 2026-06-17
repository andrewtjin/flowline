// toolbar.test.ts — unit tests for the picker-colour derivation (cheap, jsdom, no browser).
// Proves `activeHighlightColor(state)` reflects the highlight AT the caret/selection: a freshly
// highlighted run lights the right swatch, a recoloured run shows the NEW colour, and a
// selection with no/mixed highlight shows NO active colour. This is the unit proof that the
// recolour bug is fixed without an e2e — the helper is a pure function of EditorState.

import { describe, it, expect } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { schema } from "../src/schema";
import { toggleHighlight } from "../src/commands";
import { activeHighlightColor } from "../src/toolbar";

const hl = schema.marks.highlight;

// Single-paragraph doc; text content begins at pos 1, paragraph closes at content.size - 1.
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
// Apply a command and return the resulting state, keeping the command's own selection.
function apply(state: EditorState, cmd: (s: EditorState, d: (tr: import("prosemirror-state").Transaction) => void) => boolean): EditorState {
  let next = state;
  cmd(state, (tr) => {
    next = state.apply(tr);
  });
  return next;
}

describe("activeHighlightColor", () => {
  it("returns null when nothing is highlighted", () => {
    expect(activeHighlightColor(selectAll(paraState()))).toBeNull();
  });

  it("reflects the colour of a freshly-highlighted selection (was: showed nothing)", () => {
    const s = apply(selectAll(paraState()), toggleHighlight("yellow"));
    expect(activeHighlightColor(s)).toBe("yellow");
  });

  it("reflects the NEW colour after a recolor yellow -> green (the recolour bug)", () => {
    const yellow = apply(selectAll(paraState()), toggleHighlight("yellow"));
    const green = apply(yellow, toggleHighlight("green"));
    expect(activeHighlightColor(green)).toBe("green");
  });

  it("shows the stored-mark colour at a bare cursor (next typed run will be highlighted)", () => {
    const s = apply(cursorAt(paraState(), 1), toggleHighlight("blue"));
    expect(activeHighlightColor(s)).toBe("blue");
  });

  it("shows NO active colour for a selection that is only partly highlighted (mixed)", () => {
    // Highlight only the first three chars, then select the whole paragraph.
    const base = paraState("abcdef");
    const partial = base.apply(base.tr.setSelection(TextSelection.create(base.doc, 1, 4)));
    const highlighted = apply(partial, toggleHighlight("green"));
    const whole = highlighted.apply(
      highlighted.tr.setSelection(TextSelection.create(highlighted.doc, 1, highlighted.doc.content.size - 1)),
    );
    expect(activeHighlightColor(whole)).toBeNull();
  });

  it("is uniform => returns the common colour when the WHOLE selection shares one colour", () => {
    const s = apply(selectAll(paraState()), toggleHighlight("blue"));
    const reselected = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 1, s.doc.content.size - 1)));
    expect(activeHighlightColor(reselected)).toBe("blue");
  });

  it("derives directly from a doc that carries the highlight mark (no command needed)", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ blockId: "p1" }, schema.text("hi", [hl.create({ color: "lightGray" })])),
    ]);
    let s = EditorState.create({ schema, doc });
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 1, s.doc.content.size - 1)));
    expect(activeHighlightColor(s)).toBe("lightGray");
  });
});
