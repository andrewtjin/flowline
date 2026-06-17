// outline.test.ts — unit tests for the pure outline/derivation module.
//
// Covers buildOutline (tiers, document order, card-tag label, analytic label/truncation, a live multi-block
// doc, an empty doc), resolveBlockPos (present / missing→null / duplicate-id→first-match / empty-doc→null), and
// the isReusable truth table (TRUE only for a fresh newDoc()-shaped doc; FALSE for dirty/path/multi-block/
// seed — each its own assertion). Docs are assembled directly from src/schema.ts so the tests pin the real
// node shapes, not hand-wired JSON.

import { describe, it, expect } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { schema, buildCard } from "../src/schema";
import { createSeedDoc } from "../src/seed";
import { buildOutline, resolveBlockPos, isReusable } from "../src/renderer/outline";

const { doc, paragraph, analytic, heading } = schema.nodes;

// ── Builders (mirror real node shapes) ─────────────────────────────────────────────────────────
const head = (text: string, level: string, id: string): PMNode =>
  heading.create({ blockId: id, level }, text.length > 0 ? schema.text(text) : undefined);
const para = (text: string, id: string): PMNode =>
  paragraph.create({ blockId: id }, text.length > 0 ? schema.text(text) : undefined);
const anal = (text: string, id: string): PMNode =>
  analytic.create({ blockId: id }, text.length > 0 ? schema.text(text) : undefined);
const card = (tagText: string, id: string): PMNode =>
  buildCard({
    blockId: id,
    tag: [schema.text(tagText)],
    cite: [schema.text("Author 26")],
    body: [{ blockId: `${id}-b`, content: [schema.text("body prose")] }],
  });

// newDoc()'s exact output (one empty paragraph) — the reuse-empty baseline.
const freshDoc = (): PMNode => doc.create(null, [paragraph.create({ blockId: "fresh-1" })]);

describe("buildOutline — tiers", () => {
  it("maps heading levels to tiers pocket=0, hat=1, block=2 and card/analytic to tier 3", () => {
    const d = doc.create(null, [
      head("Pocket", "pocket", "h-pocket"),
      head("Hat", "hat", "h-hat"),
      head("Block", "block", "h-block"),
      card("A card claim", "c-1"),
      anal("Some analytic prose", "a-1"),
    ]);
    const outline = buildOutline(d);
    expect(outline).toEqual([
      { blockId: "h-pocket", label: "Pocket", tier: 0 },
      { blockId: "h-hat", label: "Hat", tier: 1 },
      { blockId: "h-block", label: "Block", tier: 2 },
      { blockId: "c-1", label: "A card claim", tier: 3 },
      { blockId: "a-1", label: "Some analytic prose", tier: 3 },
    ]);
  });
});

describe("buildOutline — document order", () => {
  it("emits entries in top-level document order", () => {
    const d = doc.create(null, [
      head("First", "hat", "id-1"),
      anal("Second", "id-2"),
      head("Third", "block", "id-3"),
    ]);
    expect(buildOutline(d).map((e) => e.blockId)).toEqual(["id-1", "id-2", "id-3"]);
  });
});

describe("buildOutline — labels", () => {
  it("uses the card TAG text as the card label (not cite/body)", () => {
    const d = doc.create(null, [card("Emissions accelerating", "c-1")]);
    const outline = buildOutline(d);
    expect(outline).toHaveLength(1);
    expect(outline[0]).toEqual({ blockId: "c-1", label: "Emissions accelerating", tier: 3 });
  });

  it("truncates an analytic label to ~60 chars", () => {
    const longText = "x".repeat(120);
    const d = doc.create(null, [anal(longText, "a-1")]);
    const label = buildOutline(d)[0].label;
    expect(label).toHaveLength(60);
    expect(label).toBe("x".repeat(60));
  });

  it("keeps a short analytic label intact", () => {
    const d = doc.create(null, [anal("short prose", "a-1")]);
    expect(buildOutline(d)[0].label).toBe("short prose");
  });
});

describe("buildOutline — loose paragraphs and empties", () => {
  it("emits NO entry for a loose paragraph", () => {
    const d = doc.create(null, [
      head("Heading", "hat", "h-1"),
      para("loose continuation prose", "p-1"),
    ]);
    expect(buildOutline(d).map((e) => e.blockId)).toEqual(["h-1"]);
  });

  it("returns an empty outline for an empty (fresh) doc", () => {
    expect(buildOutline(freshDoc())).toEqual([]);
  });
});

describe("buildOutline — live multi-block doc (the seed)", () => {
  it("derives only heading/card/analytic entries from the seed, in order", () => {
    const outline = buildOutline(createSeedDoc());
    // Seed top-level blocks: hat heading, block heading, card, loose paragraph, analytic, loose paragraph.
    // Loose paragraphs drop out → 4 entries: two headings, one card, one analytic.
    expect(outline.map((e) => e.tier)).toEqual([1, 2, 3, 3]);
    expect(outline[0].label).toBe("How To Read This Editor");
    expect(outline[1].label).toBe("Marks, blocks, and the keys");
    // Card label = its tag text.
    expect(outline[2].label).toContain("Every read mark has a key");
    // Analytic label = first ~60 chars of its prose.
    expect(outline[3].label.startsWith("Analytic blocks are")).toBe(true);
  });
});

describe("resolveBlockPos", () => {
  it("returns the position before a present top-level block", () => {
    const d = doc.create(null, [head("A", "hat", "id-a"), anal("B", "id-b")]);
    // First block starts at pos 0; the second starts after the first block's nodeSize.
    expect(resolveBlockPos(d, "id-a")).toBe(0);
    expect(resolveBlockPos(d, "id-b")).toBe(d.child(0).nodeSize);
  });

  it("returns null for a missing id", () => {
    const d = doc.create(null, [head("A", "hat", "id-a")]);
    expect(resolveBlockPos(d, "nope")).toBeNull();
  });

  it("returns the FIRST match when a duplicate id appears (duplicate-id tolerance)", () => {
    const d = doc.create(null, [
      head("first", "hat", "dup"),
      anal("middle", "uniq"),
      head("second", "block", "dup"),
    ]);
    // First "dup" is the first child → pos 0, NOT the later occurrence.
    expect(resolveBlockPos(d, "dup")).toBe(0);
  });

  it("returns null on an empty/fresh doc when the id is absent", () => {
    expect(resolveBlockPos(freshDoc(), "missing")).toBeNull();
  });

  it("never matches a card-body paragraph id (only top-level blocks)", () => {
    const d = doc.create(null, [card("claim", "c-1")]);
    // The card's body paragraph carries blockId "c-1-b" but is NOT a top-level block.
    expect(resolveBlockPos(d, "c-1-b")).toBeNull();
    expect(resolveBlockPos(d, "c-1")).toBe(0);
  });
});

describe("isReusable — truth table", () => {
  it("is TRUE only for a fresh newDoc()-shaped doc (not dirty, no path)", () => {
    expect(isReusable(freshDoc(), false, null)).toBe(true);
  });

  it("is FALSE when dirty (even if empty)", () => {
    expect(isReusable(freshDoc(), true, null)).toBe(false);
  });

  it("is FALSE when a path is set (even if empty)", () => {
    expect(isReusable(freshDoc(), false, "/tmp/file.flow")).toBe(false);
  });

  it("is FALSE for a multi-block doc", () => {
    const d = doc.create(null, [para("hello", "p-1"), para("world", "p-2")]);
    expect(isReusable(d, false, null)).toBe(false);
  });

  it("is FALSE for a single paragraph that holds typed text", () => {
    const d = doc.create(null, [para("typed", "p-1")]);
    expect(isReusable(d, false, null)).toBe(false);
  });

  it("is FALSE for a single non-paragraph block (a heading)", () => {
    const d = doc.create(null, [head("title", "hat", "h-1")]);
    expect(isReusable(d, false, null)).toBe(false);
  });

  it("is FALSE for the seed doc", () => {
    expect(isReusable(createSeedDoc(), false, null)).toBe(false);
  });
});
