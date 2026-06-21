// persistence/docx-ir.ts — the PURE Flowline-doc → Word intermediate representation.
//
// This module is the testable HEART of .docx export: it maps a `doc.toJSON()` tree to a small, dependency-free
// IR of paragraphs + runs with explicit Word run properties. Keeping it free of the `docx` library means (a)
// the whole mark/block mapping is unit-testable by asserting on the IR (no packing, no zip), and (b) it never
// drags the node-only `docx` dependency into a renderer-reachable module. The thin `docx.ts` adapter turns this
// IR into a real `docx` Document. ZERO third-party imports here — by design.
//
// MAPPING:
//   marks  → run props: highlight→w:highlight (FL colour name → Word HighlightColor; blue→cyan, see table),
//            strong→bold, emphasis→bold + single underline + a RUN border box (w:bdr), underline→single
//            underline, muted→a small ABSOLUTE size, cite→bold + the 13pt tag size (the inline citation/source
//            style; schema v5). A run carrying several marks folds them idempotently (bold set once; one
//            underline; muted's small size overrides cite's 13pt so "mud" stays smallest; the excludes-tolerant
//            emphasis+muted both apply — box+bold+u AND small — never throwing). hard_break → an in-run line
//            break, NEVER a new paragraph.
//   blocks → paragraphs (count == block / body-paragraph count; empty blocks emit an empty paragraph, never
//            dropped). The five "structural" blocks carry a Word paragraph STYLE id (not direct run formatting),
//            so they appear in Word's NAVIGATION PANE and integrate with Word/Verbatim:
//              heading "pocket"→Heading1, "hat"→Heading2, "block"/unknown→Heading3, card.tag→Heading4,
//              analytic→Analytics (a custom style based on Heading4, distinct colour).
//            Those five emit STYLE-ONLY paragraphs: the paragraph names a styleId and its runs carry ONLY
//            inline-mark-derived props — the block's intrinsic look (bold/size/centre/box/underline/colour)
//            lives in the STYLE DEFINITION (built in docx.ts), NOT baked into the runs. card.body paragraphs
//            and plain paragraph stay unstyled (no styleId → never a nav-pane entry).
//
// LOSSY-INTEROP NOTE: .docx is the lossy Word lane (the NATIVE envelope is the lossless source of truth). The
// blue→cyan highlight remap is therefore fine — Word's "blue" highlight is a dark navy that swallows black read
// text, whereas Flowline's #4db6ff azure reads closest to Word "cyan". The .fl file still stores "blue" verbatim.

// ── Run-property value sets ────────────────────────────────────────────────────────────────────────
/** Word HighlightColor names this exporter emits (a subset of the OOXML highlight palette). */
export type DocxHighlight = "cyan" | "yellow" | "green" | "lightGray";

/** Flowline highlight colour name → Word HighlightColor. blue→cyan is a deliberate legibility remap (see above). */
const FL_TO_WORD_HIGHLIGHT: Record<string, DocxHighlight> = {
  blue: "cyan",
  yellow: "yellow",
  green: "green",
  lightGray: "lightGray",
};
/** A colour outside the closed schema set should never occur; if it did, fall back to a visible, valid value. */
const HIGHLIGHT_FALLBACK: DocxHighlight = "yellow";

/** Absolute run sizes in HALF-points (Word's unit). Body/default = 11pt; muted is small-but-readable ≈ 8pt.
 *
 * Type scale (half-points = pt × 2):
 *   pocket heading  = 26pt = 52 hp   (Heading1)
 *   hat heading     = 22pt = 44 hp   (Heading2)
 *   block heading   = 16pt = 32 hp   (Heading3)
 *   normal/body     = 11pt = 22 hp  (DOCX_BASE_HALF_POINTS — now the document DEFAULT run size in docx.ts)
 *   tag/analytic/cite = 13pt = 26 hp (Heading4 / Analytics / the inline cite mark)
 *   muted           =  8pt = 16 hp   (always the smallest — overrides a style's size via a run-level override)
 *
 * The structural blocks no longer bake these into runs — the values are EXPORTED so docx.ts can
 * feed them into the Word paragraph-STYLE definitions instead (the style carries the size; an unstyled run then
 * inherits it). MUTED_HALF_POINTS remains a per-run override so "mud" text stays small even inside a heading.
 */
export const DOCX_BASE_HALF_POINTS = 22; // 11pt — normal paragraph, card body (docDefaults run size)
/** 8pt — debate "mud" text. Still emitted as an explicit per-run size so it overrides the heading style size. */
export const MUTED_HALF_POINTS = 16;
/** 13pt — card tag claim line (Heading4) + analytic prose (Analytics, which inherits this from Heading4). */
export const TAG_ANALYTIC_HALF_POINTS = 26;
/** Heading style sizes in half-points, keyed by Flowline heading level (feed the Heading1/2/3 style defs). */
export const HEADING_HALF_POINTS: Record<string, number> = {
  pocket: 52, // 26pt → Heading1
  hat: 44, // 22pt → Heading2
  block: 32, // 16pt → Heading3
};
/** Dark blue for analytic prose (matches the editor's dark-blue analytic). Clean-implementation hex, not a reference value. */
export const ANALYTIC_COLOR = "1F3A93";

/** Word paragraph-STYLE id per Flowline heading level. unknown/legacy level → Heading3 (mirrors the size fallback).
 * These ids are DEFINED in docx.ts and named here so a styled heading paragraph appears in Word's nav pane. */
export const HEADING_STYLE_ID: Record<string, string> = {
  pocket: "Heading1",
  hat: "Heading2",
  block: "Heading3",
};
/** Style id for a card TAG paragraph (claim line) — nav-pane level 4. */
export const TAG_STYLE_ID = "Heading4";
/** Custom style id for analytic prose — same nav priority as the tag, distinct colour (defined in docx.ts). */
export const ANALYTIC_STYLE_ID = "Analytics";

// ── IR shapes ────────────────────────────────────────────────────────────────────────────────────
/** One Word run: either a text run with properties, or an in-paragraph line break (`isBreak`). */
export interface DocxRun {
  readonly text: string;
  readonly bold?: boolean;
  readonly underline?: "single" | "double";
  readonly box?: boolean; // a RUN-level border (w:bdr) — the emphasis box / pocket-heading box
  readonly highlight?: DocxHighlight;
  readonly color?: string; // hex (no '#') — analytic dark blue
  readonly sizeHalfPoints?: number; // explicit absolute size (muted small; heading sizes); else document default
  readonly isBreak?: boolean; // a hard_break → one <w:br/> in the SAME paragraph (text/props ignored)
}

/** One Word paragraph. */
export interface DocxParagraph {
  readonly runs: readonly DocxRun[];
  // The id of a Word paragraph STYLE this paragraph uses. Set ONLY on the five structural blocks
  // (heading levels → Heading1/2/3, card tag → Heading4, analytic → Analytics) so they enter the nav pane and
  // inherit their look from the style def. cite/body/plain paragraphs leave this undefined → no style, no nav entry.
  readonly styleId?: string;
}

/** The whole document IR. */
export interface DocxIR {
  readonly paragraphs: readonly DocxParagraph[];
}

// ── doc.toJSON() shape (minimal) ───────────────────────────────────────────────────────────────────
interface JsonMark {
  type: string;
  attrs?: Record<string, unknown>;
}
interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
  marks?: JsonMark[];
}

/** Folded inline-mark properties for a single text run. */
interface MarkProps {
  bold: boolean;
  underlineSingle: boolean;
  box: boolean;
  muted: boolean;
  cite: boolean;
  highlight?: DocxHighlight;
}

/** Fold a text node's marks into run properties, idempotently (bold/underline set at most once). */
function foldMarks(marks: readonly JsonMark[] | undefined): MarkProps {
  const p: MarkProps = { bold: false, underlineSingle: false, box: false, muted: false, cite: false };
  for (const m of marks ?? []) {
    switch (m.type) {
      case "strong":
        p.bold = true;
        break;
      case "cite": // citation/source: bold + the 13pt tag size (size applied in makeRun, muted overrides it)
        p.bold = true;
        p.cite = true;
        break;
      case "emphasis": // bold + single underline + the box (the excludes-tolerant pair: also keep muted if present)
        p.bold = true;
        p.underlineSingle = true;
        p.box = true;
        break;
      case "underline":
        p.underlineSingle = true;
        break;
      case "muted":
        p.muted = true;
        break;
      case "highlight": {
        const color = typeof m.attrs?.color === "string" ? m.attrs.color : "";
        p.highlight = FL_TO_WORD_HIGHLIGHT[color] ?? HIGHLIGHT_FALLBACK;
        break;
      }
      default:
        break; // unknown mark → no run prop (forward-compatible)
    }
  }
  return p;
}

/** Build one run from a text node's text + marks. A run carries ONLY inline-mark-derived props —
 * the block's intrinsic appearance now lives in the paragraph STYLE, not in the run. The two inline overrides
 * that MUST still win over a style are preserved: muted forces the small absolute size, and emphasis produces
 * the run border box (both come straight from foldMarks). */
function makeRun(text: string, marks: readonly JsonMark[] | undefined): DocxRun {
  const f = foldMarks(marks);
  return {
    text,
    bold: f.bold || undefined,
    underline: f.underlineSingle ? "single" : undefined,
    box: f.box || undefined,
    highlight: f.highlight,
    // Absolute size as a run-level override: muted forces the small "mud" size (always smallest — it beats
    // cite); else a cite run lifts to the 13pt tag tier. A plain run gets no override and inherits the doc default.
    sizeHalfPoints: f.muted ? MUTED_HALF_POINTS : f.cite ? TAG_ANALYTIC_HALF_POINTS : undefined,
  };
}

/** Walk a block's inline content (`inline*`) into runs: text→run, hard_break→an in-paragraph break run. */
function inlineRuns(content: readonly JsonNode[] | undefined): DocxRun[] {
  const runs: DocxRun[] = [];
  for (const child of content ?? []) {
    if (child.type === "hard_break") {
      runs.push({ text: "", isBreak: true });
    } else if (child.type === "text") {
      runs.push(makeRun(child.text ?? "", child.marks));
    }
    // any other inline node type: ignored (none exist in the schema beyond text/hard_break)
  }
  return runs;
}

/** One paragraph: inline content → style-only runs, plus an optional Word paragraph STYLE id. */
const para = (content: readonly JsonNode[] | undefined, styleId?: string): DocxParagraph => ({
  runs: inlineRuns(content),
  styleId, // the five structural blocks pass a style id; cite/body/plain pass nothing → undefined
});

/** Find a card's child by type (schema guarantees tag, body — but resolve by type to be robust). */
function childByType(card: JsonNode, type: string): JsonNode | undefined {
  return (card.content ?? []).find((c) => c.type === type);
}

/**
 * Map a Flowline document (`doc.toJSON()`) to the Word IR. Paragraph count equals the block / body-paragraph
 * count exactly — empty blocks become empty paragraphs (never dropped). A card is `tag body` (schema v5): its
 * tag claim → a Heading4 paragraph and each body paragraph → a plain paragraph; the cite/source text is an
 * inline mark folded into the run props (bold + 13pt), NOT a separate paragraph.
 */
export function docToDocxIR(input: unknown): DocxIR {
  const doc = input as JsonNode; // the caller passes `doc.toJSON()` (a plain serialisable tree)
  const paragraphs: DocxParagraph[] = [];
  for (const block of doc.content ?? []) {
    switch (block.type) {
      case "heading": {
        // Heading level → Word paragraph style (pocket=Heading1, hat=Heading2, block/unknown=Heading3). The
        // style carries the bold/size/centre/box/underline; the runs carry only inline-mark props.
        const level = typeof block.attrs?.level === "string" ? block.attrs.level : "block";
        paragraphs.push(para(block.content, HEADING_STYLE_ID[level] ?? HEADING_STYLE_ID.block));
        break;
      }
      case "analytic":
        // Custom "Analytics" style (based on Heading4): same nav priority as a tag, distinct dark-blue colour.
        paragraphs.push(para(block.content, ANALYTIC_STYLE_ID));
        break;
      case "paragraph":
        paragraphs.push(para(block.content)); // plain ¶ — no style, not a nav entry
        break;
      case "card": {
        const tag = childByType(block, "tag");
        const body = childByType(block, "body");
        paragraphs.push(para(tag?.content, TAG_STYLE_ID)); // claim line → Heading4 (nav level 4)
        for (const bodyPara of body?.content ?? []) {
          paragraphs.push(para(bodyPara.content)); // one plain ¶ per body paragraph (cite text rides inline)
        }
        break;
      }
      default:
        break; // unknown top-level block: skip (none exist in the schema)
    }
  }
  return { paragraphs };
}
