// persistence/docx.ts — the thin IR → `docx` serializer (the ONLY module that imports the `docx` library).
//
// All of the Flowline-specific mapping lives in the pure, dependency-free `docx-ir.ts`; this file just turns
// that IR into a real `docx` Document and packs it to bytes. Keeping `import … from "docx"` confined here is
// what preserves two properties: (a) docx-ir stays unit-testable without the lib, and (b) the node-only `docx`
// dependency never leaks into a renderer-reachable module (it is imported only by the MAIN process).
//
// `new Document` REQUIRES a `sections` array — paragraphs live in `sections[].children`, NOT at the Document
// root (a Document built without sections packs an empty/invalid body that still starts with the "PK" zip magic,
// so the smoke test would pass while Word shows nothing — a critical correctness trap). `Packer.toBuffer` is async.
//
// REAL Word paragraph STYLES (Navigation Pane + Word/Verbatim integration):
//   The five structural blocks (heading levels, card tag, analytic) reference a paragraph STYLE id in the IR.
//   Here we DEFINE those styles (Heading1..Heading4 + a custom Analytics) and let Word apply their look. This
//   replaces the prior bare per-paragraph outlineLevel: a real <w:pStyle> is what surfaces a heading in the nav
//   pane AND lets it behave like a Word heading (Verbatim, TOC, collapse, etc.).
//
//   THE SIZE CASCADE (the #1 risk). In OOXML an explicit <w:sz> on a RUN overrides the paragraph style's size.
//   So we must NOT force a size on every run — if we did, a styled heading run with size 22 would render at 11pt
//   instead of the style's 52/44/32. Instead:
//     • the base 11pt body size lives in the DOCUMENT DEFAULTS run props (styles.default.document.run.size),
//       so plain/body text inherits 11pt with no per-run size;
//     • a run emits <w:sz> ONLY when the IR set sizeHalfPoints (muted 8pt, or a cite-marked run 13pt), so
//       those per-run sizes still override the inherited base;
//     • a styled heading run carries no size → it correctly inherits the STYLE's size.

import { Document, Packer, Paragraph, TextRun, AlignmentType, UnderlineType, BorderStyle } from "docx";
import {
  docToDocxIR,
  DOCX_BASE_HALF_POINTS,
  HEADING_HALF_POINTS,
  TAG_ANALYTIC_HALF_POINTS,
  ANALYTIC_COLOR,
  type DocxRun,
  type DocxParagraph,
} from "./docx-ir";

/** One IR run → a docx TextRun. A break run becomes a single in-paragraph `<w:br/>`. */
function toTextRun(run: DocxRun): TextRun {
  if (run.isBreak) return new TextRun({ break: 1 });
  return new TextRun({
    text: run.text,
    bold: run.bold,
    underline: run.underline
      ? { type: run.underline === "double" ? UnderlineType.DOUBLE : UnderlineType.SINGLE }
      : undefined,
    highlight: run.highlight, // the Word HighlightColor name (DocxHighlight is a subset of that enum's values)
    color: run.color,
    // CRITICAL (size cascade): emit <w:sz> ONLY when the IR set an explicit size (today: muted = 8pt). With NO
    // fallback to DOCX_BASE_HALF_POINTS, a styled-heading run carries no size and inherits the STYLE's size
    // (52/44/32), while a muted run still forces 16 hp, overriding whatever style it sits in. The 11pt body
    // base now comes from the document-default run size (see exportDocx), not from a per-run default here.
    size: run.sizeHalfPoints,
    // The emphasis box is a RUN-level border (w:bdr) — NOT the paragraph border. `style` is required; size is
    // in 1/8 pt (6 = 0.75pt, a clearly visible hairline box). (Heading box now lives on the Heading1 STYLE.)
    border: run.box ? { style: BorderStyle.SINGLE, size: 6, space: 0, color: "auto" } : undefined,
  });
}

/** One IR paragraph → a docx Paragraph. A styled paragraph names its Word STYLE; appearance comes from the
 * style def (size/centre/box/underline/colour), so we set NOTHING else here — no per-paragraph alignment or
 * outline level. Unstyled paragraphs (body/plain) get no style and so never enter the nav pane. */
function toParagraph(p: DocxParagraph): Paragraph {
  return new Paragraph({
    children: p.runs.map(toTextRun),
    style: p.styleId, // undefined for body/plain → no <w:pStyle>, no nav-pane entry
  });
}

/** A full single-line box on all four sides — the pocket-heading box, now defined on the Heading1 STYLE
 * (replaces the old per-run border). Hairline-visible: size is in 1/8 pt (8 = 1pt). */
const POCKET_BOX = {
  top: { style: BorderStyle.SINGLE, size: 8, space: 1, color: "auto" },
  bottom: { style: BorderStyle.SINGLE, size: 8, space: 1, color: "auto" },
  left: { style: BorderStyle.SINGLE, size: 8, space: 4, color: "auto" },
  right: { style: BorderStyle.SINGLE, size: 8, space: 4, color: "auto" },
};

// The Word paragraph STYLES that carry the approved appearance. docx already SHIPS built-in
// Heading1..Heading4 styles (each with its <w:outlineLvl>); supplying them again under `paragraphStyles` would
// emit DUPLICATE <w:style w:styleId="HeadingN"> entries (invalid OOXML — Word then keeps its own default look).
// The correct extension point is `styles.default.headingN`, which OVERRIDES the built-in style in place. So we
// override Heading1..Heading4's run/paragraph props there, and define ONLY the genuinely-new Analytics style via
// `paragraphStyles`. We keep the approved sizes/decorations/colour (NOT the resaved template's 14pt or its
// pageBreakBefore). The built-in heading styles already carry the right <w:outlineLvl> (0/1/2/3), so a Word doc
// using <w:pStyle w:val="HeadingN"> appears in the Navigation Pane and integrates with Word/Verbatim.

// docx's built-in heading styles do NOT emit <w:outlineLvl>; Word would still infer the level from the style
// NAME, but the approved target (the resaved Verbatim template) wants an EXPLICIT <w:outlineLvl> on
// each style. So every heading override below sets `paragraph.outlineLevel`, and Analytics carries its own.
/** Override props for the built-in Heading1..Heading4 styles (merged into docx's defaults via styles.default). */
const HEADING_STYLE_OVERRIDES = {
  // pocket → Heading 1: centred, boxed, 26pt bold, outline level 0. Box moved off the run onto the style.
  heading1: {
    paragraph: { outlineLevel: 0, alignment: AlignmentType.CENTER, border: POCKET_BOX },
    run: { bold: true, size: HEADING_HALF_POINTS.pocket, color: "auto" },
  },
  // hat → Heading 2: centred, 22pt bold, double underline, outline level 1.
  heading2: {
    paragraph: { outlineLevel: 1, alignment: AlignmentType.CENTER },
    run: { bold: true, size: HEADING_HALF_POINTS.hat, underline: { type: UnderlineType.DOUBLE }, color: "auto" },
  },
  // block → Heading 3: centred, 16pt bold, single underline, outline level 2.
  heading3: {
    paragraph: { outlineLevel: 2, alignment: AlignmentType.CENTER },
    run: { bold: true, size: HEADING_HALF_POINTS.block, underline: { type: UnderlineType.SINGLE }, color: "auto" },
  },
  // card tag → Heading 4: 13pt bold, NOT centred (the claim line reads as left-aligned, body-adjacent), level 3.
  heading4: {
    paragraph: { outlineLevel: 3 },
    run: { bold: true, size: TAG_ANALYTIC_HALF_POINTS, color: "auto" },
  },
};

/** A minimal Normal base style. docx emits docDefaults but NO named "Normal" style here, so the built-in
 * Heading1..Heading6 (and our Analytics) basedOn/next="Normal" chains would otherwise dangle (terminate at an
 * undefined style id). The ground-truth Verbatim re-save defines a full Normal; Word tolerates a dangling ref,
 * but a self-consistent part is correct. It carries no run/paragraph props — it just inherits docDefaults (11pt),
 * which is exactly what "Normal" should be. (IStyleOptions has no w:default flag; Word treats styleId "Normal"
 * as the default paragraph style by name.) */
const NORMAL_PARAGRAPH_STYLE = {
  id: "Normal",
  name: "Normal",
  quickFormat: true,
};

/** The one genuinely-custom debate style: analytic prose. basedOn Heading4 (so it inherits bold + size 26 — same nav
 * priority as a tag), overriding only the colour. It declares its own outline level 3 explicitly (basedOn does
 * not guarantee the child re-serializes the parent's outlineLvl). This is the "same nav priority as tag, different
 * colour + style" the user asked for. */
const ANALYTIC_PARAGRAPH_STYLE = {
  id: "Analytics",
  name: "Analytics",
  basedOn: "Heading4",
  next: "Normal",
  quickFormat: true,
  paragraph: { outlineLevel: 3 },
  run: { color: ANALYTIC_COLOR },
};

/**
 * Build the `docx` `Document` for a Flowline doc (`doc.toJSON()`) — the dependency-on-`docx` heart of export,
 * SHARED by the node lane (`exportDocx` → Packer.toBuffer) and the web lane (web-docx.ts → Packer.toBlob). It is
 * pure aside from constructing `docx` objects (no fs, no Buffer), so it bundles for the browser; only the PACK
 * step (Buffer vs Blob) differs between the two lanes. Factoring it here keeps the style/IR mapping in ONE place.
 */
export function buildDocxDocument(docJson: unknown): Document {
  const ir = docToDocxIR(docJson);
  // An empty document (0 blocks is a valid transient) still must produce a valid .docx — emit one empty paragraph.
  const children = ir.paragraphs.length > 0 ? ir.paragraphs.map(toParagraph) : [new Paragraph({})];
  return new Document({
    styles: {
      // `default` feeds docx's DefaultStylesFactory: `document.run.size` sets the docDefaults run size (11pt body
      // base — see the size-cascade note above), and `headingN` OVERRIDE the built-in heading styles in place
      // (NOT duplicated). This is the crux of the size cascade fix: the base lives in docDefaults, the heading
      // sizes live on the heading STYLES, and only an explicit per-run size (muted 8pt) overrides a style.
      default: {
        document: { run: { size: DOCX_BASE_HALF_POINTS } },
        ...HEADING_STYLE_OVERRIDES,
      },
      paragraphStyles: [NORMAL_PARAGRAPH_STYLE, ANALYTIC_PARAGRAPH_STYLE],
    },
    sections: [{ properties: {}, children }],
  });
}

/**
 * Export a Flowline document (`doc.toJSON()`) to a `.docx` byte buffer. Lossy Word-interop lane (the native
 * envelope is the lossless source of truth). Runs in the MAIN process; the caller MUST `await` it before writing.
 */
export async function exportDocx(docJson: unknown): Promise<Buffer> {
  return Packer.toBuffer(buildDocxDocument(docJson));
}
