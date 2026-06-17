// cite-placeholder.test.ts — unit tests for the empty-cite "[citation]" hint. The decoration
// logic is a pure (state → DecorationSet) function, so the show/hide rules are provable without a DOM or an
// EditorView. The actual ::before rendering is CSS, exercised visually.

import { describe, it, expect } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { schema, buildCard } from "../src/schema";
import { citePlaceholderDecorations } from "../src/cite-placeholder";

const { doc, paragraph } = schema.nodes;
const txt = (s: string): PMNode => schema.text(s);
const mkDoc = (...blocks: PMNode[]): PMNode => doc.create(null, blocks);
const para = (t: string, id = "p"): PMNode => paragraph.create({ blockId: id }, t ? txt(t) : null);

// A card whose cite is EMPTY (cite omitted → buildCard makes an empty cite child).
const cardNoCite = (id = "c"): PMNode =>
  buildCard({ blockId: id, tag: [txt("Claim")], body: [{ blockId: `${id}b`, content: [txt("evidence")] }] });
// A card whose cite HAS content.
const cardWithCite = (id = "c"): PMNode =>
  buildCard({
    blockId: id,
    tag: [txt("Claim")],
    cite: [txt("Author 2020")],
    body: [{ blockId: `${id}b`, content: [txt("evidence")] }],
  });

// Default selection (atStart) lands in the first textblock = the tag, never the cite.
function stateOf(d: PMNode): EditorState {
  return EditorState.create({ schema, doc: d });
}
function withCaret(d: PMNode, pos: number): EditorState {
  const s = stateOf(d);
  return s.apply(s.tr.setSelection(TextSelection.create(s.doc, pos)));
}
// Position just before the n-th cite node (n defaults to 0); its inner caret position is this + 1.
function citePos(d: PMNode, n = 0): number {
  let found = -1;
  let seen = 0;
  d.descendants((node, pos) => {
    if (found === -1 && node.type.name === "cite") {
      if (seen === n) found = pos;
      seen++;
    }
    return found === -1;
  });
  if (found === -1) throw new Error("no cite in doc");
  return found;
}

describe("cite placeholder decoration", () => {
  it("shows a placeholder over an EMPTY cite when the caret is elsewhere", () => {
    const d = mkDoc(cardNoCite("c1"));
    const decos = citePlaceholderDecorations(stateOf(d)).find(); // default caret sits in the tag
    expect(decos.length).toBe(1);
    expect(decos[0].from).toBe(citePos(d)); // decoration spans the empty cite node
  });

  it("HIDES the placeholder while the caret is inside the empty cite (clicked in)", () => {
    const d = mkDoc(cardNoCite("c1"));
    const decos = citePlaceholderDecorations(withCaret(d, citePos(d) + 1)).find(); // caret in the cite
    expect(decos.length).toBe(0);
  });

  it("shows NO placeholder when the cite already has content (e.g. after paste)", () => {
    const d = mkDoc(cardWithCite("c1"));
    const decos = citePlaceholderDecorations(stateOf(d)).find();
    expect(decos.length).toBe(0);
  });

  it("treats each card independently — only the empty cites get a hint", () => {
    const d = mkDoc(cardNoCite("c1"), cardWithCite("c2"), cardNoCite("c3"), para("loose", "p1"));
    const decos = citePlaceholderDecorations(stateOf(d)).find();
    expect(decos.length).toBe(2); // c1 + c3 empty; c2 filled; the loose paragraph has no cite
  });

  it("the hint RETURNS after the caret leaves an empty cite (focus in → out)", () => {
    const d = mkDoc(cardNoCite("c1"));
    const inside = citePlaceholderDecorations(withCaret(d, citePos(d) + 1)).find();
    expect(inside.length).toBe(0); // focused → hidden
    const away = citePlaceholderDecorations(stateOf(d)).find();
    expect(away.length).toBe(1); // unfocused empty cite → shown again
  });

  it("a doc with no cards yields no decorations (and never throws)", () => {
    const d = mkDoc(para("just a paragraph", "p1"));
    expect(citePlaceholderDecorations(stateOf(d)).find().length).toBe(0);
  });
});
