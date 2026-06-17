// block-semantics.test.ts — unit tests for the block commands (cheap, jsdom, no browser).
// Proves Enter/Backspace context rules and the insert commands at the STATE level. The real-browser proofs
// (caret survives re-render; native character backspace) live in e2e/blocks.spec.ts; the reorder deep-equal
// invariant is its own file, tests/move.test.ts.

import { describe, it, expect, vi } from "vitest";
import { EditorState, TextSelection, NodeSelection, AllSelection } from "prosemirror-state";
import type { Command } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { schema, buildCard } from "../src/schema";
import {
  enter,
  backspace,
  insertCard,
  insertCardAtCite,
  insertAnalytic,
  insertParagraph,
  insertHeading,
  setHeadingLevel,
  convertToTag,
  convertToAnalytic,
  clearFormatting,
} from "../src/commands";

// Card children (tag/cite/body) are constructed via `buildCard`, so only the node types the suite
// references directly are pulled out here.
const { doc, paragraph, heading, analytic, hard_break } = schema.nodes;
const txt = (s: string): PMNode => schema.text(s);

// ── builders ───────────────────────────────────────────────────────────────────────────────────
// Each block gets an explicit blockId so we can assert the COMMAND mints fresh ids for new blocks.
const para = (text: string, id = "p"): PMNode => paragraph.create({ blockId: id }, text ? txt(text) : null);
const head = (text: string, level = "block", id = "h"): PMNode =>
  heading.create({ blockId: id, level }, text ? txt(text) : null);
const anal = (text: string, id = "a"): PMNode => analytic.create({ blockId: id }, text ? txt(text) : null);
// v4: a card body is `paragraph+`. `aCard` builds a SINGLE-paragraph body (body paragraph id `${id}b`) via
// buildCard so every card the suite constructs is check()-valid. `aCardMulti` builds a multi-paragraph body.
const aCard = (t: string, c: string, b: string, id = "c"): PMNode =>
  buildCard({
    blockId: id,
    tag: t ? [txt(t)] : undefined,
    cite: c ? [txt(c)] : undefined,
    body: [{ blockId: `${id}b`, content: b ? [txt(b)] : undefined }],
  });
const aCardMulti = (t: string, c: string, bodies: string[], id = "c"): PMNode =>
  buildCard({
    blockId: id,
    tag: t ? [txt(t)] : undefined,
    cite: c ? [txt(c)] : undefined,
    body: bodies.map((b, i) => ({ blockId: `${id}b${i}`, content: b ? [txt(b)] : undefined })),
  });
const mkDoc = (...blocks: PMNode[]): PMNode => doc.create(null, blocks);

// ── state helpers ────────────────────────────────────────────────────────────────────────────
function stateOf(d: PMNode): EditorState {
  return EditorState.create({ schema, doc: d });
}
// Absolute END-of-content position of the first node of `typeName` (cursor "at end of the block").
function endOf(d: PMNode, typeName: string): number {
  let pos = -1;
  d.descendants((node, p) => {
    if (pos === -1 && node.type.name === typeName) pos = p + 1 + node.content.size;
    return pos === -1; // stop descending once found
  });
  return pos;
}
// Absolute START-of-content position of the first node of `typeName`.
function startOf(d: PMNode, typeName: string): number {
  let pos = -1;
  d.descendants((node, p) => {
    if (pos === -1 && node.type.name === typeName) pos = p + 1;
    return pos === -1;
  });
  return pos;
}
// v4: body is `paragraph+`. These resolve the START / END content position of the n-th paragraph INSIDE
// the first card body (n defaults to 0 = the first body paragraph) — `startOf(d,"body")` only reaches the
// body wrapper, whose interior is paragraph open/close tokens, not a valid text position.
function bodyParaPos(d: PMNode, n: number): { start: number; end: number } {
  let bodyPos = -1;
  let bodyNode: PMNode | null = null;
  d.descendants((node, p) => {
    if (bodyPos === -1 && node.type.name === "body") {
      bodyPos = p;
      bodyNode = node;
    }
    return bodyPos === -1;
  });
  if (bodyNode === null) throw new Error("no body in doc");
  const bodyContentStart = bodyPos + 1; // inside body, before its first paragraph's open token
  let off = bodyContentStart;
  for (let i = 0; i < n; i++) off += (bodyNode as PMNode).child(i).nodeSize;
  const para = (bodyNode as PMNode).child(n);
  return { start: off + 1, end: off + 1 + para.content.size }; // +1 past the paragraph's own open token
}
const startOfBodyPara = (d: PMNode, n = 0): number => bodyParaPos(d, n).start;
const endOfBodyPara = (d: PMNode, n = 0): number => bodyParaPos(d, n).end;
function cursorAt(s: EditorState, pos: number): EditorState {
  return s.apply(s.tr.setSelection(TextSelection.create(s.doc, pos)));
}
function rangeAt(s: EditorState, from: number, to: number): EditorState {
  return s.apply(s.tr.setSelection(TextSelection.create(s.doc, from, to)));
}
// Module-level whole-block selection helpers (reused by the convertToTag / dissolve safety suites). A
// NodeSelection on the first top-level block of `typeName`; a single AllSelection over the doc.
function topOffsetOf(d: PMNode, typeName: string): number {
  let off = -1;
  d.forEach((n, o) => {
    if (off === -1 && n.type.name === typeName) off = o;
  });
  return off;
}
const nodeSelAt = (s: EditorState, typeName: string): EditorState =>
  s.apply(s.tr.setSelection(NodeSelection.create(s.doc, topOffsetOf(s.doc, typeName))));
const allSelOf = (s: EditorState): EditorState => s.apply(s.tr.setSelection(new AllSelection(s.doc)));
// Run a command with a counting dispatch — `dispatches` proves "exactly one transaction".
function run(s: EditorState, cmd: Command): { ok: boolean; state: EditorState; dispatches: number } {
  let next = s;
  let n = 0;
  const ok = cmd(s, (tr) => {
    n++;
    next = s.apply(tr);
  });
  return { ok: !!ok, state: next, dispatches: n };
}
const blockIds = (s: EditorState): string[] => {
  const ids: string[] = [];
  s.doc.forEach((n) => ids.push(n.attrs.blockId as string));
  return ids;
};
const countType = (node: PMNode, typeName: string): number => {
  let n = 0;
  node.descendants((d) => {
    if (d.type.name === typeName) n++;
  });
  return n;
};

// ── Enter ──────────────────────────────────────────────────────────────────────────────────────
describe("enter", () => {
  it("at the END of a paragraph inserts a NEW paragraph sibling with a fresh blockId, caret inside it", () => {
    const s0 = cursorAt(stateOf(mkDoc(para("hello", "p1"))), endOf(mkDoc(para("hello", "p1")), "paragraph"));
    const { ok, state: s1 } = run(s0, enter);
    expect(ok).toBe(true);
    expect(s1.doc.childCount).toBe(2);
    expect(s1.doc.child(1).type.name).toBe("paragraph");
    // fresh blockId, not reused from the source block
    expect(s1.doc.child(1).attrs.blockId).not.toBe("p1");
    expect(typeof s1.doc.child(1).attrs.blockId).toBe("string");
    // caret landed inside the new (empty) paragraph
    expect(s1.selection.$from.parent.type.name).toBe("paragraph");
    expect(s1.selection.$from.parent.content.size).toBe(0);
    // the original paragraph is untouched
    expect(s1.doc.child(0).eq(para("hello", "p1"))).toBe(true);
  });

  it("at the END of a HEADING makes a PARAGRAPH (not another heading)", () => {
    const d = mkDoc(head("Contention", "hat", "h1"));
    const s1 = run(cursorAt(stateOf(d), endOf(d, "heading")), enter).state;
    expect(s1.doc.childCount).toBe(2);
    expect(s1.doc.child(1).type.name).toBe("paragraph");
  });

  // Enter ANYWHERE in an analytic SPLITS it into two separate analytic blocks (each its own blockId),
  // mirroring the card-body-paragraph split — never a soft hard_break inside one block.
  it("at the END of an ANALYTIC SPLITS into an empty analytic below, content kept above, caret in the new block", () => {
    const d = mkDoc(anal("argument", "a1"));
    const s1 = run(cursorAt(stateOf(d), endOf(d, "analytic")), enter).state;
    expect(s1.doc.childCount).toBe(2);
    // two SEPARATE analytic blocks (the split), not one analytic with a hard_break
    expect(s1.doc.child(0).type.name).toBe("analytic");
    expect(s1.doc.child(1).type.name).toBe("analytic");
    expect(countType(s1.doc, "hard_break")).toBe(0);
    // content stayed in the (BEFORE) block, which kept the source id; the new (AFTER) block is empty + fresh id
    expect(s1.doc.child(0).textContent).toBe("argument");
    expect(s1.doc.child(0).attrs.blockId).toBe("a1");
    expect(s1.doc.child(1).content.size).toBe(0);
    expect(s1.doc.child(1).attrs.blockId).not.toBe("a1");
    expect(typeof s1.doc.child(1).attrs.blockId).toBe("string");
    // caret landed inside the new (empty) analytic
    expect(s1.selection.$from.parent.type.name).toBe("analytic");
    expect(s1.selection.$from.parent.content.size).toBe(0);
    expect(() => s1.doc.check()).not.toThrow();
  });

  it("at the START of an ANALYTIC SPLITS into an empty analytic ABOVE, content (with the caret) in the block below", () => {
    const d = mkDoc(anal("argument", "a1"));
    const s1 = run(cursorAt(stateOf(d), startOf(d, "analytic")), enter).state;
    expect(s1.doc.childCount).toBe(2);
    expect(s1.doc.child(0).type.name).toBe("analytic");
    expect(s1.doc.child(1).type.name).toBe("analytic");
    expect(countType(s1.doc, "hard_break")).toBe(0);
    // tr.split keeps the BEFORE node (the empty analytic above) with the source id; the content moves into the
    // freshly-typed AFTER node below (fresh id). Either way they are SEPARATE blocks with DISTINCT ids.
    expect(s1.doc.child(0).content.size).toBe(0); // empty analytic on top
    expect(s1.doc.child(0).attrs.blockId).toBe("a1"); // the BEFORE node keeps the source id
    expect(s1.doc.child(1).textContent).toBe("argument"); // content moved into the AFTER block
    expect(s1.doc.child(1).attrs.blockId).not.toBe("a1"); // AFTER gets the fresh id
    expect(typeof s1.doc.child(1).attrs.blockId).toBe("string");
    expect(s1.doc.child(0).attrs.blockId).not.toBe(s1.doc.child(1).attrs.blockId); // distinct ids
    // caret followed the content into the lower block
    expect(s1.selection.$from.parent.type.name).toBe("analytic");
    expect(s1.selection.$from.parent.textContent).toBe("argument");
    expect(() => s1.doc.check()).not.toThrow();
  });

  it("MID-text in an ANALYTIC SPLITS the content across two separate analytic blocks", () => {
    const d = mkDoc(anal("argument", "a1"));
    const s1 = run(cursorAt(stateOf(d), startOf(d, "analytic") + 3), enter).state; // after "arg"
    expect(s1.doc.childCount).toBe(2);
    expect(s1.doc.child(0).type.name).toBe("analytic");
    expect(s1.doc.child(1).type.name).toBe("analytic");
    expect(countType(s1.doc, "hard_break")).toBe(0); // a SPLIT, not a soft break
    expect(s1.doc.child(0).textContent).toBe("arg");
    expect(s1.doc.child(1).textContent).toBe("ument");
    expect(s1.doc.child(0).attrs.blockId).toBe("a1"); // BEFORE keeps the source id
    expect(s1.doc.child(1).attrs.blockId).not.toBe("a1"); // AFTER gets a fresh id
    // distinct blockIds for the two halves
    expect(s1.doc.child(0).attrs.blockId).not.toBe(s1.doc.child(1).attrs.blockId);
    // caret sits at the start of the AFTER block's content
    expect(s1.selection.$from.parent.textContent).toBe("ument");
    expect(s1.selection.$from.parentOffset).toBe(0);
    expect(() => s1.doc.check()).not.toThrow();
  });

  it("after a split, Clear/clearFormatting on the new TOP analytic affects ONLY that block (separate blockIds)", () => {
    // Start with a single analytic; Enter at START makes an empty analytic on top and leaves the content below.
    const d = mkDoc(anal("argument", "a1"));
    const split = run(cursorAt(stateOf(d), startOf(d, "analytic")), enter).state;
    expect(split.doc.childCount).toBe(2);
    expect(split.doc.child(0).content.size).toBe(0); // the new empty top analytic
    expect(split.doc.child(1).textContent).toBe("argument"); // the content block below

    // An Enter-at-START split keeps the SOURCE id on the BEFORE (top, empty) block and mints a FRESH id for the
    // AFTER (below, "argument") block (the command's documented rule). So the top block keeps `a1`; the below
    // block carries the new id. The two ids are necessarily distinct — that is the "separate blockIds" this test
    // guards, and it is what lets a per-block reset hit exactly one line.
    expect(split.doc.child(0).attrs.blockId).toBe("a1"); // before-block kept the source id
    const belowId = split.doc.child(1).attrs.blockId; // after-block's fresh id ("argument" block)
    expect(belowId).not.toBe("a1"); // distinct ids — the split produced two independent blocks

    // Node-select the TOP analytic and clear it. Because the two halves are SEPARATE blocks (clearFormatting
    // can reset a node-selected block), the reset hits ONLY the top one; the analytic below (its
    // content + its own id) is untouched.
    const topSel = split.apply(split.tr.setSelection(NodeSelection.create(split.doc, 0)));
    const cleared = run(topSel, clearFormatting).state;
    // clearFormatting resets the touched (top) analytic → a plain paragraph, its blockId (a1) preserved.
    expect(cleared.doc.child(0).type.name).toBe("paragraph");
    expect(cleared.doc.child(0).attrs.blockId).toBe("a1");
    // the OTHER block is still the original analytic, content + its own (fresh) id intact — F12 did NOT hit it
    expect(cleared.doc.child(1).type.name).toBe("analytic");
    expect(cleared.doc.child(1).textContent).toBe("argument");
    expect(cleared.doc.child(1).attrs.blockId).toBe(belowId);
    expect(() => cleared.doc.check()).not.toThrow();
  });

  it("at the END of a card BODY paragraph SPLITS into a new body paragraph WITHIN the card (never escapes it)", () => {
    const d = mkDoc(aCard("Tag", "Cite", "Body text", "c1"));
    const s1 = run(cursorAt(stateOf(d), endOfBodyPara(d, 0)), enter).state;
    // still ONE top-level block — the card never spawned a sibling / escaped its isolating boundary
    expect(s1.doc.childCount).toBe(1);
    const card1 = s1.doc.child(0);
    expect(card1.type.name).toBe("card");
    // the body now holds TWO paragraphs (the split), structure otherwise intact
    const bodyNode = card1.child(2);
    expect(bodyNode.type.name).toBe("body");
    expect(bodyNode.childCount).toBe(2);
    expect(bodyNode.child(0).textContent).toBe("Body text"); // original text kept in the first paragraph
    expect(bodyNode.child(1).content.size).toBe(0); // new paragraph is empty
    // new body paragraph carries a FRESH id (not the source body paragraph's id)
    expect(bodyNode.child(1).attrs.blockId).not.toBe(bodyNode.child(0).attrs.blockId);
    expect(typeof bodyNode.child(1).attrs.blockId).toBe("string");
    // caret landed inside the new (empty) body paragraph — still depth 3 (inside the card body)
    expect(s1.selection.$from.parent.type.name).toBe("paragraph");
    expect(s1.selection.$from.parent.content.size).toBe(0);
    expect(s1.selection.$from.node(2).type.name).toBe("body");
    // the whole card still passes conformance
    expect(() => card1.check()).not.toThrow();
  });

  it("at the END of a card TAG inserts a hard_break (tag/cite never spawn a sibling block)", () => {
    const d = mkDoc(aCard("Tag", "Cite", "Body", "c1"));
    const s1 = run(cursorAt(stateOf(d), endOf(d, "tag")), enter).state;
    expect(s1.doc.childCount).toBe(1); // still one top-level block (the card)
    expect(countType(s1.doc.child(0), "hard_break")).toBe(1); // a break was added inside the tag
    expect(countType(s1.doc.child(0), "tag")).toBe(1); // structure intact
    expect(countType(s1.doc.child(0), "cite")).toBe(1);
    expect(countType(s1.doc.child(0), "body")).toBe(1);
  });

  it("MID-inline (caret in the middle of text) inserts a hard_break, not a new block", () => {
    const d = mkDoc(para("hello", "p1"));
    const s1 = run(cursorAt(stateOf(d), startOf(d, "paragraph") + 2), enter).state; // after "he"
    expect(s1.doc.childCount).toBe(1);
    expect(countType(s1.doc, "hard_break")).toBe(1);
    expect(s1.doc.child(0).textContent).toBe("hello"); // text preserved around the break
  });

  it("a NON-EMPTY selection within one textblock is replaced by a hard_break", () => {
    const d = mkDoc(para("hello", "p1"));
    const from = startOf(d, "paragraph") + 1; // after "h"
    const to = startOf(d, "paragraph") + 3; // after "hel" -> selects "el"
    const s1 = run(rangeAt(stateOf(d), from, to), enter).state;
    expect(s1.doc.childCount).toBe(1);
    expect(countType(s1.doc, "hard_break")).toBe(1);
    expect(s1.doc.child(0).textContent).toBe("hlo"); // "el" removed, break in its place
  });

  it("swallows (no-op) a selection spanning two card children — never collapses a required-child boundary", () => {
    const original = aCard("TagText", "CiteText", "BodyText", "c1");
    const d = mkDoc(original);
    const from = startOf(d, "tag") + 1; // inside tag
    const to = startOfBodyPara(d, 0) + 1; // inside the body paragraph — a cross-textblock selection
    const { ok, state: s1 } = run(rangeAt(stateOf(d), from, to), enter);
    expect(ok).toBe(true); // handled (swallowed)
    expect(s1.doc.eq(d)).toBe(true); // document unchanged — all three children survive
  });
});

// ── Backspace ────────────────────────────────────────────────────────────────────────────────────
describe("backspace", () => {
  it("deletes a hard_break before the caret (joins the two inline lines)", () => {
    const d = mkDoc(paragraph.create({ blockId: "p1" }, [txt("a"), hard_break.create(), txt("b")]));
    // caret right after the break (start of "b")
    const pos = startOf(d, "paragraph") + 2; // a(1) + break(1) => content offset 2
    const { ok, state: s1 } = run(cursorAt(stateOf(d), pos), backspace);
    expect(ok).toBe(true);
    expect(countType(s1.doc, "hard_break")).toBe(0);
    expect(s1.doc.child(0).textContent).toBe("ab");
  });

  it("is a NO-OP at the start of a card TAG (never merges / deletes a required child)", () => {
    const d = mkDoc(aCard("Tag", "Cite", "Body", "c1"));
    const { ok, state: s1 } = run(cursorAt(stateOf(d), startOf(d, "tag")), backspace);
    expect(ok).toBe(true); // swallowed
    expect(s1.doc.eq(d)).toBe(true); // card fully intact
  });

  it("is a NO-OP at the start of the FIRST card BODY paragraph (would otherwise merge body into cite)", () => {
    const d = mkDoc(aCard("Tag", "Cite", "Body", "c1"));
    const s1 = run(cursorAt(stateOf(d), startOfBodyPara(d, 0)), backspace).state;
    expect(s1.doc.eq(d)).toBe(true);
    expect(countType(s1.doc.child(0), "cite")).toBe(1);
    expect(countType(s1.doc.child(0), "body")).toBe(1);
  });

  it("is a NO-OP at the start of a non-first top-level block (never merges two isolating blocks)", () => {
    const d = mkDoc(para("first", "p1"), para("second", "p2"));
    const s1 = run(cursorAt(stateOf(d), startOf(d, "paragraph") /* start of first... */), backspace).state;
    expect(s1.doc.eq(d)).toBe(true);
    // and at the start of the SECOND block too
    const startSecond = (() => {
      let pos = -1;
      let seen = 0;
      d.descendants((node, p) => {
        if (node.type.name === "paragraph") {
          seen++;
          if (seen === 2 && pos === -1) pos = p + 1;
        }
        return pos === -1;
      });
      return pos;
    })();
    const s2 = run(cursorAt(stateOf(d), startSecond), backspace).state;
    expect(s2.doc.eq(d)).toBe(true);
    expect(s2.doc.childCount).toBe(2);
  });

  it("DELEGATES an ordinary character deletion to the browser (returns false)", () => {
    const d = mkDoc(para("hello", "p1"));
    const { ok, dispatches } = run(cursorAt(stateOf(d), startOf(d, "paragraph") + 3), backspace); // mid-text
    expect(ok).toBe(false);
    expect(dispatches).toBe(0);
  });

  it("deletes a NON-EMPTY selection within one textblock", () => {
    const d = mkDoc(para("hello", "p1"));
    const from = startOf(d, "paragraph") + 1;
    const to = startOf(d, "paragraph") + 3; // selects "el"
    const s1 = run(rangeAt(stateOf(d), from, to), backspace).state;
    expect(s1.doc.child(0).textContent).toBe("hlo");
  });

  it("swallows a selection spanning two card children (protects required children)", () => {
    const d = mkDoc(aCard("TagText", "CiteText", "BodyText", "c1"));
    const from = startOf(d, "tag") + 1;
    const to = startOfBodyPara(d, 0) + 1;
    const { ok, state: s1 } = run(rangeAt(stateOf(d), from, to), backspace);
    expect(ok).toBe(true);
    expect(s1.doc.eq(d)).toBe(true);
  });
});

// ── Whole-block selections (regression — found by adversarial review) ─────────────────────────────
// A NodeSelection on a top-level block, and a single-block AllSelection (Ctrl+A down to one block),
// both satisfy `$from.sameParent($to)` because their endpoints resolve with the DOC as parent. Backspace
// must NOT treat these as an inline delete — doing so would wipe a whole isolating block / a card's
// required tag·cite·body. Both Enter and Backspace must SWALLOW them (no structural destruction).
describe("Enter / Backspace on whole-block selections never destroy structure", () => {
  // Offset (position before) the first top-level block of `typeName`.
  function offsetOf(d: PMNode, typeName: string): number {
    let off = -1;
    d.forEach((n, o) => {
      if (off === -1 && n.type.name === typeName) off = o;
    });
    return off;
  }
  const nodeSel = (s: EditorState, typeName: string): EditorState =>
    s.apply(s.tr.setSelection(NodeSelection.create(s.doc, offsetOf(s.doc, typeName))));
  const allSel = (s: EditorState): EditorState => s.apply(s.tr.setSelection(new AllSelection(s.doc)));

  it("Backspace on a NODE-SELECTED card is a no-op (card + its required children survive)", () => {
    const d = mkDoc(aCard("Tag", "Cite", "Body", "c1"), para("after", "p1"));
    const { ok, state } = run(nodeSel(stateOf(d), "card"), backspace);
    expect(ok).toBe(true);
    expect(state.doc.eq(d)).toBe(true); // nothing deleted
  });

  it("Backspace on a single-block AllSelection (Ctrl+A) is a no-op (doc not emptied)", () => {
    const d = mkDoc(aCard("Tag", "Cite", "Body", "c1"));
    const { state } = run(allSel(stateOf(d)), backspace);
    expect(state.doc.eq(d)).toBe(true);
    expect(state.doc.childCount).toBe(1);
  });

  it("Backspace on a NODE-SELECTED paragraph is a no-op (isolating block not deleted)", () => {
    const d = mkDoc(para("first", "p1"), para("second", "p2"));
    const { state } = run(nodeSel(stateOf(d), "paragraph"), backspace);
    expect(state.doc.eq(d)).toBe(true);
    expect(state.doc.childCount).toBe(2);
  });

  it("Enter on a NODE-SELECTED card is a no-op (does not split/replace the card)", () => {
    const d = mkDoc(aCard("Tag", "Cite", "Body", "c1"));
    const { ok, state } = run(nodeSel(stateOf(d), "card"), enter);
    expect(ok).toBe(true);
    expect(state.doc.eq(d)).toBe(true);
  });

  it("Enter on an AllSelection is a no-op", () => {
    const d = mkDoc(aCard("Tag", "Cite", "Body", "c1"));
    const { state } = run(allSel(stateOf(d)), enter);
    expect(state.doc.eq(d)).toBe(true);
  });
});

// ── Inserts ──────────────────────────────────────────────────────────────────────────────────────
describe("insertCard", () => {
  it("builds card{tag,cite,body} with a fresh blockId in ONE transaction, caret in the tag", () => {
    const d = mkDoc(para("seed", "p1"));
    const { ok, state: s1, dispatches } = run(cursorAt(stateOf(d), startOf(d, "paragraph") + 1), insertCard);
    expect(ok).toBe(true);
    expect(dispatches).toBe(1); // exactly one tr — the card is never half-built
    const newCard = s1.doc.child(1);
    expect(newCard.type.name).toBe("card");
    expect(newCard.childCount).toBe(3);
    expect([newCard.child(0).type.name, newCard.child(1).type.name, newCard.child(2).type.name]).toEqual([
      "tag",
      "cite",
      "body",
    ]);
    expect(typeof newCard.attrs.blockId).toBe("string");
    expect(newCard.attrs.blockId).not.toBe("p1");
    expect(blockIds(s1).filter((id) => id === newCard.attrs.blockId)).toHaveLength(1); // unique id
    expect(s1.selection.$from.parent.type.name).toBe("tag"); // caret lands in the tag
  });

  // The migrated insertCard seeds the `paragraph+` body with EXACTLY ONE empty paragraph (real id),
  // so the freshly-inserted card is conformance-valid.
  it("seeds the body with exactly one empty, check()-valid paragraph", () => {
    const d = mkDoc(para("seed", "p1"));
    const s1 = run(cursorAt(stateOf(d), startOf(d, "paragraph") + 1), insertCard).state;
    const newCard = s1.doc.child(1);
    const bodyNode = newCard.child(2);
    expect(bodyNode.type.name).toBe("body");
    expect(bodyNode.childCount).toBe(1); // exactly one body paragraph
    expect(bodyNode.child(0).type.name).toBe("paragraph");
    expect(bodyNode.child(0).content.size).toBe(0); // empty
    expect(typeof bodyNode.child(0).attrs.blockId).toBe("string"); // a real id
    expect(bodyNode.child(0).attrs.blockId.length).toBeGreaterThan(0);
    expect(() => newCard.check()).not.toThrow(); // the whole card is conformance-valid
  });

  it("caret lands in the CITE for insertCardAtCite, body still one valid paragraph", () => {
    const d = mkDoc(para("seed", "p1"));
    const s1 = run(cursorAt(stateOf(d), startOf(d, "paragraph") + 1), insertCardAtCite).state;
    expect(s1.selection.$from.parent.type.name).toBe("cite");
    expect(() => s1.doc.child(1).check()).not.toThrow();
  });
});

describe("insertAnalytic / insertParagraph / insertHeading", () => {
  it("insertAnalytic adds a fresh empty analytic sibling, caret inside", () => {
    const d = mkDoc(para("seed", "p1"));
    const s1 = run(cursorAt(stateOf(d), startOf(d, "paragraph") + 1), insertAnalytic).state;
    expect(s1.doc.child(1).type.name).toBe("analytic");
    expect(s1.doc.child(1).attrs.blockId).not.toBe("p1");
    expect(s1.selection.$from.parent.type.name).toBe("analytic");
  });

  it("insertParagraph adds a fresh empty paragraph sibling", () => {
    const d = mkDoc(para("seed", "p1"));
    const s1 = run(cursorAt(stateOf(d), startOf(d, "paragraph") + 1), insertParagraph).state;
    expect(s1.doc.child(1).type.name).toBe("paragraph");
    expect(s1.doc.child(1).attrs.blockId).not.toBe("p1");
  });

  it("insertHeading(level) adds a heading carrying that level", () => {
    const d = mkDoc(para("seed", "p1"));
    const s1 = run(cursorAt(stateOf(d), startOf(d, "paragraph") + 1), insertHeading("pocket")).state;
    expect(s1.doc.child(1).type.name).toBe("heading");
    expect(s1.doc.child(1).attrs.level).toBe("pocket");
  });
});

// ── Backspace removes a blank line (wet-test finding) ────────────────────────────────────────────
// content-start position of the index-th top-level block.
function contentStartOfBlock(d: PMNode, index: number): number {
  let off = 0;
  for (let i = 0; i < index; i++) off += d.child(i).nodeSize;
  return off + 1;
}
describe("backspace removes a blank line", () => {
  it("at the start of an EMPTY paragraph removes it, landing the caret at the end of the previous block", () => {
    const d = mkDoc(para("first", "p1"), para("", "p2")); // p2 is the blank line
    const { ok, state } = run(cursorAt(stateOf(d), contentStartOfBlock(d, 1)), backspace);
    expect(ok).toBe(true);
    expect(state.doc.childCount).toBe(1);
    expect(state.doc.child(0).attrs.blockId).toBe("p1");
    expect(state.selection.$from.parent.type.name).toBe("paragraph");
    expect(state.selection.$from.parentOffset).toBe("first".length); // caret at end of "first"
  });

  it("at the start of an EMPTY heading removes it too", () => {
    const d = mkDoc(para("x", "p1"), head("", "block", "h2"));
    const state = run(cursorAt(stateOf(d), contentStartOfBlock(d, 1)), backspace).state;
    expect(state.doc.childCount).toBe(1);
    expect(state.doc.child(0).attrs.blockId).toBe("p1");
  });

  it("leaves an EMPTY FIRST block alone (nothing before to join to)", () => {
    const d = mkDoc(para("", "p1"), para("after", "p2"));
    const state = run(cursorAt(stateOf(d), contentStartOfBlock(d, 0)), backspace).state;
    expect(state.doc.eq(d)).toBe(true);
    expect(state.doc.childCount).toBe(2);
  });

  it("does NOT remove the only (empty) card BODY paragraph (a required child — not a top-level blank line)", () => {
    const d = mkDoc(aCard("Tag", "Cite", "", "c1")); // body = one empty paragraph
    const state = run(cursorAt(stateOf(d), startOfBodyPara(d, 0)), backspace).state;
    expect(state.doc.eq(d)).toBe(true);
    expect(countType(state.doc.child(0), "body")).toBe(1);
    expect(state.doc.child(0).child(2).childCount).toBe(1); // body still has its one paragraph
  });

  it("does NOT remove a NON-empty block on backspace-at-start (no content merge across the boundary)", () => {
    const d = mkDoc(para("first", "p1"), para("second", "p2"));
    const state = run(cursorAt(stateOf(d), contentStartOfBlock(d, 1)), backspace).state;
    expect(state.doc.eq(d)).toBe(true);
  });
});

// ── setHeadingLevel converts the current block (the pocket/hat/block buttons) ─────────────────────
describe("setHeadingLevel", () => {
  it("converts a paragraph to a heading at the given level, preserving blockId and content", () => {
    const d = mkDoc(para("Contention text", "p1"));
    const state = run(cursorAt(stateOf(d), startOf(d, "paragraph") + 1), setHeadingLevel("hat")).state;
    expect(state.doc.childCount).toBe(1);
    expect(state.doc.child(0).type.name).toBe("heading");
    expect(state.doc.child(0).attrs.level).toBe("hat");
    expect(state.doc.child(0).attrs.blockId).toBe("p1"); // same unit, restyled
    expect(state.doc.child(0).textContent).toBe("Contention text");
  });

  it("converts an analytic to a heading", () => {
    const d = mkDoc(anal("arg", "a1"));
    const state = run(cursorAt(stateOf(d), startOf(d, "analytic") + 1), setHeadingLevel("block")).state;
    expect(state.doc.child(0).type.name).toBe("heading");
    expect(state.doc.child(0).attrs.blockId).toBe("a1");
  });

  it("changes the level of an existing heading", () => {
    const d = mkDoc(head("Title", "block", "h1"));
    const state = run(cursorAt(stateOf(d), startOf(d, "heading") + 1), setHeadingLevel("pocket")).state;
    expect(state.doc.child(0).attrs.level).toBe("pocket");
    expect(state.doc.child(0).attrs.blockId).toBe("h1");
  });

  it("DISSOLVES a card when the caret is in its tag (folded into setHeadingLevel)", () => {
    const d = mkDoc(aCard("Tag", "Cite", "Body", "c1"));
    const { ok, state } = run(cursorAt(stateOf(d), startOf(d, "tag")), setHeadingLevel("hat"));
    expect(ok).toBe(true);
    // card gone; ejected as heading(tag) + paragraph(cite) + paragraph(body), in order
    expect(countType(state.doc, "card")).toBe(0);
    expect(state.doc.child(0).type.name).toBe("heading");
    expect(state.doc.child(0).attrs.level).toBe("hat");
    expect(state.doc.child(0).textContent).toBe("Tag");
    expect(state.doc.child(1).type.name).toBe("paragraph");
    expect(state.doc.child(1).textContent).toBe("Cite");
    expect(state.doc.child(2).type.name).toBe("paragraph");
    expect(state.doc.child(2).textContent).toBe("Body");
  });

  it("converts a NODE-SELECTED top-level block too (consistent with moveCurrentBlock)", () => {
    const d = mkDoc(para("Title text", "p1"));
    let s = stateOf(d);
    s = s.apply(s.tr.setSelection(NodeSelection.create(s.doc, 0))); // node-select the paragraph
    const { ok, state } = run(s, setHeadingLevel("pocket"));
    expect(ok).toBe(true);
    expect(state.doc.child(0).type.name).toBe("heading");
    expect(state.doc.child(0).attrs.level).toBe("pocket");
    expect(state.doc.child(0).attrs.blockId).toBe("p1");
  });
});

// ── paragraph+ body — multi-paragraph Enter split & Backspace join ────────────────────────────────
describe("card body paragraph+ Enter/Backspace", () => {
  it("Enter at the end of the FIRST of two body paragraphs inserts a new paragraph BETWEEN them (stays in body)", () => {
    const d = mkDoc(aCardMulti("Tag", "Cite", ["one", "two"], "c1"));
    const s1 = run(cursorAt(stateOf(d), endOfBodyPara(d, 0)), enter).state;
    expect(s1.doc.childCount).toBe(1); // never escaped the card
    const bodyNode = s1.doc.child(0).child(2);
    expect(bodyNode.childCount).toBe(3); // one | (new empty) | two
    expect(bodyNode.child(0).textContent).toBe("one");
    expect(bodyNode.child(1).content.size).toBe(0);
    expect(bodyNode.child(2).textContent).toBe("two");
    expect(() => s1.doc.child(0).check()).not.toThrow();
  });

  it("Backspace at the START of a NON-FIRST body paragraph JOINS it with the previous body paragraph", () => {
    const d = mkDoc(aCardMulti("Tag", "Cite", ["alpha", "beta"], "c1"));
    const s1 = run(cursorAt(stateOf(d), startOfBodyPara(d, 1)), backspace).state;
    expect(s1.doc.childCount).toBe(1);
    const bodyNode = s1.doc.child(0).child(2);
    expect(bodyNode.childCount).toBe(1); // the two paragraphs merged into one
    expect(bodyNode.child(0).textContent).toBe("alphabeta"); // content concatenated in order
    // caret sits at the seam (end of the original first paragraph's content)
    expect(s1.selection.$from.parent.type.name).toBe("paragraph");
    expect(s1.selection.$from.node(2).type.name).toBe("body");
    expect(s1.selection.$from.parentOffset).toBe("alpha".length);
    expect(() => s1.doc.child(0).check()).not.toThrow();
  });

  it("Backspace at the START of the FIRST body paragraph is a NO-OP (never merges into cite / destroys the card)", () => {
    const d = mkDoc(aCardMulti("Tag", "Cite", ["only", "second"], "c1"));
    const { ok, state } = run(cursorAt(stateOf(d), startOfBodyPara(d, 0)), backspace);
    expect(ok).toBe(true); // swallowed
    expect(state.doc.eq(d)).toBe(true); // nothing moved across the cite/body boundary
  });

  it("Backspace mid-text in a body paragraph DELEGATES to the browser (ordinary char, returns false)", () => {
    const d = mkDoc(aCardMulti("Tag", "Cite", ["hello"], "c1"));
    const { ok, dispatches } = run(cursorAt(stateOf(d), startOfBodyPara(d, 0) + 3), backspace);
    expect(ok).toBe(false);
    expect(dispatches).toBe(0);
  });
});

// ── convertToTag ───────────────────────────────────────────────────────────────────────────────────
describe("convertToTag", () => {
  it("converts a paragraph into a card (tag = its text), absorbing following paragraphs as body; check()-valid", () => {
    const d = mkDoc(para("Claim text", "p1"), para("evidence one", "p2"), para("evidence two", "p3"));
    const { ok, state, dispatches } = run(cursorAt(stateOf(d), startOf(d, "paragraph") + 1), convertToTag());
    expect(ok).toBe(true);
    expect(dispatches).toBe(1); // ONE transaction
    expect(state.doc.childCount).toBe(1); // the three blocks folded into one card
    const cardNode = state.doc.child(0);
    expect(cardNode.type.name).toBe("card");
    expect(cardNode.child(0).textContent).toBe("Claim text"); // tag = source block content
    expect(cardNode.child(1).content.size).toBe(0); // cite is empty
    const bodyNode = cardNode.child(2);
    expect(bodyNode.childCount).toBe(2);
    expect(bodyNode.child(0).textContent).toBe("evidence one");
    expect(bodyNode.child(1).textContent).toBe("evidence two");
    expect(() => cardNode.check()).not.toThrow();
    // caret at the end of the tag
    expect(state.selection.$from.parent.type.name).toBe("tag");
    expect(state.selection.$from.parentOffset).toBe("Claim text".length);
  });

  it("STOPS at the first EMPTY paragraph (excludes it and everything after)", () => {
    const d = mkDoc(para("Claim", "p1"), para("body a", "p2"), para("", "p3"), para("body c", "p4"));
    const { state } = run(cursorAt(stateOf(d), startOf(d, "paragraph") + 1), convertToTag());
    // card absorbs only p2; the empty p3 and p4 remain top-level
    expect(state.doc.childCount).toBe(3);
    expect(state.doc.child(0).type.name).toBe("card");
    expect(state.doc.child(0).child(2).childCount).toBe(1);
    expect(state.doc.child(0).child(2).child(0).textContent).toBe("body a");
    expect(state.doc.child(1).type.name).toBe("paragraph");
    expect(state.doc.child(1).content.size).toBe(0); // the stop paragraph, untouched
    expect(state.doc.child(2).textContent).toBe("body c");
    expect(() => state.doc.child(0).check()).not.toThrow();
  });

  it("STOPS at the first NON-paragraph block (a heading is not absorbed)", () => {
    const d = mkDoc(para("Claim", "p1"), para("body a", "p2"), head("Next section", "block", "h1"));
    const { state } = run(cursorAt(stateOf(d), startOf(d, "paragraph") + 1), convertToTag());
    expect(state.doc.childCount).toBe(2);
    expect(state.doc.child(0).type.name).toBe("card");
    expect(state.doc.child(0).child(2).childCount).toBe(1);
    expect(state.doc.child(0).child(2).child(0).textContent).toBe("body a");
    expect(state.doc.child(1).type.name).toBe("heading"); // heading survives untouched
    expect(() => state.doc.child(0).check()).not.toThrow();
  });

  it("with NOTHING to absorb, builds a card with one empty body paragraph (check()-valid)", () => {
    const d = mkDoc(para("Lonely claim", "p1"), head("a heading right after", "block", "h1"));
    const { state } = run(cursorAt(stateOf(d), startOf(d, "paragraph") + 1), convertToTag());
    expect(state.doc.childCount).toBe(2); // card + the heading (not absorbed)
    const cardNode = state.doc.child(0);
    expect(cardNode.type.name).toBe("card");
    expect(cardNode.child(0).textContent).toBe("Lonely claim");
    expect(cardNode.child(2).childCount).toBe(1); // exactly one body paragraph
    expect(cardNode.child(2).child(0).content.size).toBe(0); // and it's empty
    expect(() => cardNode.check()).not.toThrow();
  });

  it("converts a HEADING or ANALYTIC too (tag = its content), absorbing following paragraphs", () => {
    const d = mkDoc(head("Heading claim", "hat", "h1"), para("supporting", "p1"));
    const { state } = run(cursorAt(stateOf(d), startOf(d, "heading") + 1), convertToTag());
    expect(state.doc.child(0).type.name).toBe("card");
    expect(state.doc.child(0).child(0).textContent).toBe("Heading claim");
    expect(state.doc.child(0).child(2).child(0).textContent).toBe("supporting");
    expect(() => state.doc.child(0).check()).not.toThrow();
  });

  it("at the LAST block (doc end, nothing after) builds a card with one empty body paragraph", () => {
    const d = mkDoc(para("first", "p1"), para("Claim at end", "p2"));
    // caret in the SECOND paragraph (the last block) — nothing follows to absorb.
    const p2start = contentStartOfBlock(d, 1);
    const { state } = run(cursorAt(stateOf(d), p2start), convertToTag());
    expect(state.doc.childCount).toBe(2); // p1 stays, p2 becomes a card
    expect(state.doc.child(0).attrs.blockId).toBe("p1"); // first block untouched
    expect(state.doc.child(1).type.name).toBe("card");
    expect(state.doc.child(1).child(0).textContent).toBe("Claim at end");
    expect(state.doc.child(1).child(2).childCount).toBe(1); // one empty body paragraph
    expect(() => state.doc.child(1).check()).not.toThrow();
  });

  it("is a NO-OP (false) when the from-side block is a CARD (never re-wraps a structured card)", () => {
    const d = mkDoc(aCard("Tag", "Cite", "Body", "c1"));
    const { ok, state } = run(cursorAt(stateOf(d), startOf(d, "tag")), convertToTag());
    expect(ok).toBe(false);
    expect(state.doc.eq(d)).toBe(true);
  });

  it("is a NO-OP (false) with the caret inside a card BODY paragraph (a card child is never converted)", () => {
    const d = mkDoc(para("before", "p0"), aCard("Tag", "Cite", "Body", "c1"));
    const { ok, state } = run(cursorAt(stateOf(d), startOfBodyPara(d, 0)), convertToTag());
    expect(ok).toBe(false);
    expect(state.doc.eq(d)).toBe(true);
  });

  // Safety: whole-block selections must never be mis-read as an inline target.
  it("on an AllSelection returns false and destroys nothing", () => {
    const d = mkDoc(para("a", "p1"), para("b", "p2"));
    const { ok, state } = run(allSelOf(stateOf(d)), convertToTag());
    expect(ok).toBe(false);
    expect(state.doc.eq(d)).toBe(true);
  });

  it("on a NODE-SELECTED convertible block acts on that one block (unambiguous)", () => {
    const d = mkDoc(para("Claim", "p1"), para("ev", "p2"));
    const { ok, state } = run(nodeSelAt(stateOf(d), "paragraph"), convertToTag());
    expect(ok).toBe(true);
    expect(state.doc.child(0).type.name).toBe("card");
    expect(state.doc.child(0).child(0).textContent).toBe("Claim");
    expect(state.doc.child(0).child(2).child(0).textContent).toBe("ev"); // absorbed the following paragraph
    expect(() => state.doc.child(0).check()).not.toThrow();
  });

  it("on a NODE-SELECTED card returns false (never destroys the isolating card)", () => {
    const d = mkDoc(aCard("Tag", "Cite", "Body", "c1"));
    const { ok, state } = run(nodeSelAt(stateOf(d), "card"), convertToTag());
    expect(ok).toBe(false);
    expect(state.doc.eq(d)).toBe(true);
  });

  it("PRESERVES inline marks moving the source content into the tag and the body", () => {
    const hl = schema.marks.highlight;
    const claim = paragraph.create({ blockId: "p1" }, [
      schema.text("plain "),
      schema.text("hot", [hl.create({ color: "yellow" })]),
    ]);
    const ev = paragraph.create({ blockId: "p2" }, schema.text("read me", [schema.marks.underline.create()]));
    const d = mkDoc(claim, ev);
    const { state } = run(cursorAt(stateOf(d), startOf(d, "paragraph") + 1), convertToTag());
    const cardNode = state.doc.child(0);
    // tag kept the yellow highlight that was on "hot" (and the plain text is still plain)
    expect(cardNode.child(0).textContent).toBe("plain hot");
    let sawYellow = false;
    cardNode.child(0).descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type === hl && m.attrs.color === "yellow")) sawYellow = true;
    });
    expect(sawYellow).toBe(true);
    // body paragraph kept the underline
    let sawUnderline = false;
    cardNode.child(2).descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type === schema.marks.underline)) sawUnderline = true;
    });
    expect(sawUnderline).toBe(true);
    expect(() => cardNode.check()).not.toThrow();
  });
});

// ── dissolveCard (folded into setHeadingLevel) ───────────────────────────────────────────────────
describe("dissolveCard via setHeadingLevel", () => {
  it("ejects tag→heading, cite→paragraph, each body paragraph→paragraph IN ORDER, no orphan card, ONE tr", () => {
    const d = mkDoc(aCardMulti("Claim", "Author 2020", ["body one", "body two"], "c1"));
    const { ok, state, dispatches } = run(cursorAt(stateOf(d), startOf(d, "tag")), setHeadingLevel("block"));
    expect(ok).toBe(true);
    expect(dispatches).toBe(1);
    expect(countType(state.doc, "card")).toBe(0); // no orphan card
    expect(state.doc.childCount).toBe(4); // heading + cite-para + 2 body-paras
    expect(state.doc.child(0).type.name).toBe("heading");
    expect(state.doc.child(0).textContent).toBe("Claim");
    expect(state.doc.child(1).textContent).toBe("Author 2020");
    expect(state.doc.child(2).textContent).toBe("body one");
    expect(state.doc.child(3).textContent).toBe("body two");
    // every ejected block is a valid top-level block with a fresh string id
    for (let i = 0; i < state.doc.childCount; i++) {
      expect(typeof state.doc.child(i).attrs.blockId).toBe("string");
    }
    expect(() => state.doc.check()).not.toThrow();
  });

  it("OMITS the cite paragraph when the cite is empty", () => {
    const d = mkDoc(aCardMulti("Claim", "", ["body one"], "c1")); // empty cite
    const { state } = run(cursorAt(stateOf(d), startOf(d, "tag")), setHeadingLevel("hat"));
    expect(state.doc.childCount).toBe(2); // heading + 1 body-para, NO cite paragraph
    expect(state.doc.child(0).type.name).toBe("heading");
    expect(state.doc.child(0).textContent).toBe("Claim");
    expect(state.doc.child(1).textContent).toBe("body one");
  });

  it("dissolves a NODE-SELECTED card too", () => {
    const d = mkDoc(aCard("Claim", "Cite", "Body", "c1"));
    const { ok, state } = run(nodeSelAt(stateOf(d), "card"), setHeadingLevel("pocket"));
    expect(ok).toBe(true);
    expect(countType(state.doc, "card")).toBe(0);
    expect(state.doc.child(0).type.name).toBe("heading");
    expect(state.doc.child(0).attrs.level).toBe("pocket");
    // On the node-selected path the ejected body paragraph is RELOCATED, keeping its original blockId
    // (`c1b`) rather than getting a freshly minted one — the body paragraph carries identity through dissolve.
    const lastPara = state.doc.child(state.doc.childCount - 1);
    expect(lastPara.type.name).toBe("paragraph");
    expect(lastPara.textContent).toBe("Body");
    expect(lastPara.attrs.blockId).toBe("c1b");
    expect(() => state.doc.check()).not.toThrow();
  });

  it("dissolve fresh ids do not collide with any surviving block ids", () => {
    const d = mkDoc(aCard("Claim", "Cite", "Body", "c1"), para("after", "p1"));
    const { state } = run(cursorAt(stateOf(d), startOf(d, "tag")), setHeadingLevel("block"));
    const ids = blockIds(state);
    expect(new Set(ids).size).toBe(ids.length); // all unique
  });

  // A caret in the CITE promotes the CITE to the heading (not the tag). With an empty tag, the tag still
  // ejects as a (here empty) top-level paragraph FIRST, then the cite heading, then the body paragraph.
  it("a caret in the CITE makes the CITE the heading; an empty tag ejects as an empty paragraph before it", () => {
    const d = mkDoc(aCardMulti("", "Cite", ["body one"], "c1")); // empty tag
    const { ok, state } = run(cursorAt(stateOf(d), startOf(d, "cite")), setHeadingLevel("hat"));
    expect(ok).toBe(true);
    expect(countType(state.doc, "card")).toBe(0);
    expect(state.doc.childCount).toBe(3);
    expect(state.doc.child(0).type.name).toBe("paragraph"); // the (empty) tag ejected first
    expect(state.doc.child(0).content.size).toBe(0);
    expect(state.doc.child(1).type.name).toBe("heading"); // the cite became the heading
    expect(state.doc.child(1).attrs.level).toBe("hat");
    expect(state.doc.child(1).textContent).toBe("Cite");
    expect(state.doc.child(2).type.name).toBe("paragraph");
    expect(state.doc.child(2).textContent).toBe("body one"); // body ejected after, id kept
    expect(state.doc.child(2).attrs.blockId).toBe("c1b0");
    expect(() => state.doc.check()).not.toThrow();
  });
});

// ── a caret in a card BODY paragraph SPLITS the card instead of dissolving it ─────────────────────
describe("setHeadingLevel splits a card at a body paragraph", () => {
  // a caret at the start of the n-th body paragraph of the first card
  const caretInBody = (d: PMNode, n: number): EditorState => cursorAt(stateOf(d), startOfBodyPara(d, n));

  it("splits at body paragraph 1: front card keeps tag/cite + preceding para, that para → heading, trailing paras float", () => {
    const d = mkDoc(aCardMulti("Tag", "Cite", ["b0", "b1", "b2", "b3"], "c1"));
    const { ok, state, dispatches } = run(caretInBody(d, 1), setHeadingLevel("pocket"));
    expect(ok).toBe(true);
    expect(dispatches).toBe(1); // ONE transaction
    // front card (1) + heading (1) + trailing paragraphs b2,b3 (2) = 4 top-level blocks
    expect(state.doc.childCount).toBe(4);
    expect(countType(state.doc, "card")).toBe(1);

    const front = state.doc.child(0);
    expect(front.type.name).toBe("card");
    expect(front.attrs.blockId).toBe("c1"); // same card, kept its id
    expect(front.child(0).textContent).toBe("Tag");
    expect(front.child(1).textContent).toBe("Cite");
    expect(front.child(2).type.name).toBe("body");
    expect(front.child(2).childCount).toBe(1); // only the preceding body paragraph remains
    expect(front.child(2).child(0).textContent).toBe("b0");

    const headed = state.doc.child(1);
    expect(headed.type.name).toBe("heading");
    expect(headed.attrs.level).toBe("pocket");
    expect(headed.textContent).toBe("b1");
    expect(headed.attrs.blockId).toBe("c1b1"); // the targeted paragraph's id carried onto the heading

    expect(state.doc.child(2).type.name).toBe("paragraph");
    expect(state.doc.child(2).textContent).toBe("b2");
    expect(state.doc.child(2).attrs.blockId).toBe("c1b2");
    expect(state.doc.child(3).type.name).toBe("paragraph");
    expect(state.doc.child(3).textContent).toBe("b3");
    expect(state.doc.child(3).attrs.blockId).toBe("c1b3");

    expect(() => state.doc.check()).not.toThrow();
  });

  it("splits at the LAST body paragraph: nothing floats, front card keeps the rest", () => {
    const d = mkDoc(aCardMulti("Tag", "Cite", ["b0", "b1"], "c1"));
    const { state } = run(caretInBody(d, 1), setHeadingLevel("hat"));
    expect(state.doc.childCount).toBe(2); // front card + heading only
    expect(state.doc.child(0).type.name).toBe("card");
    expect(state.doc.child(0).child(2).childCount).toBe(1); // b0 stays in the front card
    expect(state.doc.child(1).type.name).toBe("heading");
    expect(state.doc.child(1).textContent).toBe("b1");
    expect(() => state.doc.check()).not.toThrow();
  });

  it("preserves every blockId (no duplicates) and respects the chosen level (F6 → block)", () => {
    const d = mkDoc(aCardMulti("Tag", "Cite", ["b0", "b1", "b2"], "c1"));
    const { state } = run(caretInBody(d, 1), setHeadingLevel("block"));
    expect(state.doc.child(1).attrs.level).toBe("block");
    const ids = blockIds(state); // top-level ids: c1 (front card), c1b1 (heading), c1b2 (trailing)
    expect(ids).toEqual(["c1", "c1b1", "c1b2"]);
    expect(new Set(ids).size).toBe(ids.length); // all unique
  });

  it("leaves blocks AFTER the card untouched", () => {
    const d = mkDoc(aCardMulti("Tag", "Cite", ["b0", "b1"], "c1"), para("after", "p9"));
    const { state } = run(caretInBody(d, 1), setHeadingLevel("pocket"));
    const last = state.doc.child(state.doc.childCount - 1);
    expect(last.type.name).toBe("paragraph");
    expect(last.textContent).toBe("after");
    expect(last.attrs.blockId).toBe("p9");
  });

  it("drops the caret in the new heading after the split", () => {
    const d = mkDoc(aCardMulti("Tag", "Cite", ["b0", "b1", "b2"], "c1"));
    const { state } = run(caretInBody(d, 1), setHeadingLevel("hat"));
    expect(state.selection.$from.parent.type.name).toBe("heading");
    expect(state.selection.$from.parent.textContent).toBe("b1");
  });

  // The FIRST body paragraph (index 0) now promotes BODY0 to the heading and ejects the tag + cite ABOVE
  // it (no front card survives) and any later body paragraphs below it — the SELECTED line becomes the heading.
  it("at the FIRST body paragraph (index 0) BODY0 becomes the heading; tag + cite eject above it, later bodies below", () => {
    const d = mkDoc(aCardMulti("Tag", "Cite", ["b0", "b1"], "c1"));
    const { state } = run(caretInBody(d, 0), setHeadingLevel("pocket"));
    expect(countType(state.doc, "card")).toBe(0);
    expect(state.doc.childCount).toBe(4); // tag-para, cite-para, heading(b0), para(b1)
    expect(state.doc.child(0).type.name).toBe("paragraph");
    expect(state.doc.child(0).textContent).toBe("Tag"); // tag ejected first
    expect(state.doc.child(1).type.name).toBe("paragraph");
    expect(state.doc.child(1).textContent).toBe("Cite"); // non-empty cite ejected second
    expect(state.doc.child(2).type.name).toBe("heading"); // BODY0 is the selected line → the heading
    expect(state.doc.child(2).attrs.level).toBe("pocket");
    expect(state.doc.child(2).textContent).toBe("b0");
    expect(state.doc.child(2).attrs.blockId).toBe("c1b0"); // body0 keeps its id onto the heading
    expect(state.doc.child(3).type.name).toBe("paragraph");
    expect(state.doc.child(3).textContent).toBe("b1"); // later body ejected after
    expect(state.doc.child(3).attrs.blockId).toBe("c1b1");
    // caret in the new heading
    expect(state.selection.$from.parent.type.name).toBe("heading");
    expect(state.selection.$from.parent.textContent).toBe("b0");
    const ids = blockIds(state);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
    expect(() => state.doc.check()).not.toThrow();
  });

  it("at body0 with an EMPTY cite, the empty cite is SKIPPED (never ejected as an empty paragraph)", () => {
    const d = mkDoc(aCardMulti("Tag", "", ["b0", "b1"], "c1")); // empty cite
    const { state } = run(caretInBody(d, 0), setHeadingLevel("hat"));
    expect(state.doc.childCount).toBe(3); // tag-para, heading(b0), para(b1) — NO empty cite paragraph
    expect(state.doc.child(0).textContent).toBe("Tag");
    expect(state.doc.child(1).type.name).toBe("heading");
    expect(state.doc.child(1).textContent).toBe("b0");
    expect(state.doc.child(2).textContent).toBe("b1");
    expect(() => state.doc.check()).not.toThrow();
  });

  it("a caret in the TAG still dissolves the whole card (split only triggers inside the body)", () => {
    const d = mkDoc(aCardMulti("Tag", "Cite", ["b0", "b1"], "c1"));
    const { state } = run(cursorAt(stateOf(d), startOf(d, "tag")), setHeadingLevel("block"));
    expect(countType(state.doc, "card")).toBe(0); // dissolved, NOT split
    expect(state.doc.child(0).textContent).toBe("Tag");
  });

  // ── coverage hardening (adversarial-review gaps; behaviors confirmed correct, now pinned) ──

  it("marks on the targeted AND trailing body paragraphs survive the split", () => {
    const hl = schema.marks.highlight.create({ color: "yellow" });
    const ul = schema.marks.underline.create();
    const cardNode = buildCard({
      blockId: "c1",
      tag: [txt("Tag")],
      cite: [txt("Cite")],
      body: [
        { blockId: "c1b0", content: [txt("plain b0")] },
        { blockId: "c1b1", content: [schema.text("hot", [hl])] }, // targeted → heading
        { blockId: "c1b2", content: [schema.text("under", [ul])] }, // trailing → floating paragraph
      ],
    });
    const { state } = run(cursorAt(stateOf(mkDoc(cardNode)), startOfBodyPara(mkDoc(cardNode), 1)), setHeadingLevel("hat"));
    const headed = state.doc.child(1);
    expect(headed.type.name).toBe("heading");
    let sawHl = false;
    headed.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type === schema.marks.highlight && m.attrs.color === "yellow")) sawHl = true;
    });
    expect(sawHl).toBe(true); // the highlight rode along onto the heading
    const trailing = state.doc.child(2);
    expect(trailing.type.name).toBe("paragraph");
    let sawUl = false;
    trailing.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type === schema.marks.underline)) sawUl = true;
    });
    expect(sawUl).toBe(true); // the underline rode along onto the floating paragraph
  });

  it("a NON-EMPTY selection inside one body paragraph splits the same way — the WHOLE paragraph becomes the heading (block-level key)", () => {
    const d = mkDoc(aCardMulti("Tag", "Cite", ["b0", "b1longer", "b2"], "c1"));
    const { start, end } = bodyParaPos(d, 1);
    const { ok, state } = run(rangeAt(stateOf(d), start + 1, end - 2), setHeadingLevel("pocket")); // sub-range of b1
    expect(ok).toBe(true);
    expect(state.doc.child(1).type.name).toBe("heading");
    expect(state.doc.child(1).textContent).toBe("b1longer"); // the ENTIRE paragraph, not just the selected text
    expect(() => state.doc.check()).not.toThrow();
  });

  // A single-body-paragraph card — the one body paragraph (index 0) is the selected line, so IT becomes
  // the heading; the tag + cite eject above it (the whole card is consumed, no front card survives).
  it("a single-body-paragraph card promotes that body paragraph to the heading, ejecting tag + cite above it", () => {
    const d = mkDoc(aCard("Tag", "Cite", "only", "c1")); // aCard builds a one-paragraph body (id c1b)
    const { state } = run(cursorAt(stateOf(d), startOfBodyPara(d, 0)), setHeadingLevel("block"));
    expect(countType(state.doc, "card")).toBe(0);
    expect(state.doc.childCount).toBe(3); // tag-para, cite-para, heading(only)
    expect(state.doc.child(0).type.name).toBe("paragraph");
    expect(state.doc.child(0).textContent).toBe("Tag");
    expect(state.doc.child(1).type.name).toBe("paragraph");
    expect(state.doc.child(1).textContent).toBe("Cite");
    expect(state.doc.child(2).type.name).toBe("heading"); // the body paragraph is the selected line
    expect(state.doc.child(2).textContent).toBe("only");
    expect(state.doc.child(2).attrs.blockId).toBe("c1b"); // body paragraph kept its id onto the heading
    expect(() => state.doc.check()).not.toThrow();
  });

  it("a selection spanning from a body paragraph into the NEXT top-level block leaves the card intact (range fallback)", () => {
    const d = mkDoc(aCardMulti("Tag", "Cite", ["b0", "b1"], "c1"), para("after", "p9"));
    const from = startOfBodyPara(d, 1);
    const to = d.child(0).nodeSize + 1; // content start of the trailing top-level paragraph "after"
    const { state } = run(rangeAt(stateOf(d), from, to), setHeadingLevel("pocket"));
    expect(countType(state.doc, "card")).toBe(1); // card NOT split or dissolved
    expect(state.doc.child(0).type.name).toBe("card");
    expect(state.doc.child(1).type.name).toBe("heading"); // only the following paragraph was restyled
    expect(state.doc.child(1).textContent).toBe("after");
    expect(() => state.doc.check()).not.toThrow();
  });

  it("no blockId is duplicated ANYWHERE after a split (descends into the front card's surviving body)", () => {
    const d = mkDoc(aCardMulti("Tag", "Cite", ["b0", "b1", "b2"], "c1"));
    const { state } = run(cursorAt(stateOf(d), startOfBodyPara(d, 1)), setHeadingLevel("hat"));
    const allIds: string[] = [];
    state.doc.descendants((n) => {
      if (typeof n.attrs.blockId === "string") allIds.push(n.attrs.blockId);
    });
    expect(new Set(allIds).size).toBe(allIds.length); // globally unique, including nested ids
    expect(allIds).toContain("c1b0"); // the preceding body paragraph kept its id inside the front card
    expect(allIds).toContain("c1"); // front card kept its id
    expect(allIds).toContain("c1b1"); // targeted paragraph's id carried onto the heading
  });
});

// ── the SELECTED line ALWAYS becomes the heading; everything below it ejects out of the card ──────────
// Exhaustive caret-position coverage for setHeadingLevel inside a card. The earlier "splits a card at a body
// paragraph" suite already pins body[k≥1] and body0; this suite pins the TAG and CITE lines (the old bug:
// caret in cite/tag/body0 always made the TAG the heading) plus the cross-cutting invariants.
describe("setHeadingLevel promotes the SELECTED card line to the heading", () => {
  // assert every blockId in the doc (including nested) is unique
  const assertUniqueIds = (state: EditorState): void => {
    const ids: string[] = [];
    state.doc.descendants((n) => {
      if (typeof n.attrs.blockId === "string") ids.push(n.attrs.blockId);
    });
    expect(new Set(ids).size).toBe(ids.length);
  };

  it("L = TAG: the tag becomes the heading, a non-empty cite + every body paragraph eject below it (ids kept)", () => {
    const d = mkDoc(aCardMulti("Tag", "Cite", ["b0", "b1"], "c1"));
    const { ok, state, dispatches } = run(cursorAt(stateOf(d), startOf(d, "tag")), setHeadingLevel("pocket"));
    expect(ok).toBe(true);
    expect(dispatches).toBe(1);
    expect(countType(state.doc, "card")).toBe(0);
    expect(state.doc.childCount).toBe(4); // heading(tag), para(cite), para(b0), para(b1)
    expect(state.doc.child(0).type.name).toBe("heading");
    expect(state.doc.child(0).attrs.level).toBe("pocket");
    expect(state.doc.child(0).textContent).toBe("Tag");
    expect(state.doc.child(1).textContent).toBe("Cite");
    expect(state.doc.child(2).textContent).toBe("b0");
    expect(state.doc.child(2).attrs.blockId).toBe("c1b0"); // body ids preserved on eject
    expect(state.doc.child(3).textContent).toBe("b1");
    expect(state.doc.child(3).attrs.blockId).toBe("c1b1");
    expect(state.selection.$from.parent.type.name).toBe("heading"); // caret in the new heading
    assertUniqueIds(state);
    expect(() => state.doc.check()).not.toThrow();
  });

  it("L = TAG with an EMPTY cite: the empty cite is SKIPPED (no empty paragraph emitted)", () => {
    const d = mkDoc(aCardMulti("Tag", "", ["b0"], "c1")); // empty cite
    const { state } = run(cursorAt(stateOf(d), startOf(d, "tag")), setHeadingLevel("block"));
    expect(state.doc.childCount).toBe(2); // heading(tag) + para(b0), NO cite paragraph
    expect(state.doc.child(0).type.name).toBe("heading");
    expect(state.doc.child(0).textContent).toBe("Tag");
    expect(state.doc.child(1).textContent).toBe("b0");
    expect(() => state.doc.check()).not.toThrow();
  });

  // An EMPTY tag is the selected line. The tag still becomes the heading (an empty heading is valid);
  // the non-empty cite + every body paragraph eject below it, the body KEEPING its id. F4 = setHeadingLevel("pocket").
  it("L = empty TAG (F4): child(0) is an empty heading, cite + body eject below, body keeps its id, check() passes", () => {
    const d = mkDoc(aCardMulti("", "Cite", ["b0", "b1"], "c1")); // empty tag, non-empty cite, two body paras
    const { ok, state, dispatches } = run(cursorAt(stateOf(d), startOf(d, "tag")), setHeadingLevel("pocket"));
    expect(ok).toBe(true);
    expect(dispatches).toBe(1);
    expect(countType(state.doc, "card")).toBe(0);
    expect(state.doc.childCount).toBe(4); // empty heading(tag), para(cite), para(b0), para(b1)
    expect(state.doc.child(0).type.name).toBe("heading"); // the empty tag became the heading
    expect(state.doc.child(0).attrs.level).toBe("pocket");
    expect(state.doc.child(0).content.size).toBe(0); // ...and it is empty
    expect(state.doc.child(1).type.name).toBe("paragraph"); // the non-empty cite ejected below
    expect(state.doc.child(1).textContent).toBe("Cite");
    expect(state.doc.child(2).textContent).toBe("b0");
    expect(state.doc.child(2).attrs.blockId).toBe("c1b0"); // body kept its id on eject
    expect(state.doc.child(3).textContent).toBe("b1");
    expect(state.doc.child(3).attrs.blockId).toBe("c1b1");
    assertUniqueIds(state);
    expect(() => state.doc.check()).not.toThrow();
  });

  it("L = CITE (non-empty), non-empty tag: tag ejects as a paragraph FIRST, cite becomes the heading, bodies follow", () => {
    const d = mkDoc(aCardMulti("Tag", "Author 2020", ["b0", "b1"], "c1"));
    const { ok, state, dispatches } = run(cursorAt(stateOf(d), startOf(d, "cite")), setHeadingLevel("hat"));
    expect(ok).toBe(true);
    expect(dispatches).toBe(1);
    expect(countType(state.doc, "card")).toBe(0);
    expect(state.doc.childCount).toBe(4); // para(tag), heading(cite), para(b0), para(b1)
    expect(state.doc.child(0).type.name).toBe("paragraph");
    expect(state.doc.child(0).textContent).toBe("Tag");
    expect(state.doc.child(1).type.name).toBe("heading"); // the cite is the selected line → the heading
    expect(state.doc.child(1).attrs.level).toBe("hat");
    expect(state.doc.child(1).textContent).toBe("Author 2020");
    expect(state.doc.child(2).textContent).toBe("b0");
    expect(state.doc.child(2).attrs.blockId).toBe("c1b0");
    expect(state.doc.child(3).textContent).toBe("b1");
    expect(state.doc.child(3).attrs.blockId).toBe("c1b1");
    expect(state.selection.$from.parent.type.name).toBe("heading");
    expect(state.selection.$from.parent.textContent).toBe("Author 2020");
    assertUniqueIds(state);
    expect(() => state.doc.check()).not.toThrow();
  });

  it("L = CITE (EMPTY): the empty cite still becomes the heading (an empty heading is fine)", () => {
    const d = mkDoc(aCardMulti("Tag", "", ["b0"], "c1")); // empty cite, but the cite IS the selected line
    const { state } = run(cursorAt(stateOf(d), startOf(d, "cite")), setHeadingLevel("block"));
    expect(countType(state.doc, "card")).toBe(0);
    expect(state.doc.childCount).toBe(3); // para(tag), heading(empty cite), para(b0)
    expect(state.doc.child(0).type.name).toBe("paragraph");
    expect(state.doc.child(0).textContent).toBe("Tag");
    expect(state.doc.child(1).type.name).toBe("heading");
    expect(state.doc.child(1).content.size).toBe(0); // empty heading from the empty cite
    expect(state.doc.child(2).textContent).toBe("b0");
    expect(state.selection.$from.parent.type.name).toBe("heading");
    expect(() => state.doc.check()).not.toThrow();
  });

  it("L = body[k≥1]: the FRONT-CARD split is unchanged (front card keeps tag/cite + preceding body)", () => {
    const d = mkDoc(aCardMulti("Tag", "Cite", ["b0", "b1", "b2"], "c1"));
    const { state } = run(cursorAt(stateOf(d), startOfBodyPara(d, 1)), setHeadingLevel("pocket"));
    expect(countType(state.doc, "card")).toBe(1); // front card survives (this is the k≥1 sub-case)
    expect(state.doc.child(0).type.name).toBe("card");
    expect(state.doc.child(0).attrs.blockId).toBe("c1");
    expect(state.doc.child(0).child(2).childCount).toBe(1); // only b0 stays in the front card
    expect(state.doc.child(1).type.name).toBe("heading");
    expect(state.doc.child(1).textContent).toBe("b1");
    expect(state.doc.child(2).textContent).toBe("b2");
    assertUniqueIds(state);
    expect(() => state.doc.check()).not.toThrow();
  });

  it("a NODE-SELECTED whole card STILL dissolves from the tag (the whole-card path is preserved)", () => {
    const d = mkDoc(aCardMulti("Tag", "Cite", ["b0", "b1"], "c1"));
    const { ok, state } = run(nodeSelAt(stateOf(d), "card"), setHeadingLevel("hat"));
    expect(ok).toBe(true);
    expect(countType(state.doc, "card")).toBe(0);
    expect(state.doc.child(0).type.name).toBe("heading"); // dissolves with the TAG as the heading
    expect(state.doc.child(0).textContent).toBe("Tag");
    expect(state.doc.child(1).textContent).toBe("Cite");
    expect(state.doc.child(2).textContent).toBe("b0");
    expect(state.doc.child(3).textContent).toBe("b1");
    assertUniqueIds(state);
    expect(() => state.doc.check()).not.toThrow();
  });

  it("blocks BEFORE and AFTER the card are untouched when a card line is promoted", () => {
    const d = mkDoc(para("before", "p0"), aCardMulti("Tag", "Cite", ["b0", "b1"], "c1"), para("after", "p9"));
    const { state } = run(cursorAt(stateOf(d), startOf(d, "cite")), setHeadingLevel("pocket"));
    expect(state.doc.child(0).type.name).toBe("paragraph");
    expect(state.doc.child(0).textContent).toBe("before");
    expect(state.doc.child(0).attrs.blockId).toBe("p0");
    const last = state.doc.child(state.doc.childCount - 1);
    expect(last.textContent).toBe("after");
    expect(last.attrs.blockId).toBe("p9");
    assertUniqueIds(state);
    expect(() => state.doc.check()).not.toThrow();
  });
});

// ── selection re-anchor after a selection-spanning restyle is silent (no PM dev-warning noise) ────
describe("setHeadingLevel selection re-anchor", () => {
  it("reanchors silently after restyling a NODE-SELECTED block (endpoints resolve at the doc level)", () => {
    // A NodeSelection's from/to are the positions BEFORE/AFTER the node — they resolve at the DOC level
    // (non-inline). A naive TextSelection.between would search outward and PM's dev build logs 'endpoint not
    // pointing into a node with inline content'. reanchorSelection must snap with .near instead — no warning,
    // and a valid final selection inside the restyled block.
    const d = mkDoc(para("intro", "p1"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { ok, state } = run(nodeSelAt(stateOf(d), "paragraph"), setHeadingLevel("hat"));
      expect(ok).toBe(true);
      expect(state.doc.child(0).type.name).toBe("heading"); // the node-selected paragraph was restyled
      expect(() => state.doc.check()).not.toThrow();
      const noisy = warnSpy.mock.calls.some((c) => /inline content/i.test(c.map(String).join(" ")));
      expect(noisy).toBe(false);
      // the final selection resolves into inline content (not the doc level)
      expect(state.selection.$from.parent.inlineContent).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ── convert → dissolve content round-trip ─────────────────────────────────────────────────────────
describe("convertToTag → dissolveCard content round-trip", () => {
  it("a claim + its evidence paragraphs survive convert-then-dissolve as text (cite empty => no extra block)", () => {
    // convertToTag makes cite EMPTY, so dissolve emits NO cite paragraph: the round-trip is
    // [claim, ev1, ev2] -> card -> [heading(claim), para(ev1), para(ev2)].
    const d = mkDoc(para("The claim", "p1"), para("Evidence A", "p2"), para("Evidence B", "p3"));
    const converted = run(cursorAt(stateOf(d), startOf(d, "paragraph") + 1), convertToTag()).state;
    expect(converted.doc.child(0).type.name).toBe("card");

    // now dissolve the resulting card (caret is already in its tag after convertToTag)
    const dissolved = run(converted, setHeadingLevel("block")).state;
    expect(countType(dissolved.doc, "card")).toBe(0);
    const texts = [];
    for (let i = 0; i < dissolved.doc.childCount; i++) texts.push(dissolved.doc.child(i).textContent);
    expect(texts).toEqual(["The claim", "Evidence A", "Evidence B"]); // content preserved in order
    expect(dissolved.doc.child(0).type.name).toBe("heading"); // claim came back as a heading
    expect(() => dissolved.doc.check()).not.toThrow();
  });
});

// ── convertToAnalytic (restyle to analytic, preserve blockId; card/card-child → false) ────────────
describe("convertToAnalytic", () => {
  it("restyles a PARAGRAPH → analytic, preserving the blockId and content", () => {
    const d = mkDoc(para("an argument", "p1"));
    const { ok, state, dispatches } = run(cursorAt(stateOf(d), startOf(d, "paragraph") + 1), convertToAnalytic());
    expect(ok).toBe(true);
    expect(dispatches).toBe(1);
    expect(state.doc.childCount).toBe(1);
    expect(state.doc.child(0).type.name).toBe("analytic");
    expect(state.doc.child(0).attrs.blockId).toBe("p1"); // same unit, restyled
    expect(state.doc.child(0).textContent).toBe("an argument");
  });

  it("restyles a HEADING → analytic, preserving the blockId", () => {
    const d = mkDoc(head("Was a heading", "hat", "h1"));
    const { state } = run(cursorAt(stateOf(d), startOf(d, "heading") + 1), convertToAnalytic());
    expect(state.doc.child(0).type.name).toBe("analytic");
    expect(state.doc.child(0).attrs.blockId).toBe("h1");
    expect(state.doc.child(0).textContent).toBe("Was a heading");
  });

  it("is idempotent on an existing analytic (analytic → analytic, id kept)", () => {
    const d = mkDoc(anal("already", "a1"));
    const { ok, state } = run(cursorAt(stateOf(d), startOf(d, "analytic") + 1), convertToAnalytic());
    expect(ok).toBe(true);
    expect(state.doc.child(0).type.name).toBe("analytic");
    expect(state.doc.child(0).attrs.blockId).toBe("a1");
  });

  it("is a NO-OP (false) on a CARD — never dissolves a card to an analytic", () => {
    const d = mkDoc(aCard("Tag", "Cite", "Body", "c1"));
    const { ok, state } = run(cursorAt(stateOf(d), startOf(d, "tag")), convertToAnalytic());
    expect(ok).toBe(false);
    expect(state.doc.eq(d)).toBe(true);
  });

  it("is a NO-OP (false) with the caret inside a card BODY paragraph (a card child is never converted)", () => {
    const d = mkDoc(aCard("Tag", "Cite", "Body", "c1"));
    const { ok, state } = run(cursorAt(stateOf(d), startOfBodyPara(d, 0)), convertToAnalytic());
    expect(ok).toBe(false);
    expect(state.doc.eq(d)).toBe(true);
  });

  it("converts a NODE-SELECTED top-level paragraph too", () => {
    const d = mkDoc(para("nodey", "p1"));
    const { ok, state } = run(nodeSelAt(stateOf(d), "paragraph"), convertToAnalytic());
    expect(ok).toBe(true);
    expect(state.doc.child(0).type.name).toBe("analytic");
    expect(state.doc.child(0).attrs.blockId).toBe("p1");
  });
});

// ── selection-spanning conversion (a selection converts every block it touches) ───────────────────
describe("setHeadingLevel / convertToAnalytic selection-spanning", () => {
  // A range from inside the FIRST block to inside the LAST, spanning all top-level blocks of `d`.
  const spanAll = (s: EditorState): EditorState => {
    const from = contentStartOfBlock(s.doc, 0);
    const lastIdx = s.doc.childCount - 1;
    const to = contentStartOfBlock(s.doc, lastIdx); // a position inside the last block's content
    return rangeAt(s, from, to);
  };

  it("setHeadingLevel converts EVERY paragraph a multi-block selection touches → headings (ids kept)", () => {
    const d = mkDoc(para("one", "p1"), para("two", "p2"), para("three", "p3"));
    const { ok, state, dispatches } = run(spanAll(stateOf(d)), setHeadingLevel("hat"));
    expect(ok).toBe(true);
    expect(dispatches).toBe(1); // ONE transaction for all three
    expect(state.doc.childCount).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(state.doc.child(i).type.name).toBe("heading");
      expect(state.doc.child(i).attrs.level).toBe("hat");
    }
    expect(blockIds(state)).toEqual(["p1", "p2", "p3"]); // every blockId preserved, in order
    expect([state.doc.child(0).textContent, state.doc.child(1).textContent, state.doc.child(2).textContent]).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(() => state.doc.check()).not.toThrow();
  });

  it("a CARD inside a multi-block selection is LEFT INTACT (skipped, NOT dissolved)", () => {
    const d = mkDoc(para("lead", "p1"), aCard("Tag", "Cite", "Body", "c1"), para("trail", "p2"));
    const { state } = run(spanAll(stateOf(d)), setHeadingLevel("block"));
    // the two paragraphs became headings; the card in the middle survives untouched
    expect(state.doc.child(0).type.name).toBe("heading");
    expect(state.doc.child(1).type.name).toBe("card"); // card NOT dissolved
    expect(countType(state.doc, "card")).toBe(1);
    expect(state.doc.child(1).child(0).textContent).toBe("Tag");
    expect(state.doc.child(2).type.name).toBe("heading");
    expect(blockIds(state)).toEqual(["p1", "c1", "p2"]);
    expect(() => state.doc.check()).not.toThrow();
  });

  it("convertToAnalytic spans too: every touched paragraph → analytic; a card in range stays intact", () => {
    const d = mkDoc(para("a", "p1"), aCard("T", "C", "B", "c1"), para("b", "p2"));
    const { state } = run(spanAll(stateOf(d)), convertToAnalytic());
    expect(state.doc.child(0).type.name).toBe("analytic");
    expect(state.doc.child(1).type.name).toBe("card");
    expect(state.doc.child(2).type.name).toBe("analytic");
    expect(blockIds(state)).toEqual(["p1", "c1", "p2"]);
    expect(() => state.doc.check()).not.toThrow();
  });

  it("a mixed span (paragraph + heading + analytic) all become the target heading level, ids kept", () => {
    const d = mkDoc(para("p", "p1"), head("h", "block", "h1"), anal("a", "a1"));
    const { state } = run(spanAll(stateOf(d)), setHeadingLevel("pocket"));
    for (let i = 0; i < 3; i++) {
      expect(state.doc.child(i).type.name).toBe("heading");
      expect(state.doc.child(i).attrs.level).toBe("pocket");
    }
    expect(blockIds(state)).toEqual(["p1", "h1", "a1"]);
  });

  it("a single-block selection still dissolves a card (the caret/single case is unchanged)", () => {
    const d = mkDoc(aCard("Claim", "Cite", "Body", "c1"));
    // a selection fully INSIDE the one card (tag content) is a single-block target → dissolve
    const from = startOf(d, "tag");
    const { state } = run(rangeAt(stateOf(d), from, from), setHeadingLevel("hat"));
    expect(countType(state.doc, "card")).toBe(0);
    expect(state.doc.child(0).type.name).toBe("heading");
  });
});

// ── a NodeSelection on a card CHILD must NOT dissolve the whole card ───────────────────────────────
describe("NodeSelection-on-card-child guard", () => {
  // Build a NodeSelection on the n-th body paragraph of the first card (a depth>0 node selection).
  const nodeSelBodyPara = (s: EditorState, n = 0): EditorState => {
    let bodyPos = -1;
    let bodyNode: PMNode | null = null;
    s.doc.descendants((node, p) => {
      if (bodyPos === -1 && node.type.name === "body") {
        bodyPos = p;
        bodyNode = node;
      }
      return bodyPos === -1;
    });
    if (bodyNode === null) throw new Error("no body");
    let off = bodyPos + 1; // inside body, before the first body paragraph's open token
    for (let i = 0; i < n; i++) off += (bodyNode as PMNode).child(i).nodeSize;
    return s.apply(s.tr.setSelection(NodeSelection.create(s.doc, off)));
  };

  it("setHeadingLevel on a node-selected body paragraph does NOT dissolve the card (no-op, false)", () => {
    const d = mkDoc(aCardMulti("Tag", "Cite", ["body one", "body two"], "c1"));
    const { ok, state } = run(nodeSelBodyPara(stateOf(d), 0), setHeadingLevel("hat"));
    expect(ok).toBe(false); // not handled — must fall through, never nuke the card
    expect(state.doc.eq(d)).toBe(true); // card + every required child intact
    expect(countType(state.doc, "card")).toBe(1);
  });

  it("convertToAnalytic on a node-selected body paragraph is also a no-op (card intact)", () => {
    const d = mkDoc(aCardMulti("Tag", "Cite", ["b1"], "c1"));
    const { ok, state } = run(nodeSelBodyPara(stateOf(d), 0), convertToAnalytic());
    expect(ok).toBe(false);
    expect(state.doc.eq(d)).toBe(true);
  });
});

// ── clearFormatting block-reset (heading/analytic → paragraph; card → marks only) ─────────────────
describe("clearFormatting block reset", () => {
  it("resets a HEADING → a plain paragraph (blockId preserved) AND strips its marks, in ONE transaction", () => {
    // a heading whose text carries highlight + underline marks
    const hl = schema.marks.highlight;
    const ul = schema.marks.underline;
    const h = heading.create({ blockId: "h1", level: "hat" }, [
      schema.text("Hot ", [hl.create({ color: "yellow" })]),
      schema.text("read", [ul.create()]),
    ]);
    const d = mkDoc(h);
    const from = startOf(d, "heading"); // content START of the heading
    const to = from + h.content.size; // ...to the END of its content (a valid in-block text range)
    const { ok, state, dispatches } = run(rangeAt(stateOf(d), from, to), clearFormatting);
    expect(ok).toBe(true);
    expect(dispatches).toBe(1); // marks + block reset in a single tr
    expect(state.doc.child(0).type.name).toBe("paragraph"); // heading → paragraph
    expect(state.doc.child(0).attrs.blockId).toBe("h1"); // blockId preserved
    expect(state.doc.child(0).textContent).toBe("Hot read"); // text untouched
    const f = startOf(state.doc, "paragraph"); // content start..end of the now-paragraph
    const t = f + state.doc.child(0).content.size;
    expect(state.doc.rangeHasMark(f, t, hl)).toBe(false); // marks stripped
    expect(state.doc.rangeHasMark(f, t, ul)).toBe(false);
    expect(() => state.doc.check()).not.toThrow();
  });

  it("resets an ANALYTIC → a plain paragraph (blockId preserved)", () => {
    const d = mkDoc(anal("argument", "a1"));
    const from = startOf(d, "analytic"); // content start..end
    const to = from + d.child(0).content.size;
    const { state } = run(rangeAt(stateOf(d), from, to), clearFormatting);
    expect(state.doc.child(0).type.name).toBe("paragraph");
    expect(state.doc.child(0).attrs.blockId).toBe("a1");
    expect(state.doc.child(0).textContent).toBe("argument");
  });

  // touchedTopLevelRange now handles a top-level NodeSelection (its $from resolves at depth 0), so a
  // node-selected heading/analytic can be reset → paragraph. Previously this returned null and clearFormatting
  // could not reset a node-selected block.
  it("resets a NODE-SELECTED analytic → a plain paragraph (blockId preserved)", () => {
    const d = mkDoc(anal("argument", "a1"));
    const { ok, state } = run(nodeSelAt(stateOf(d), "analytic"), clearFormatting);
    expect(ok).toBe(true);
    expect(state.doc.child(0).type.name).toBe("paragraph"); // node-selected analytic was reset
    expect(state.doc.child(0).attrs.blockId).toBe("a1");
    expect(state.doc.child(0).textContent).toBe("argument");
    expect(() => state.doc.check()).not.toThrow();
  });

  it("on a CARD clears marks only — the card and its required children are NOT destroyed", () => {
    const hl = schema.marks.highlight;
    // a card whose body paragraph text is highlighted
    const card = buildCard({
      blockId: "c1",
      tag: [txt("Tag")],
      cite: [txt("Cite")],
      body: [{ blockId: "c1b", content: [schema.text("hot body", [hl.create({ color: "green" })])] }],
    });
    const d = mkDoc(card);
    // select across the whole card (node-select it) so clearFormatting's mark sweep covers the body
    const { ok, state } = run(nodeSelAt(stateOf(d), "card"), clearFormatting);
    expect(ok).toBe(true);
    expect(countType(state.doc, "card")).toBe(1); // card intact
    expect(state.doc.child(0).type.name).toBe("card"); // NOT reset to a paragraph
    expect(countType(state.doc.child(0), "tag")).toBe(1);
    expect(countType(state.doc.child(0), "cite")).toBe(1);
    expect(countType(state.doc.child(0), "body")).toBe(1);
    // the highlight inside the body is gone
    let sawHighlight = false;
    state.doc.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type === hl)) sawHighlight = true;
    });
    expect(sawHighlight).toBe(false);
    expect(() => state.doc.check()).not.toThrow();
  });

  it("resets EVERY heading/analytic a multi-block selection touches → paragraphs, ids kept", () => {
    const d = mkDoc(head("h", "block", "h1"), anal("a", "a1"), para("p", "p1"));
    const from = contentStartOfBlock(d, 0);
    const to = contentStartOfBlock(d, 2);
    const { state } = run(rangeAt(stateOf(d), from, to), clearFormatting);
    for (let i = 0; i < 3; i++) expect(state.doc.child(i).type.name).toBe("paragraph");
    expect(blockIds(state)).toEqual(["h1", "a1", "p1"]); // ids preserved (paragraph p1 was already plain)
    expect(() => state.doc.check()).not.toThrow();
  });

  it("returns false on a bare cursor in a plain unmarked paragraph (F12 falls through)", () => {
    const d = mkDoc(para("plain", "p1"));
    const { ok, dispatches } = run(cursorAt(stateOf(d), startOf(d, "paragraph") + 1), clearFormatting);
    expect(ok).toBe(false);
    expect(dispatches).toBe(0);
  });
});
