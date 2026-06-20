// paste-guard.test.ts — the paste sanitiser.
//
// Proves the guard rebuilds a pasted Slice to text + supported marks with NO block structure, context-aware
// (card body → paragraphs; tag/cite/top-level → inline + hard_break), defeats the self-card-reimport +
// duplicate-blockId attack, and never produces a doc that fails check() — for paste-into-tag / -body / -top-level.

import { describe, it, expect } from "vitest";
import { EditorState, TextSelection, NodeSelection } from "prosemirror-state";
import { Slice, Fragment } from "prosemirror-model";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { schema, buildCard } from "../src/schema";
import { pasteGuardPlugin } from "../src/paste-guard";

const id = (): string => crypto.randomUUID();
// The plugin's transformPasted prop, called directly (it only reads view.state.selection.$from + the slice; it
// ignores `this`, so we cast away the prop's `this: Plugin` binding to call it as a plain function in the test).
const transformPasted = pasteGuardPlugin().props.transformPasted! as (slice: Slice, view: EditorView, plain: boolean) => Slice;

/** First text position whose node text includes `t` (a caret target). */
function posOfText(doc: PMNode, t: string): number {
  let pos = 1;
  doc.descendants((node, p) => {
    if (node.isText && node.text?.includes(t)) {
      pos = p + 1;
      return false;
    }
    return true;
  });
  return pos;
}

/** Run the guard for a caret at `pos`, returning the transformed slice + the doc after applying it. */
function paste(doc: PMNode, pos: number, input: Slice): { out: Slice; result: PMNode } {
  const base = EditorState.create({ schema, doc });
  const state = base.apply(base.tr.setSelection(TextSelection.create(doc, pos)));
  const view = { state } as unknown as EditorView;
  const out = transformPasted(input, view, false);
  const result = state.apply(state.tr.replaceSelection(out)).doc;
  return { out, result };
}

/** Set of node type names anywhere in a fragment. */
function typeNames(frag: Fragment): Set<string> {
  const names = new Set<string>();
  frag.descendants((n) => {
    names.add(n.type.name);
  });
  return names;
}

// Input slices (what PM hands transformPasted after parsing pasted HTML).
const twoParagraphs = (): Slice =>
  new Slice(
    Fragment.fromArray([
      schema.nodes.paragraph.create({ blockId: id() }, schema.text("First")),
      schema.nodes.paragraph.create({ blockId: id() }, schema.text("Second")),
    ]),
    1,
    1,
  );
const cardMarkup = (): Slice =>
  new Slice(
    Fragment.from(
      buildCard({
        blockId: id(),
        tag: [schema.text("TAGX")],
        cite: [schema.text("CITEX")],
        body: [{ blockId: id(), content: [schema.text("BODYX")] }],
      }),
    ),
    0,
    0,
  );

// Target docs.
const topLevelDoc = (): PMNode => schema.nodes.doc.create(null, [schema.nodes.paragraph.create({ blockId: id() }, schema.text("hello"))]);
const cardDoc = (): PMNode =>
  schema.nodes.doc.create(null, [
    buildCard({ blockId: id(), tag: [schema.text("TAGTEXT")], cite: [schema.text("CITETEXT")], body: [{ blockId: id(), content: [schema.text("BODYTEXT")] }] }),
  ]);

describe("paste guard drops all block structure", () => {
  it("pasting a CARD never injects card/tag/cite/body — flattened to text", () => {
    const doc = topLevelDoc();
    const { out, result } = paste(doc, posOfText(doc, "hello"), cardMarkup());
    const names = typeNames(out.content);
    for (const banned of ["card", "tag", "cite", "body", "heading", "analytic"]) expect(names.has(banned)).toBe(false);
    expect(out.content.textBetween(0, out.content.size, " ")).toContain("TAGX"); // text survives
    expect(() => result.check()).not.toThrow();
    expect(result.childCount).toBe(1); // no extra top-level block injected
  });

  it("pasting multi-paragraph at TOP LEVEL → inline + hard_break, no new top-level block", () => {
    const doc = topLevelDoc();
    const { out, result } = paste(doc, posOfText(doc, "hello"), twoParagraphs());
    out.content.forEach((n) => expect(n.isInline).toBe(true)); // only inline nodes
    expect(typeNames(out.content).has("hard_break")).toBe(true); // lines joined by a soft break
    expect(out.content.textBetween(0, out.content.size)).toBe("FirstSecond");
    expect(result.childCount).toBe(1); // pasted inline into the existing paragraph; no block added
    expect(() => result.check()).not.toThrow();
  });

  it("pasting multi-paragraph into a CARD BODY → multiple body paragraphs (evidence preserved)", () => {
    const doc = cardDoc();
    const { out, result } = paste(doc, posOfText(doc, "BODYTEXT"), twoParagraphs());
    expect(out.content.childCount).toBe(2);
    out.content.forEach((n) => {
      expect(n.type).toBe(schema.nodes.paragraph);
      expect(typeof n.attrs.blockId).toBe("string"); // fresh, non-null blockId
    });
    expect(() => result.check()).not.toThrow();
    expect(result.firstChild?.type).toBe(schema.nodes.card); // still one card, just a longer body
    expect(result.childCount).toBe(1);
  });

  it("pasting paragraphs into a card TAG (inline-only) does NOT shatter the card", () => {
    const doc = cardDoc();
    const { out, result } = paste(doc, posOfText(doc, "TAGTEXT"), twoParagraphs());
    out.content.forEach((n) => expect(n.isInline).toBe(true)); // inline only → tag stays intact
    expect(result.childCount).toBe(1); // the card was NOT split into multiple top-level blocks
    expect(result.firstChild?.type).toBe(schema.nodes.card);
    expect(result.firstChild?.childCount).toBe(2); // tag + body both still present (cite NODE removed in v5)
    expect(() => result.check()).not.toThrow();
  });

  it("keeps supported marks, drops nothing structural; result always check()-valid", () => {
    const marked = new Slice(
      Fragment.from(
        schema.nodes.paragraph.create({ blockId: id() }, [
          schema.text("plain "),
          schema.text("bold", [schema.marks.strong.create()]),
          schema.text(" "),
          schema.text("hi", [schema.marks.highlight.create({ color: "yellow" })]),
        ]),
      ),
      1,
      1,
    );
    const doc = topLevelDoc();
    const { out, result } = paste(doc, posOfText(doc, "hello"), marked);
    // marks survive on the flattened inline content
    let sawStrong = false;
    let sawHighlight = false;
    out.content.descendants((n) => {
      if (n.marks.some((mk) => mk.type.name === "strong")) sawStrong = true;
      if (n.marks.some((mk) => mk.type.name === "highlight")) sawHighlight = true;
    });
    expect(sawStrong).toBe(true);
    expect(sawHighlight).toBe(true);
    expect(() => result.check()).not.toThrow();
  });

  it("pasting over a top-level NodeSelection yields a check()-valid doc with NO null blockId", () => {
    // Ctrl/Cmd-click / triple-click / drag can node-select a whole top-level card (a depth-0 NodeSelection).
    // A naive inline paste here would replace the card with an auto-generated null-blockId paragraph → corrupt.
    const doc = cardDoc();
    const base = EditorState.create({ schema, doc });
    const state = base.apply(base.tr.setSelection(NodeSelection.create(doc, 0)));
    const view = { state } as unknown as EditorView;
    const out = transformPasted(twoParagraphs(), view, false);
    const result = state.apply(state.tr.replaceSelection(out)).doc;
    expect(() => result.check()).not.toThrow();
    let nullId = false;
    result.descendants((n) => {
      if (Object.prototype.hasOwnProperty.call(n.attrs, "blockId") && n.attrs.blockId === null) nullId = true;
    });
    expect(nullId).toBe(false);
  });

  it("an empty / non-text-only paste yields an empty slice (nothing inserted)", () => {
    const doc = topLevelDoc();
    const { out, result } = paste(doc, posOfText(doc, "hello"), Slice.empty);
    expect(out.content.size).toBe(0);
    expect(result.textContent).toContain("hello"); // unchanged
  });
});
