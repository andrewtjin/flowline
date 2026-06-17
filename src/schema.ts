// schema.ts — Flowline's ProseMirror document schema.
//
// Invariants this file must uphold (the editor's reason to exist):
//   - Single deterministic toDOM/parseDOM, ZERO NodeViews. Every node/mark renders purely from
//     serializable attrs (blockId/level/color as data-*). No closures, no Date.now()/random in render.
//   - The 5 structural hard cases are each satisfied by EXACTLY ONE element here:
//        #1 isolating blockId units .... card / analytic / heading / paragraph (all isolating, required blockId)
//        #2 inclusive vs non-inclusive . highlight (inclusive) vs muted (non-inclusive)
//        #3 mutually-excluding pair .... emphasis <-> muted (symmetric excludes)
//        #4 destroy+recreate move ...... moveBlock (command) over this flat block list
//        #5 full-doc-scan normalizer ... the structural absorb normalizer (paragraph→card structural absorb)
//                                        lives in normalizer.ts as a standalone import-repair utility. It is
//                                        NOT installed as a live editor plugin (auto-absorb was unwanted).
//
// Mark order is LOCKED: highlight (outer) -> emphasis | muted -> underline -> strong (inner). The order
// below IS the render order — keep highlight first so the identity-diff serialization is stable regardless
// of the order marks were applied in. `underline` (schema v2) and `strong` (schema v3) sit innermost so the
// highlight background still wraps a read+underlined+bold span.

import { Schema } from "prosemirror-model";
import type { NodeSpec, MarkSpec, DOMOutputSpec, Node as PMNode } from "prosemirror-model";

// ── Closed value sets ────────────────────────────────────────────────────────────────────────
// MVP highlight colors are Word OOXML highlight color names (lossless .docx round-trip). The actual
// displayed colors are CSS vars (--fl-color-<name>) a viewer can override.
export const HIGHLIGHT_COLORS = ["blue", "yellow", "green", "lightGray"] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];
export const DEFAULT_HIGHLIGHT_COLOR: HighlightColor = "blue";

// Debate heading hierarchy expressed as a flat `level` attr (NOT nesting).
export const HEADING_LEVELS = ["pocket", "hat", "block"] as const;
export type HeadingLevel = (typeof HEADING_LEVELS)[number];
export const DEFAULT_HEADING_LEVEL: HeadingLevel = "block";

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────
// parseDOM getAttrs receives `HTMLElement | string`; block rules only ever match elements.
function readBlockId(dom: HTMLElement | string): { blockId: string | null } {
  const el = dom as HTMLElement;
  return { blockId: el.getAttribute("data-block-id") };
}

// A `validate` function enforcing a closed value set at check()/fromJSON time. This gives the
// conformance gate DOMAIN teeth (an out-of-set color/level is rejected), not just type teeth —
// `validate:"string"` alone would accept any string. The command layer only ever supplies valid values.
function oneOf(allowed: readonly string[], attr: string) {
  return (value: unknown): void => {
    if (typeof value !== "string" || !allowed.includes(value)) {
      throw new RangeError(`Invalid ${attr} "${String(value)}" (expected one of: ${allowed.join(", ")})`);
    }
  };
}

// A `validate` for a REQUIRED blockId. The multi-paragraph card body forces `paragraph.blockId` to carry an explicit
// `default: null` (see the paragraph spec note) so PM treats `paragraph` as GENERATABLE and will
// accept it in `body`'s required `paragraph+` position. That default is a structural generatability
// proxy ONLY — it must NOT weaken the conformance teeth. This validator restores the teeth: at
// node.check()/fromJSON time it REJECTS a null/absent/empty blockId, so a real paragraph still
// requires a genuine, non-empty id even though the schema can "generate" a placeholder one.
function requiredBlockId(value: unknown): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new RangeError(`Invalid blockId "${String(value)}" (a non-empty string is required)`);
  }
}

// ── Nodes ────────────────────────────────────────────────────────────────────────────────────
export const nodes: Record<string, NodeSpec> = {
  // The document root: a flat ordered list of blocks.
  // NOTE: content is `block*`, not `block+`. Every block requires a `blockId` with no
  // default, which makes all block types "non-generatable"; ProseMirror cannot auto-fill a REQUIRED
  // block position, so `block+` throws at schema construction ("non-generatable in a required
  // position"). `block*` removes the required position. This does NOT weaken the conformance teeth —
  // creating a block without a blockId still throws at check(). The editor keeps >=1 block via the
  // seed/commands; a momentarily-empty doc is a valid transient state.
  doc: { content: "block*" },

  // Headline evidence card — fixed 3-child structure. Isolating so edits/selection cannot leak
  // across its boundary; carries a required, stable blockId.
  card: {
    group: "block",
    content: "tag cite body",
    isolating: true,
    attrs: { blockId: { validate: "string" } }, // no default => REQUIRED (conformance has teeth)
    parseDOM: [{ tag: "div.fl-card", getAttrs: readBlockId }],
    toDOM(node) {
      return ["div", { class: "fl-card", "data-block-id": node.attrs.blockId as string }, 0] as DOMOutputSpec;
    },
  },
  // Plain interior containers of a card. Not isolating, no attrs. `body` is where read-marks concentrate.
  tag: {
    content: "inline*",
    parseDOM: [{ tag: "div.fl-tag" }],
    toDOM() { return ["div", { class: "fl-tag" }, 0] as DOMOutputSpec; },
  },
  cite: {
    content: "inline*",
    parseDOM: [{ tag: "div.fl-cite" }],
    toDOM() { return ["div", { class: "fl-cite" }, 0] as DOMOutputSpec; },
  },
  // body is MULTI-PARAGRAPH evidence (`paragraph+`, one-or-more paragraph nodes) instead
  // of `inline*`. Each paragraph is a real isolating block carrying its own blockId; the body itself
  // is a plain non-attr wrapper rendered as div.fl-body around its paragraph children.
  body: {
    content: "paragraph+",
    parseDOM: [{ tag: "div.fl-body" }],
    toDOM() { return ["div", { class: "fl-body" }, 0] as DOMOutputSpec; },
  },

  // The debater's own argument prose — visually dark blue to distinguish from plain text.
  analytic: {
    group: "block",
    content: "inline*",
    isolating: true,
    attrs: { blockId: { validate: "string" } },
    parseDOM: [{ tag: "div.fl-analytic", getAttrs: readBlockId }],
    toDOM(node) {
      return ["div", { class: "fl-analytic", "data-block-id": node.attrs.blockId as string }, 0] as DOMOutputSpec;
    },
  },

  // Flat organizing heading; the hierarchy is the `level` attr, not block nesting.
  heading: {
    group: "block",
    content: "inline*",
    isolating: true,
    attrs: {
      blockId: { validate: "string" },
      level: { default: DEFAULT_HEADING_LEVEL, validate: oneOf(HEADING_LEVELS, "level") },
    },
    parseDOM: [
      {
        tag: "div.fl-heading",
        getAttrs(dom) {
          const el = dom as HTMLElement;
          return {
            blockId: el.getAttribute("data-block-id"),
            level: el.getAttribute("data-level") ?? DEFAULT_HEADING_LEVEL,
          };
        },
      },
    ],
    toDOM(node) {
      return [
        "div",
        { class: "fl-heading", "data-level": node.attrs.level as string, "data-block-id": node.attrs.blockId as string },
        0,
      ] as DOMOutputSpec;
    },
  },

  // Plain, unstyled free-text block — the "normal style" default produced by Enter at the end of a
  // card body / heading / paragraph. (analytic is a STYLED block, not the fallback.)
  //
  // TRADEOFF: paragraph is also the content of a card's `body` (`paragraph+`, a REQUIRED `+`
  // position). ProseMirror refuses to construct a schema that has a non-generatable node in a
  // required position — and a node whose `blockId` attr has NO default is "non-generatable". So
  // `blockId` here gets an explicit `default: null`, making paragraph generatable and letting the
  // `paragraph+` body schema build. The teeth are NOT lost: `validate: requiredBlockId` REJECTS a
  // null/absent/empty blockId at node.check()/fromJSON, so a real paragraph still requires a genuine
  // id; only the structural generatability proxy changed. (The other blocks — card/analytic/heading
  // — keep no default because they sit in `block*`, never a required `+` position.)
  paragraph: {
    group: "block",
    content: "inline*",
    isolating: true,
    attrs: { blockId: { default: null, validate: requiredBlockId } },
    parseDOM: [{ tag: "div.fl-paragraph", getAttrs: readBlockId }],
    toDOM(node) {
      return ["div", { class: "fl-paragraph", "data-block-id": node.attrs.blockId as string }, 0] as DOMOutputSpec;
    },
  },

  // Inline leaf nodes.
  text: { group: "inline" },
  hard_break: {
    inline: true,
    group: "inline",
    selectable: false,
    parseDOM: [{ tag: "br" }],
    toDOM() { return ["br"] as DOMOutputSpec; },
  },
};

// ── Marks (LOCKED order: highlight -> emphasis | muted) ────────────────────────────────────────
//
// NOTE on `excludes` (the mutually-excluding pair): emphasis and muted symmetrically `excludes` each other,
// so editing can never put both on one char (ProseMirror's addToSet evicts the excluded mark).
// In ProseMirror, `Node.fromJSON` TOLERATES a both-marks state (one that could arise transiently from an
// external source) while `node.check()` REJECTS it ("Invalid collection of marks"). That is intended: such a
// transient must be reconciled by a normalizer BEFORE the doc is run through the conformance gate. (Behavior
// pinned in tests/schema.test.ts.)
export const marks: Record<string, MarkSpec> = {
  // Read-aloud highlighter (highest-frequency action). `color` is REQUIRED (no schema default) so a
  // highlight missing its color is rejected by the conformance gate; the command/parseDOM default to
  // "blue". inclusive:true => the mark grows when you type at its edge (the inclusive side of the edge-growth pair).
  highlight: {
    inclusive: true,
    attrs: { color: { validate: oneOf(HIGHLIGHT_COLORS, "color") } },
    parseDOM: [
      {
        tag: "span.fl-highlight",
        getAttrs(dom) {
          return { color: (dom as HTMLElement).getAttribute("data-color") ?? DEFAULT_HIGHLIGHT_COLOR };
        },
      },
    ],
    toDOM(mark) {
      return ["span", { class: "fl-highlight", "data-color": mark.attrs.color as string }, 0] as DOMOutputSpec;
    },
  },
  // Read-aloud stress: bold + underline + border box. Excludes muted (the mutually-excluding pair).
  emphasis: {
    inclusive: true,
    excludes: "muted",
    parseDOM: [{ tag: "span.fl-emphasis" }],
    toDOM() { return ["span", { class: "fl-emphasis" }, 0] as DOMOutputSpec; },
  },
  // Skip-past "mud" text: small font (NOT grey). inclusive:false => does NOT grow at edges (the
  // non-inclusive side of the edge-growth pair). Excludes emphasis (the mutually-excluding pair, symmetric).
  muted: {
    inclusive: false,
    excludes: "emphasis",
    parseDOM: [{ tag: "span.fl-muted" }],
    toDOM() { return ["span", { class: "fl-muted" }, 0] as DOMOutputSpec; },
  },
  // Read-aloud underline (schema v2): the plain "read this" marker — Verbatim's separate "Style
  // Underline" character style, distinct from `emphasis` (which is bold+underline+box). inclusive:true
  // so it grows as you extend a read span. NO `excludes` — it layers freely with highlight/emphasis/
  // muted (a word can be underlined AND highlighted). Innermost in the locked render order.
  // NOTE: this mark is a USABILITY addition, not one of the 5 structural hard cases above (the mark-related
  // ones, #2/#3, are already covered by highlight/emphasis/muted) — a deliberate addition beyond the original
  // three-mark set. It bumped SCHEMA_VERSION 1 -> 2.
  underline: {
    inclusive: true,
    parseDOM: [{ tag: "span.fl-underline" }],
    toDOM() { return ["span", { class: "fl-underline" }, 0] as DOMOutputSpec; },
  },
  // Bold/strong (schema v3): plain weight emphasis, the Word/Ctrl+B "B" affordance. Distinct from
  // `emphasis` (bold+underline+box, debate read-stress); `strong` is just heavier weight, and layers
  // freely (NO excludes) over highlight/underline/emphasis/muted — a word can be bold AND highlighted.
  // inclusive:true so it grows as you keep typing. Innermost in the locked render order (rank 4), so the
  // highlight background still wraps a bold span. parseDOM also accepts native <strong>/<b> on paste.
  // NOTE: a USABILITY addition, not one of the 5 structural hard cases above (#2/#3 stay covered by
  // highlight/emphasis/muted) — it bumped SCHEMA_VERSION 2 -> 3.
  strong: {
    inclusive: true,
    parseDOM: [{ tag: "strong" }, { tag: "b" }, { tag: "span.fl-strong" }],
    toDOM() { return ["span", { class: "fl-strong" }, 0] as DOMOutputSpec; },
  },
};

// The single schema instance. Object key order is preserved => mark rank order is
// highlight(0) < emphasis(1) < muted(2) < underline(3) < strong(4), making highlight the outermost
// serialized span and strong the innermost.
export const schema = new Schema({ nodes, marks });

// ── buildCard helper ──────────────────────────────────────────────────────────────────────────
// A single place that assembles a card with the new `paragraph+` body, so callers never hand-wire the
// tag/cite/body child structure (DRY: insertCard/seed migrate onto this). Each body entry becomes one
// paragraph node carrying its own required blockId.

// One body paragraph: a required blockId and optional inline content (text/marks). Empty `content`
// yields an empty-but-valid paragraph (inline* allows zero children).
export interface CardBodyParagraph {
  readonly blockId: string;
  readonly content?: readonly PMNode[];
}

// Arguments for buildCard. `tag`/`cite` inline content is optional (empty => empty inline* child).
// `body` MUST have >=1 entry to satisfy `paragraph+`; passing `body: []` builds a card that
// node.check() REJECTS (the structural teeth of the multi-paragraph body).
export interface BuildCardArgs {
  readonly blockId: string;
  readonly tag?: readonly PMNode[];
  readonly cite?: readonly PMNode[];
  readonly body: readonly CardBodyParagraph[];
}

// Assemble a card node from the given parts. Returns a node that passes node.check() when `blockId`
// is a non-empty id, every body entry has a non-empty blockId, and `body` is non-empty. A `body: []`
// (zero paragraphs) returns a card whose body violates `paragraph+` and is rejected by check().
export function buildCard(args: BuildCardArgs): PMNode {
  const tag = schema.nodes.tag.create(null, args.tag ? [...args.tag] : undefined);
  const cite = schema.nodes.cite.create(null, args.cite ? [...args.cite] : undefined);
  const paragraphs = args.body.map((p) =>
    schema.nodes.paragraph.create({ blockId: p.blockId }, p.content ? [...p.content] : undefined),
  );
  const body = schema.nodes.body.create(null, paragraphs);
  return schema.nodes.card.create({ blockId: args.blockId }, [tag, cite, body]);
}
