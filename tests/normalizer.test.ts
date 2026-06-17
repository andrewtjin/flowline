// normalizer.test.ts — unit tests for the STRUCTURAL absorb normalizer.
//
// The behaviour under test: a position/adjacency-sensitive, content-MUTATING, STRUCTURAL normalizer. Here
// that is "a loose top-level non-empty `paragraph` immediately after a `card` is absorbed into that card's
// `body`."
//
// The normalizer is NOT wired live: an earlier build folded a loose paragraph into the preceding card on
// caret-leave via the editor's `appendTransaction`, but that live behaviour was removed as unwanted, so
// `liveNormalize` / `absorbNormalizer` / `absorbNormalizerPlugin` are gone and the live-path tests with them.
// What remains — and what these tests pin — is the deterministic FULL-DOC scan: the one-shot IMPORT-REPAIR
// entry point the editor runs explicitly (never live):
//   - structural absorb (the contiguous run after a card → the card body), content-mutating
//   - the absorbed paragraph keeps its blockId + content (relocation, not re-creation); empty / non-paragraph
//     blocks are barriers; the rebuilt card is check()-valid (`paragraph+`)
//   - fixpoint — the whole run is absorbed in one pass, so a 2nd pass produces zero further changes
//   - the FULL-DOC-SCAN adversary touches EVERY top-level block (touch-count == block count) AND mutates
//     structurally in the same test — not a strawman adjacency-local scan
//   - no blockId minted; relocation conserves the id set; no duplicate body id; a paragraph NOT immediately
//     after a card is left untouched

import { describe, it, expect } from "vitest";
import { EditorState } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { schema, buildCard } from "../src/schema";
import { fullScanNormalize } from "../src/normalizer";

const { doc, paragraph, analytic, heading, hard_break } = schema.nodes;
const { highlight } = schema.marks;

// ── Builders ─────────────────────────────────────────────────────────────────────────────────
const para = (text: string, id: string): PMNode => paragraph.create({ blockId: id }, text ? schema.text(text) : undefined);
const emptyPara = (id: string): PMNode => paragraph.create({ blockId: id });
const anal = (text: string, id: string): PMNode => analytic.create({ blockId: id }, schema.text(text));
const head = (text: string, id: string): PMNode => heading.create({ blockId: id, level: "block" }, schema.text(text));

// A valid card (body := paragraph+): one body paragraph with a distinct id, via the production buildCard.
function aCard(id: string, bodyId: string, bodyText = "evidence"): PMNode {
  return buildCard({
    blockId: id,
    tag: [schema.text("claim")],
    cite: [schema.text("Author 24")],
    body: [{ blockId: bodyId, content: [schema.text(bodyText)] }],
  });
}

const mkDoc = (...blocks: PMNode[]): PMNode => doc.create(null, blocks);
const stateOf = (d: PMNode): EditorState => EditorState.create({ schema, doc: d });

// Top-level child ids of a doc, in order.
const topIds = (d: PMNode): string[] => {
  const out: string[] = [];
  d.forEach((n) => out.push(n.attrs.blockId as string));
  return out;
};
const bodyOf = (d: PMNode, i = 0): PMNode => d.child(i).child(2);
const bodyIds = (d: PMNode, i = 0): string[] => {
  const out: string[] = [];
  bodyOf(d, i).forEach((p) => out.push(p.attrs.blockId as string));
  return out;
};

// ── structural absorb, relocation, and fixpoint via the FULL-DOC scan (deterministic, no selection deferral) ──
describe("structural absorb (full-doc scan)", () => {
  it("absorbs a loose paragraph immediately after a card INTO that card's body", () => {
    const before = mkDoc(aCard("C", "B0"), para("loose evidence", "P1"));
    const { tr } = fullScanNormalize(stateOf(before));
    expect(tr).not.toBeNull();
    const after = stateOf(before).apply(tr!).doc;
    expect(topIds(after)).toEqual(["C"]); // the loose paragraph left the top level...
    expect(bodyIds(after)).toEqual(["B0", "P1"]); // ...and is now the card's SECOND body paragraph
    expect(bodyOf(after).child(1).textContent).toBe("loose evidence");
  });

  it("absorbs a CONTIGUOUS RUN of loose paragraphs in one pass (preserving order)", () => {
    const before = mkDoc(aCard("C", "B0"), para("one", "P1"), para("two", "P2"), para("three", "P3"));
    const after = stateOf(before).apply(fullScanNormalize(stateOf(before)).tr!).doc;
    expect(topIds(after)).toEqual(["C"]);
    expect(bodyIds(after)).toEqual(["B0", "P1", "P2", "P3"]);
    expect(bodyOf(after).child(3).textContent).toBe("three");
  });

  it("is content-MUTATING — the doc actually changes (not a no-op classifier)", () => {
    const before = mkDoc(aCard("C", "B0"), para("x", "P1"));
    const s = stateOf(before);
    const after = s.apply(fullScanNormalize(s).tr!).doc;
    expect(after.eq(before)).toBe(false);
  });
});

describe("relocation: identity + content preserved, barriers, validity", () => {
  it("PRESERVES the absorbed paragraph's blockId AND inline content + marks (relocation, not re-creation)", () => {
    const rich = paragraph.create({ blockId: "P1" }, [
      schema.text("read "),
      schema.text("this", [highlight.create({ color: "yellow" })]),
    ]);
    const before = mkDoc(aCard("C", "B0"), rich);
    const after = stateOf(before).apply(fullScanNormalize(stateOf(before)).tr!).doc;
    const moved = bodyOf(after).child(1);
    expect(moved.attrs.blockId).toBe("P1"); // SAME id — never re-minted
    expect(moved.textContent).toBe("read this");
    let sawYellow = false;
    moved.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type === highlight && m.attrs.color === "yellow")) sawYellow = true;
    });
    expect(sawYellow).toBe(true);
  });

  it("the rebuilt card is check()-valid (paragraph+ body)", () => {
    const before = mkDoc(aCard("C", "B0"), para("x", "P1"));
    const after = stateOf(before).apply(fullScanNormalize(stateOf(before)).tr!).doc;
    expect(() => after.check()).not.toThrow();
  });

  it("an EMPTY paragraph after a card is a BARRIER — not absorbed, and it stops the run", () => {
    const before = mkDoc(aCard("C", "B0"), emptyPara("P1"), para("after the gap", "P2"));
    expect(fullScanNormalize(stateOf(before)).tr).toBeNull(); // empty para = barrier; nothing to absorb
    expect(topIds(before)).toEqual(["C", "P1", "P2"]); // unchanged
  });

  it("a non-empty paragraph that follows a card THROUGH a barrier is left alone", () => {
    const before = mkDoc(aCard("C", "B0"), emptyPara("P1"), para("free", "P2"));
    expect(fullScanNormalize(stateOf(before)).tr).toBeNull();
  });

  it("a paragraph whose only content is a hard_break IS absorbed (content.size>0; matches convertToTag's barrier test)", () => {
    const brPara = paragraph.create({ blockId: "P1" }, hard_break.create());
    const before = mkDoc(aCard("C", "B0"), brPara);
    const after = stateOf(before).apply(fullScanNormalize(stateOf(before)).tr!).doc;
    expect(topIds(after)).toEqual(["C"]);
    expect(bodyIds(after)).toEqual(["B0", "P1"]);
  });

  it("a NON-paragraph block (analytic / heading / another card) is a BARRIER", () => {
    expect(fullScanNormalize(stateOf(mkDoc(aCard("C", "B0"), anal("an analytic", "A1"), para("p", "P2")))).tr).toBeNull();
    expect(fullScanNormalize(stateOf(mkDoc(aCard("C", "B0"), head("a heading", "H1")))).tr).toBeNull();
    expect(fullScanNormalize(stateOf(mkDoc(aCard("C1", "B0"), aCard("C2", "B1")))).tr).toBeNull();
  });

  it("a paragraph BETWEEN two cards is absorbed into the PRECEDING card", () => {
    const before = mkDoc(aCard("C1", "B0"), para("between", "P1"), aCard("C2", "B1"));
    const after = stateOf(before).apply(fullScanNormalize(stateOf(before)).tr!).doc;
    expect(topIds(after)).toEqual(["C1", "C2"]);
    expect(bodyIds(after, 0)).toEqual(["B0", "P1"]); // into C1, not C2
  });
});

describe("fixpoint", () => {
  it("reaches a fixpoint: a 2nd full-scan pass produces NO further change (run absorbed in pass 1)", () => {
    const before = mkDoc(aCard("C", "B0"), para("a", "P1"), para("b", "P2"));
    const mid = stateOf(before).apply(fullScanNormalize(stateOf(before)).tr!);
    expect(topIds(mid.doc)).toEqual(["C"]);
    expect(bodyIds(mid.doc)).toEqual(["B0", "P1", "P2"]);
    expect(fullScanNormalize(mid).tr).toBeNull(); // 2nd pass: nothing left
  });
});

// ── the full-scan is the real adversary (touches every block + mutates) ──────────────────────────
describe("full-doc scan touches every top-level block AND mutates (not an adjacency-local strawman)", () => {
  it("touch-count == top-level block count, AND the same scan returns a non-null mutating tr", () => {
    const d = mkDoc(para("a", "A"), aCard("C", "B0"), para("loose", "L"), anal("c", "D"), head("e", "E"));
    const { tr, touched } = fullScanNormalize(stateOf(d));
    expect(touched).toBe(d.childCount);
    expect(touched).toBe(5);
    expect(tr).not.toBeNull(); // the exhaustive scanner is the SAME object that mutates (anti-strawman)
    expect(stateOf(d).apply(tr!).doc.eq(d)).toBe(false);
  });

  it("still touches every block even when there is nothing to absorb", () => {
    const d = mkDoc(para("a", "A"), head("b", "B"), anal("c", "C"));
    const { tr, touched } = fullScanNormalize(stateOf(d));
    expect(tr).toBeNull();
    expect(touched).toBe(3);
  });
});

// ── no minting, no false positives ───────────────────────────────────────────────────────────────
describe("identity and non-interference", () => {
  it("never mints a blockId — absorptions only RELOCATE (the id set is conserved)", () => {
    const before = mkDoc(aCard("C", "B0"), para("p1", "P1"), para("p2", "P2"));
    const beforeIds = new Set([...topIds(before), ...bodyIds(before)]);
    const after = stateOf(before).apply(fullScanNormalize(stateOf(before)).tr!).doc;
    const afterIds = new Set([...topIds(after), ...bodyIds(after)]);
    expect([...afterIds].sort()).toEqual([...beforeIds].sort());
  });

  it("does NOT create a duplicate body blockId — a colliding-id paragraph stops the run", () => {
    // a loose paragraph carrying the SAME id as an existing body paragraph (possible post-merge) is NOT absorbed.
    const dup = paragraph.create({ blockId: "B0" }, schema.text("dup"));
    const before = mkDoc(aCard("C", "B0"), dup);
    expect(fullScanNormalize(stateOf(before)).tr).toBeNull(); // would duplicate body id "B0" → barrier
    // but a distinct-id paragraph AFTER the colliding one is also protected (run stopped at the collision).
    const before2 = mkDoc(aCard("C", "B0"), dup, para("ok", "P2"));
    expect(fullScanNormalize(stateOf(before2)).tr).toBeNull();
  });

  it("a loose paragraph that is NOT immediately after a card is left untouched", () => {
    expect(fullScanNormalize(stateOf(mkDoc(para("lead", "P0"), aCard("C", "B0")))).tr).toBeNull(); // before a card
    expect(fullScanNormalize(stateOf(mkDoc(head("h", "H0"), para("after heading", "P1")))).tr).toBeNull();
    expect(fullScanNormalize(stateOf(mkDoc(anal("an", "A0"), para("after analytic", "P1")))).tr).toBeNull();
    expect(fullScanNormalize(stateOf(mkDoc(para("p", "P0"), para("after paragraph", "P1")))).tr).toBeNull();
  });

  it("is a no-op on an empty document", () => {
    const empty = doc.create(null, []);
    expect(fullScanNormalize(stateOf(empty)).tr).toBeNull();
  });
});

// ── Multiple independent absorptions in one full-scan pass ───────────────────────────────────────
describe("multiple cards each absorb their own run in a single full-scan transaction", () => {
  it("absorbs into each preceding card, leaving the others intact and check()-valid", () => {
    const before = mkDoc(
      aCard("C1", "B0"),
      para("for c1", "P1"),
      aCard("C2", "B1"),
      para("for c2 a", "P2"),
      para("for c2 b", "P3"),
    );
    const after = stateOf(before).apply(fullScanNormalize(stateOf(before)).tr!).doc;
    expect(topIds(after)).toEqual(["C1", "C2"]);
    expect(bodyIds(after, 0)).toEqual(["B0", "P1"]);
    expect(bodyIds(after, 1)).toEqual(["B1", "P2", "P3"]);
    expect(() => after.check()).not.toThrow();
  });
});
