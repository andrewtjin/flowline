// move.test.ts — unit tests for moveBlock (reorder as destroy + recreate).
//
// The invariant under test: a reorder is modelled
// as DELETE the unit + RE-INSERT an identical unit elsewhere, under the SAME blockId. So the recreated
// block must be DEEP-EQUAL to the original — children, text, every mark WITH its position, hard_breaks —
// and its blockId must be preserved, never re-minted. These tests assert `original.eq(recreated)` on a
// deliberately rich block (highlight colour + emphasis + hard_break) so a shallow copy or a dropped mark
// would fail loudly.

import { describe, it, expect } from "vitest";
import { EditorState, TextSelection, NodeSelection } from "prosemirror-state";
import type { Command } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../src/schema";
import { moveBlock, moveCurrentBlock } from "../src/commands";

const { doc, paragraph, analytic, card, tag, body, hard_break } = schema.nodes;
const { highlight, emphasis } = schema.marks;

const para = (text: string, id: string): PMNode => paragraph.create({ blockId: id }, schema.text(text));
const anal = (text: string, id: string): PMNode => analytic.create({ blockId: id }, schema.text(text));

// A deliberately rich card: a highlight (with a colour attr), an emphasis mark, and a hard_break — the
// hardest thing to round-trip deep-equal. Card content is now `tag body` (the cite NODE was removed in v5),
// and body is `paragraph+`, so the rich inline content lives in a body paragraph.
function richCard(id: string): PMNode {
  return card.create({ blockId: id }, [
    tag.create(null, schema.text("Emissions accelerating")),
    body.create(null, paragraph.create({ blockId: `${id}-b0` }, [
      schema.text("plain "),
      schema.text("hot run", [highlight.create({ color: "yellow" })]),
      hard_break.create(),
      schema.text("stressed", [emphasis.create()]),
    ])),
  ]);
}

const mkDoc = (...blocks: PMNode[]): PMNode => doc.create(null, blocks);
const stateOf = (d: PMNode): EditorState => EditorState.create({ schema, doc: d });
function run(s: EditorState, cmd: Command): { ok: boolean; state: EditorState } {
  let next = s;
  const ok = cmd(s, (tr) => {
    next = s.apply(tr);
  });
  return { ok: !!ok, state: next };
}
const ids = (s: EditorState): string[] => {
  const out: string[] = [];
  s.doc.forEach((n) => out.push(n.attrs.blockId as string));
  return out;
};
const blockById = (d: PMNode, id: string): PMNode | null => {
  let found: PMNode | null = null;
  d.forEach((n) => {
    if (n.attrs.blockId === id) found = n;
  });
  return found;
};

describe("moveBlock (reorder via destroy + recreate)", () => {
  it("moves a block DOWN, reordering the top-level list", () => {
    const d = mkDoc(para("A", "A"), para("B", "B"), para("C", "C"));
    const { ok, state } = run(stateOf(d), moveBlock("B", "down"));
    expect(ok).toBe(true);
    expect(ids(state)).toEqual(["A", "C", "B"]);
  });

  it("moves a block UP, reordering the top-level list", () => {
    const d = mkDoc(para("A", "A"), para("B", "B"), para("C", "C"));
    const { state } = run(stateOf(d), moveBlock("B", "up"));
    expect(ids(state)).toEqual(["B", "A", "C"]);
  });

  it("is a NO-OP (returns false) at the top edge moving up", () => {
    const d = mkDoc(para("A", "A"), para("B", "B"));
    const { ok, state } = run(stateOf(d), moveBlock("A", "up"));
    expect(ok).toBe(false);
    expect(state.doc.eq(d)).toBe(true);
  });

  it("is a NO-OP (returns false) at the bottom edge moving down", () => {
    const d = mkDoc(para("A", "A"), para("B", "B"));
    const { ok, state } = run(stateOf(d), moveBlock("B", "down"));
    expect(ok).toBe(false);
    expect(state.doc.eq(d)).toBe(true);
  });

  it("returns false for an unknown blockId", () => {
    const d = mkDoc(para("A", "A"));
    expect(run(stateOf(d), moveBlock("ZZZ", "down")).ok).toBe(false);
  });

  it("recreates the moved block DEEP-EQUAL to the original (marks + positions + hard_break) and PRESERVES its blockId", () => {
    const original = richCard("RICH");
    const d = mkDoc(para("A", "A"), original, para("C", "C"));
    const { state } = run(stateOf(d), moveBlock("RICH", "up"));
    expect(ids(state)).toEqual(["RICH", "A", "C"]);

    const recreated = blockById(state.doc, "RICH");
    expect(recreated).not.toBeNull();
    // The strongest assertion: the recreated node is byte-for-byte the same document fragment.
    expect(original.eq(recreated as PMNode)).toBe(true);
    // And called out explicitly: the blockId is the SAME, not a freshly minted one.
    expect((recreated as PMNode).attrs.blockId).toBe("RICH");
    // The rich content actually survived (guards against eq() passing on a trivially-empty block):
    // the full card text is tag + body concatenated (no cite child anymore).
    expect((recreated as PMNode).textContent).toContain("plain hot runstressed");
    let breaks = 0;
    (recreated as PMNode).descendants((n) => {
      if (n.type.name === "hard_break") breaks++;
    });
    expect(breaks).toBe(1);
    // Mark with its colour attr preserved at the right place.
    let sawYellow = false;
    (recreated as PMNode).descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type === highlight && m.attrs.color === "yellow")) sawYellow = true;
    });
    expect(sawYellow).toBe(true);
  });

  it("leaves the OTHER blocks untouched (only the moved block is recreated)", () => {
    const a = para("A", "A");
    const c = anal("C", "C");
    const { state } = run(stateOf(mkDoc(a, para("B", "B"), c)), moveBlock("B", "down"));
    expect(blockById(state.doc, "A")?.eq(a)).toBe(true);
    expect(blockById(state.doc, "C")?.eq(c)).toBe(true);
  });

  it("lands the caret inside the moved block", () => {
    const d = mkDoc(para("A", "A"), para("B", "B"), para("C", "C"));
    const { state } = run(stateOf(d), moveBlock("B", "down"));
    // caret should be inside the block whose id is B
    const $from = state.selection.$from;
    expect($from.node(1).attrs.blockId).toBe("B");
  });
});

describe("moveCurrentBlock (the Alt-↑/↓ wrapper)", () => {
  it("moves the block that currently holds the caret", () => {
    const d = mkDoc(para("A", "A"), para("B", "B"), para("C", "C"));
    // put the caret inside block B
    let s = stateOf(d);
    let posInB = -1;
    s.doc.forEach((n, offset) => {
      if (n.attrs.blockId === "B") posInB = offset + 1;
    });
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, posInB)));
    const { ok, state } = run(s, moveCurrentBlock("down"));
    expect(ok).toBe(true);
    expect(ids(state)).toEqual(["A", "C", "B"]);
  });

  it("returns false when there is no top-level block to move (degenerate selection)", () => {
    // An empty doc has no block under the caret.
    const empty = doc.create(null, []);
    const s = EditorState.create({ schema, doc: empty });
    expect(run(s, moveCurrentBlock("up")).ok).toBe(false);
  });

  it("moves a NODE-SELECTED top-level block (Alt-↑/↓ stays live after select-block) — adversarial regression", () => {
    const d = mkDoc(para("A", "A"), para("B", "B"), para("C", "C"));
    let s = stateOf(d);
    let bOffset = -1;
    s.doc.forEach((n, off) => {
      if (n.attrs.blockId === "B") bOffset = off;
    });
    s = s.apply(s.tr.setSelection(NodeSelection.create(s.doc, bOffset)));
    const { ok, state } = run(s, moveCurrentBlock("down"));
    expect(ok).toBe(true);
    expect(ids(state)).toEqual(["A", "C", "B"]);
  });
});
