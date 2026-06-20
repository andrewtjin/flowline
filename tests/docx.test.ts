// docx.test.ts — the docx@9.7.1 packing adapter.
//
// The IR mapping is proven in docx-ir.test.ts; here we prove the bytes are a REAL, non-empty .docx — unzip
// word/document.xml and assert paragraphs + run props are actually present. A PK-magic-only check would pass
// even on an empty-sections Document, so we look inside.

import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { schema, buildCard } from "../src/schema";
import { createSeedDoc } from "../src/seed";
import { exportDocx } from "../src/persistence/docx";

const id = (): string => crypto.randomUUID();

/** Read one entry from the packed .docx zip as a string (throws if the entry is missing). */
async function entryXml(buf: Buffer, path: string): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const entry = zip.file(path);
  if (!entry) throw new Error(`${path} missing from the .docx`);
  return entry.async("string");
}

const documentXml = (buf: Buffer): Promise<string> => entryXml(buf, "word/document.xml");
const stylesXml = (buf: Buffer): Promise<string> => entryXml(buf, "word/styles.xml");

describe("docx export packing", () => {
  it("returns a valid ZIP (PK magic) for the seed", async () => {
    const buf = await exportDocx(createSeedDoc().toJSON());
    expect(buf[0]).toBe(0x50); // 'P'
    expect(buf[1]).toBe(0x4b); // 'K'
  });

  it("packs a non-empty document.xml with real text + run props (catches the empty-sections bug)", async () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.heading.create({ blockId: id(), level: "pocket" }, schema.text("TITLE")),
      schema.nodes.paragraph.create({ blockId: id() }, [
        schema.text("read ", [schema.marks.highlight.create({ color: "blue" }), schema.marks.underline.create()]),
        schema.text("bold", [schema.marks.strong.create()]),
      ]),
    ]);
    const xml = await documentXml(await exportDocx(doc.toJSON()));
    expect(xml).toContain("<w:p"); // at least one paragraph element
    expect(xml).toContain("TITLE"); // heading text present
    expect(xml).toContain('w:val="cyan"'); // blue highlight → Word cyan
    expect(xml).toContain("<w:b"); // bold (strong + heading)
  });

  it("exports an empty doc without throwing (one empty paragraph, valid document.xml)", async () => {
    const xml = await documentXml(await exportDocx(schema.nodes.doc.create(null, []).toJSON()));
    expect(xml).toContain("<w:p"); // the seeded empty paragraph
  });

  it("defines the five paragraph STYLES with the correct outline levels (word/styles.xml)", async () => {
    // word/styles.xml must DEFINE Heading1..Heading4 + the custom Analytics style, each with the right
    // <w:outlineLvl> so Word builds the nav-pane hierarchy. pocket=0, hat=1, block=2, tag=3, analytic=3.
    const styles = await stylesXml(await exportDocx(schema.nodes.doc.create(null, [schema.nodes.paragraph.create({ blockId: id() }, schema.text("x"))]).toJSON()));
    // Extract each style block by id, then assert the outline level WITHIN that block (a cross-style lazy match
    // could otherwise pass spuriously). Each id must be defined EXACTLY once (no duplicate built-in + custom def).
    const styleBlock = (styleId: string): string => {
      const all = styles.match(/<w:style\b[\s\S]*?<\/w:style>/g) ?? [];
      const blocks = all.filter((b) => new RegExp(`w:styleId="${styleId}"`).test(b));
      expect(blocks).toHaveLength(1); // exactly one definition — no invalid duplicate <w:style w:styleId>
      return blocks[0];
    };
    const outlineOf = (styleId: string): string | undefined => styleBlock(styleId).match(/<w:outlineLvl\s+w:val="(\d)"\s*\/>/)?.[1];
    expect(outlineOf("Heading1")).toBe("0"); // pocket
    expect(outlineOf("Heading2")).toBe("1"); // hat
    expect(outlineOf("Heading3")).toBe("2"); // block
    expect(outlineOf("Heading4")).toBe("3"); // card tag
    expect(outlineOf("Analytics")).toBe("3"); // analytic — same nav priority as tag
    expect(styleBlock("Analytics")).toContain('w:val="Heading4"'); // Analytics basedOn Heading4
    styleBlock("Normal"); // the Heading*/Analytics basedOn/next="Normal" chains resolve — Normal is defined exactly once (no dangling ref)
  });

  it("applies <w:pStyle> on the five styled blocks and NONE on body/plain (document.xml)", async () => {
    // Card is now `tag body` (no cite NODE/paragraph in v5); the source text rides inline on a body run.
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.heading.create({ blockId: id(), level: "pocket" }, schema.text("P")),
      schema.nodes.heading.create({ blockId: id(), level: "hat" }, schema.text("H")),
      schema.nodes.heading.create({ blockId: id(), level: "block" }, schema.text("B")),
      buildCard({ blockId: id(), tag: [schema.text("TAG")], body: [{ blockId: id(), content: [schema.text("BODY")] }] }),
      schema.nodes.analytic.create({ blockId: id() }, schema.text("AN")),
      schema.nodes.paragraph.create({ blockId: id() }, schema.text("plain")),
    ]);
    const xml = await documentXml(await exportDocx(doc.toJSON()));
    // The five styled blocks each reference their style via <w:pStyle>.
    expect(xml).toMatch(/<w:pStyle\s+w:val="Heading1"\s*\/>/); // pocket
    expect(xml).toMatch(/<w:pStyle\s+w:val="Heading2"\s*\/>/); // hat
    expect(xml).toMatch(/<w:pStyle\s+w:val="Heading3"\s*\/>/); // block
    expect(xml).toMatch(/<w:pStyle\s+w:val="Heading4"\s*\/>/); // card tag
    expect(xml).toMatch(/<w:pStyle\s+w:val="Analytics"\s*\/>/); // analytic
    // Exactly five pStyle references in the body — the body para and plain paragraph add none.
    expect((xml.match(/<w:pStyle\b/g) ?? []).length).toBe(5);
    // Byte-layer IDENTITY (not just count): the body and plain paragraphs SPECIFICALLY carry no style —
    // a regression that styled one while un-styling another block could keep the count at 5 but shift identity.
    const paraWith = (text: string): string => (xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).find((p) => p.includes(text)) ?? "";
    for (const unstyled of ["BODY", "plain"]) {
      const p = paraWith(unstyled);
      expect(p).not.toBe(""); // the paragraph exists
      expect(p).not.toContain("<w:pStyle"); // ...and it has no style → never a nav-pane entry
    }
  });

  it("size cascade lives in styles, not runs: docDefaults base + style sizes + muted run override", async () => {
    // The main risk: a run-level <w:sz> OVERRIDES the paragraph-style size, so if a
    // size were baked onto every run a styled heading would render at 11pt. Pin the whole cascade at the BYTE layer.
    const styles = await stylesXml(await exportDocx(schema.nodes.doc.create(null, [schema.nodes.paragraph.create({ blockId: id() }, schema.text("x"))]).toJSON()));
    // (1) the 11pt body base lives in docDefaults (NOT on every run).
    const docDefaults = styles.match(/<w:docDefaults>[\s\S]*?<\/w:docDefaults>/)?.[0] ?? "";
    expect(docDefaults).toMatch(/<w:sz\s+w:val="22"\s*\/>/);
    // (2) the heading sizes live on the STYLE defs (so an unstyled run inherits them): 52/44/32/26 hp.
    const styleBlock = (styleId: string): string => (styles.match(/<w:style\b[\s\S]*?<\/w:style>/g) ?? []).find((b) => new RegExp(`w:styleId="${styleId}"`).test(b)) ?? "";
    expect(styleBlock("Heading1")).toMatch(/<w:sz\s+w:val="52"\s*\/>/);
    expect(styleBlock("Heading2")).toMatch(/<w:sz\s+w:val="44"\s*\/>/);
    expect(styleBlock("Heading3")).toMatch(/<w:sz\s+w:val="32"\s*\/>/);
    expect(styleBlock("Heading4")).toMatch(/<w:sz\s+w:val="26"\s*\/>/);
    // (3) styled-heading runs (plain text) carry NO explicit <w:sz> — else they'd shadow the style size (the bug).
    const headingsOnly = await documentXml(await exportDocx(schema.nodes.doc.create(null, [
      schema.nodes.heading.create({ blockId: id(), level: "pocket" }, schema.text("P")),
      schema.nodes.heading.create({ blockId: id(), level: "hat" }, schema.text("H")),
      schema.nodes.heading.create({ blockId: id(), level: "block" }, schema.text("B")),
    ]).toJSON()));
    expect(headingsOnly).not.toContain("<w:sz"); // no per-run size anywhere → sizes inherited from the styles
    // (4) but a muted run STILL emits an explicit <w:sz w:val="16"> (8pt), overriding whatever style it sits in.
    const muted = await documentXml(await exportDocx(schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ blockId: id() }, schema.text("m", [schema.marks.muted.create()])),
    ]).toJSON()));
    expect(muted).toMatch(/<w:sz\s+w:val="16"\s*\/>/);
  });
});
