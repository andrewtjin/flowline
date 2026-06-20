// docx-ir.test.ts — the pure doc→Word IR mapping (marks→run props, blocks→paragraphs).
// Asserts on the dependency-free IR (no packing), covering every mark, mark COMBINATIONS (incl. the
// excludes-tolerant emphasis+muted post-merge state), hard_break, empty blocks, colours, and block styling.

import { describe, it, expect } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { schema, buildCard } from "../src/schema";
import { docToDocxIR, type DocxIR } from "../src/persistence/docx-ir";

const id = (): string => crypto.randomUUID();
const m = schema.marks;
const irOf = (doc: PMNode): DocxIR => docToDocxIR(doc.toJSON());
/** IR of a single top-level paragraph holding the given inline nodes. */
const paraIR = (inline: PMNode[]): DocxIR => irOf(schema.nodes.doc.create(null, [schema.nodes.paragraph.create({ blockId: id() }, inline)]));

describe("docx-ir marks → run props", () => {
  it("strong → bold only", () => {
    const r = paraIR([schema.text("b", [m.strong.create()])]).paragraphs[0].runs[0];
    expect(r.bold).toBe(true);
    expect(r.underline).toBeUndefined();
    expect(r.box).toBeUndefined();
  });

  it("underline → single underline only", () => {
    const r = paraIR([schema.text("u", [m.underline.create()])]).paragraphs[0].runs[0];
    expect(r.underline).toBe("single");
    expect(r.bold).toBeUndefined();
  });

  it("muted → small absolute size", () => {
    const r = paraIR([schema.text("q", [m.muted.create()])]).paragraphs[0].runs[0];
    expect(r.sizeHalfPoints).toBe(16);
  });

  it("cite (v5 inline source mark) → bold + 13pt absolute size", () => {
    // The cite mark renders the source label as a bold, full-size (13pt = 26 half-points) run.
    const r = paraIR([schema.text("Author 24", [m.cite.create()])]).paragraphs[0].runs[0];
    expect(r.bold).toBe(true);
    expect(r.sizeHalfPoints).toBe(26);
  });

  it("muted + cite on one run → muted's small size (16) wins over cite's 26", () => {
    // A run carrying both marks: muted's explicit small size must override cite's source size.
    const r = paraIR([schema.text("x", [m.muted.create(), m.cite.create()])]).paragraphs[0].runs[0];
    expect(r.bold).toBe(true); // cite still bolds
    expect(r.sizeHalfPoints).toBe(16); // muted size wins
  });

  it("emphasis → bold + single underline + a RUN border box", () => {
    const r = paraIR([schema.text("e", [m.emphasis.create()])]).paragraphs[0].runs[0];
    expect(r.bold).toBe(true);
    expect(r.underline).toBe("single");
    expect(r.box).toBe(true);
  });

  it("highlight colour names map (blue→cyan, others identity)", () => {
    const colour = (c: string): string | undefined => paraIR([schema.text("h", [m.highlight.create({ color: c })])]).paragraphs[0].runs[0].highlight;
    expect(colour("blue")).toBe("cyan");
    expect(colour("yellow")).toBe("yellow");
    expect(colour("green")).toBe("green");
    expect(colour("lightGray")).toBe("lightGray");
  });

  it("an out-of-set highlight colour falls back to a valid value (never an invalid w:val)", () => {
    const json = { type: "doc", content: [{ type: "paragraph", attrs: { blockId: "b" }, content: [{ type: "text", text: "x", marks: [{ type: "highlight", attrs: { color: "purple" } }] }] }] };
    expect(docToDocxIR(json).paragraphs[0].runs[0].highlight).toBe("yellow");
  });

  it("highlight + underline on one run → both props, one run", () => {
    const runs = paraIR([schema.text("hu", [m.highlight.create({ color: "yellow" }), m.underline.create()])]).paragraphs[0].runs;
    expect(runs).toHaveLength(1);
    expect(runs[0].highlight).toBe("yellow");
    expect(runs[0].underline).toBe("single");
  });

  it("strong + emphasis on one run → bold once, emphasis underline + box preserved", () => {
    const r = paraIR([schema.text("se", [m.strong.create(), m.emphasis.create()])]).paragraphs[0].runs[0];
    expect(r.bold).toBe(true);
    expect(r.underline).toBe("single");
    expect(r.box).toBe(true);
  });

  it("emphasis + muted (post-merge, excludes-tolerant) → box+bold+underline AND small size, no throw", () => {
    // Hand-built JSON: nodeFromJSON would tolerate this; docToDocxIR must map it deterministically.
    const json = { type: "doc", content: [{ type: "paragraph", attrs: { blockId: "b" }, content: [{ type: "text", text: "x", marks: [{ type: "emphasis" }, { type: "muted" }] }] }] };
    const r = docToDocxIR(json).paragraphs[0].runs[0];
    expect(r.bold).toBe(true);
    expect(r.underline).toBe("single");
    expect(r.box).toBe(true);
    expect(r.sizeHalfPoints).toBe(16); // muted size still applies
  });

  it("a non-emphasis run in the same paragraph carries NO box", () => {
    const runs = paraIR([schema.text("plain "), schema.text("boxed", [m.emphasis.create()])]).paragraphs[0].runs;
    expect(runs[0].box).toBeUndefined();
    expect(runs[1].box).toBe(true);
  });
});

describe("docx-ir hard_break → in-paragraph break", () => {
  it("text + hard_break + text → ONE paragraph with a break run between the two text runs", () => {
    const ir = paraIR([schema.text("a"), schema.nodes.hard_break.create(), schema.text("b")]);
    expect(ir.paragraphs).toHaveLength(1); // NOT split into two paragraphs
    const runs = ir.paragraphs[0].runs;
    expect(runs).toHaveLength(3);
    expect(runs[0].text).toBe("a");
    expect(runs[1].isBreak).toBe(true);
    expect(runs[2].text).toBe("b");
  });
});

describe("docx-ir blocks → paragraphs (real Word paragraph STYLES)", () => {
  it("heading levels carry a STYLE id: pocket=Heading1 / hat=Heading2 / block+unknown=Heading3", () => {
    // The heading's look (size/centre/box/underline) lives in the STYLE def (docx.ts), so the IR
    // paragraph just names the style id. pocket→Heading1, hat→Heading2, block & any unknown level→Heading3.
    const head = (level?: string): DocxIR["paragraphs"][number] =>
      irOf(schema.nodes.doc.create(null, [schema.nodes.heading.create(level ? { blockId: id(), level } : { blockId: id() }, schema.text("H"))])).paragraphs[0];
    expect(head("pocket").styleId).toBe("Heading1");
    expect(head("hat").styleId).toBe("Heading2");
    expect(head("block").styleId).toBe("Heading3");
    expect(head().styleId).toBe("Heading3"); // unknown/legacy level falls back to Heading3
  });

  it("a styled heading's runs carry NO baked block appearance (look comes from the style, not the run)", () => {
    // The block bold/size/centre/box/underline must NOT be baked onto the run anymore — only inline marks do.
    const r = irOf(schema.nodes.doc.create(null, [schema.nodes.heading.create({ blockId: id(), level: "pocket" }, schema.text("H"))])).paragraphs[0].runs[0];
    expect(r.bold).toBeUndefined();
    expect(r.box).toBeUndefined();
    expect(r.underline).toBeUndefined();
    expect(r.sizeHalfPoints).toBeUndefined();
  });

  it("card TAG → Heading4 style; card body and plain paragraph carry NO style id", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ blockId: id() }, schema.text("p")),
      buildCard({ blockId: id(), tag: [schema.text("T")], body: [{ blockId: id(), content: [schema.text("b")] }] }),
    ]);
    const ir = irOf(doc);
    // plain ¶(1) + card[tag,1 body](2) = 3 paragraphs (no cite ¶ anymore).
    expect(ir.paragraphs).toHaveLength(3);
    expect(ir.paragraphs[0].styleId).toBeUndefined(); // plain paragraph
    expect(ir.paragraphs[1].styleId).toBe("Heading4"); // card tag
    expect(ir.paragraphs[2].styleId).toBeUndefined(); // card body para
  });

  it("analytic → custom Analytics style (same nav priority as tag, distinct colour/style)", () => {
    const p = irOf(schema.nodes.doc.create(null, [schema.nodes.analytic.create({ blockId: id() }, schema.text("A"))])).paragraphs[0];
    expect(p.styleId).toBe("Analytics");
    // The analytic colour/bold/size now live in the style def — the run carries no baked block props.
    expect(p.runs[0].bold).toBeUndefined();
    expect(p.runs[0].color).toBeUndefined();
    expect(p.runs[0].sizeHalfPoints).toBeUndefined();
  });

  it("muted inside a heading: muted's small size STILL wins as a run-level override (mud is always small)", () => {
    // Even though the heading look comes from a style now, a muted run must keep forcing its small absolute size
    // so it overrides the style's heading size in Word (run <w:sz> beats style size).
    const ir = irOf(schema.nodes.doc.create(null, [schema.nodes.heading.create({ blockId: id(), level: "pocket" }, schema.text("h", [m.muted.create()]))]));
    expect(ir.paragraphs[0].styleId).toBe("Heading1");
    expect(ir.paragraphs[0].runs[0].sizeHalfPoints).toBe(16); // run-level override of the style size
  });

  it("emphasis inside a heading: the run border box is STILL produced (inline mark survives the style move)", () => {
    const r = irOf(schema.nodes.doc.create(null, [schema.nodes.heading.create({ blockId: id(), level: "hat" }, schema.text("h", [m.emphasis.create()]))])).paragraphs[0].runs[0];
    expect(r.box).toBe(true); // emphasis box preserved as a run prop
    expect(r.bold).toBe(true); // emphasis still bolds the run
    expect(r.underline).toBe("single"); // emphasis underline preserved
  });

  it("card → tag ¶ + one ¶ per body paragraph, NO cite ¶ (2-body card → 3 paragraphs)", () => {
    const doc = schema.nodes.doc.create(null, [
      buildCard({
        blockId: id(),
        tag: [schema.text("CLAIM")],
        body: [{ blockId: id(), content: [schema.text("first")] }, { blockId: id(), content: [schema.text("second")] }],
      }),
    ]);
    const ir = irOf(doc);
    // card[tag, 2 body](3) — the cite NODE is gone, so no dedicated cite paragraph is emitted.
    expect(ir.paragraphs).toHaveLength(3);
    expect(ir.paragraphs[0].runs[0].text).toBe("CLAIM");
    expect(ir.paragraphs[0].styleId).toBe("Heading4"); // tag → Heading4 style
    expect(ir.paragraphs[1].runs[0].text).toBe("first");
    expect(ir.paragraphs[1].styleId).toBeUndefined(); // body para plain, no style
    expect(ir.paragraphs[2].runs[0].text).toBe("second");
  });

  it("empty blocks emit empty paragraphs — count == block/body-para count, none dropped", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.heading.create({ blockId: id() }), // empty heading
      buildCard({ blockId: id(), body: [{ blockId: id() }] }), // empty tag + one empty body para (no cite child)
      schema.nodes.analytic.create({ blockId: id() }), // empty analytic
    ]);
    const ir = irOf(doc);
    // heading(1) + card[tag,1 body](2) + analytic(1) = 4 paragraphs (no cite ¶ anymore)
    expect(ir.paragraphs).toHaveLength(4);
    expect(ir.paragraphs.every((p) => Array.isArray(p.runs))).toBe(true);
    expect(ir.paragraphs[0].runs).toHaveLength(0); // empty heading → empty paragraph
  });

  it("empty doc → no paragraphs", () => {
    expect(docToDocxIR(schema.nodes.doc.create(null, []).toJSON()).paragraphs).toHaveLength(0);
  });
});
