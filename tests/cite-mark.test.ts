// cite-mark.test.ts — E11: the cite STYLE is an inline mark applied to the SELECTION, not a card insert.
//
// The user's bug: clicking "Cite" used to build a whole new card. Now it toggles the `cite` mark on the
// current selection (or sets a stored mark at a bare caret), exactly like Bold/Underline — and never creates
// a card. These tests pin that, plus the structural facts that a card is now `tag body` and that the cite mark
// is one of the F12-clearable marks.

import { describe, it, expect } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Command } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { schema, buildCard } from "../src/schema";
import { toggleCite, clearMarks } from "../src/commands";
import { structureHost } from "../src/structure-host";

const id = (): string => structureHost.structure.newUnitId();
const cite = schema.marks.cite;

/** A one-paragraph doc whose paragraph content is `text` (positions: content starts at 1). */
function paraDoc(text: string): PMNode {
  return schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create({ blockId: id() }, text ? schema.text(text) : undefined),
  ]);
}

function stateOf(doc: PMNode): EditorState {
  return EditorState.create({ schema, doc });
}

/** Run a Command with a real dispatch; return whether it handled and the resulting state. */
function run(state: EditorState, cmd: Command): { handled: boolean; state: EditorState } {
  let next = state;
  const handled = cmd(state, (tr) => {
    next = state.apply(tr);
  });
  return { handled, state: next };
}

describe("toggleCite — the cite mark on the SELECTION (E11)", () => {
  it("marks ONLY the selected text and creates NO new card", () => {
    // "Hello world": "Hello" = [1,6), " world" = [6,12).
    const state = stateOf(paraDoc("Hello world"));
    const selected = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 6)));
    const { handled, state: after } = run(selected, toggleCite);

    expect(handled).toBe(true);
    expect(after.doc.rangeHasMark(1, 6, cite)).toBe(true); // "Hello" is cite-marked
    expect(after.doc.rangeHasMark(7, 12, cite)).toBe(false); // "world" is not
    // The doc is still ONE plain paragraph — toggling the mark never inserts a card.
    expect(after.doc.childCount).toBe(1);
    expect(after.doc.child(0).type.name).toBe("paragraph");
  });

  it("at a bare caret sets a STORED mark so the next typed run is cite-styled", () => {
    const state = stateOf(paraDoc("Hello"));
    const caret = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 6))); // end of "Hello"
    const { state: after } = run(caret, toggleCite);
    expect(after.storedMarks?.some((m) => m.type === cite)).toBe(true);
  });

  it("toggles OFF an already-cited selection (removes the mark)", () => {
    const state = stateOf(paraDoc("Hello world"));
    const sel = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 6)));
    const once = run(sel, toggleCite).state;
    expect(once.doc.rangeHasMark(1, 6, cite)).toBe(true);
    // Re-select the same range (the selection survives a mark step) and toggle again.
    const reSel = once.apply(once.tr.setSelection(TextSelection.create(once.doc, 1, 6)));
    const twice = run(reSel, toggleCite).state;
    expect(twice.doc.rangeHasMark(1, 6, cite)).toBe(false);
  });

  it("F12-clear (clearMarks) strips the cite mark too", () => {
    const state = stateOf(paraDoc("Hello world"));
    const sel = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 6)));
    const cited = run(sel, toggleCite).state;
    expect(cited.doc.rangeHasMark(1, 6, cite)).toBe(true);
    const reSel = cited.apply(cited.tr.setSelection(TextSelection.create(cited.doc, 1, 6)));
    const cleared = run(reSel, clearMarks).state;
    expect(cleared.doc.rangeHasMark(1, 6, cite)).toBe(false);
  });
});

describe("card is `tag body`; buildCard ignores the legacy cite arg (E11)", () => {
  it("builds a 2-child `tag body` card that passes check()", () => {
    const card = buildCard({ blockId: id(), tag: [schema.text("T")], body: [{ blockId: id(), content: [schema.text("B")] }] });
    expect(card.childCount).toBe(2);
    expect([card.child(0).type.name, card.child(1).type.name]).toEqual(["tag", "body"]);
    expect(() => card.check()).not.toThrow();
  });

  it("IGNORES a legacy `cite` argument (no cite child, no cite text leaks in)", () => {
    const card = buildCard({
      blockId: id(),
      tag: [schema.text("T")],
      cite: [schema.text("SHOULD-BE-IGNORED")],
      body: [{ blockId: id(), content: [schema.text("B")] }],
    });
    expect(card.childCount).toBe(2);
    expect(card.textContent.includes("SHOULD-BE-IGNORED")).toBe(false);
  });
});
