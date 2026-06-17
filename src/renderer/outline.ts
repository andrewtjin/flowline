// outline.ts — PURE document → outline derivation (no DOM, no PM mutation).
//
// WHY this is a standalone pure module: the sidebar's "Outline" tab needs a flat, ordered list of
// navigable entries derived from the doc, and the reuse-empty window predicate needs
// a precise "is this doc a fresh Untitled?" test. Both are pure functions of the doc, so they live here —
// unit-testable without jsdom, with NO ProseMirror mutation and NO new dispatch path (the
// caller does the scroll through the existing seam). The outline READS the doc read-only.
//
// INVARIANTS folded in:
//   - Outline entries are ALWAYS keyed by the TOP-LEVEL block's blockId (never a card-body paragraph id),
//     and resolveBlockPos walks top-level blocks first-match-wins (tolerates duplicate ids), mirroring
//     moveBlock's walk (commands.ts ~1023). The click handler NO-OPs when resolveBlockPos returns null.
//   - docIsEmpty is EXACTLY newDoc()'s shape (one child, a paragraph, empty content). NOT childCount===0,
//     NOT a whitespace test on a multi-block doc. isReusable layers dirty/path on top of it.

import type { Node as PMNode } from "prosemirror-model";

// One navigable row in the Outline pane. `tier` drives the indentation hierarchy:
//   0 = pocket heading, 1 = hat heading, 2 = block heading, 3 = card/analytic (a co-level leaf, mirroring the
// Word nav-pane order). `blockId` is ALWAYS the top-level block's id so a click resolves through
// resolveBlockPos. `label` is the human-readable text shown in the pane.
export interface OutlineEntry {
  readonly blockId: string;
  readonly label: string;
  readonly tier: number;
}

// Heading level → outline tier. Mirrors the schema's flat `level` hierarchy (pocket < hat < block); kept as a
// lookup (not a switch) so an unexpected level is caught by the `?? ` fallback rather than silently mis-tiered.
const HEADING_TIER: Record<string, number> = { pocket: 0, hat: 1, block: 2 };

// Card/analytic share a co-level leaf tier beneath the deepest heading (block=2).
const LEAF_TIER = 3;

// How many characters of an analytic's prose to show as its label before eliding. Headings/cards have explicit
// short labels; an analytic is free prose, so we truncate to keep the pane scannable (~60 chars per the spec).
const ANALYTIC_LABEL_MAX = 60;

// buildOutline — walk the TOP-LEVEL blocks in document order and emit one entry per heading/card/analytic.
//
// Order MIRRORS the docx Navigation Pane (document order of top-level blocks). Loose paragraphs produce
// NO entry (they are body continuation prose, not navigation anchors). A card's body paragraphs are NOT walked —
// the entry is the CARD itself, keyed by the card's blockId.
export function buildOutline(doc: PMNode): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  // `doc.forEach` visits only the direct (top-level) children — exactly the blocks moveBlock reorders and the
  // docx nav pane lists. We never descend into a card/heading's content.
  doc.forEach((node) => {
    const blockId = node.attrs.blockId;
    // A top-level block with no string blockId cannot be a navigation target (it can't be resolved back); skip
    // it defensively rather than emit an unclickable row. (In practice every real block carries an id.)
    if (typeof blockId !== "string" || blockId.length === 0) return;

    switch (node.type.name) {
      case "heading": {
        // Heading tier comes from its `level` attr; the `?? LEAF_TIER` guards an unexpected level value.
        const level = typeof node.attrs.level === "string" ? node.attrs.level : "";
        entries.push({ blockId, label: node.textContent, tier: HEADING_TIER[level] ?? LEAF_TIER });
        break;
      }
      case "card": {
        // The card's label is its TAG text (the claim) — the first child is the `tag` node. textContent on the
        // tag gives just the tag's inline text, ignoring cite/body.
        const tagNode = node.childCount > 0 ? node.child(0) : null;
        const label = tagNode ? tagNode.textContent : "";
        entries.push({ blockId, label, tier: LEAF_TIER });
        break;
      }
      case "analytic": {
        // Analytic prose is free text; truncate to keep the pane scannable.
        const text = node.textContent;
        const label = text.length > ANALYTIC_LABEL_MAX ? text.slice(0, ANALYTIC_LABEL_MAX) : text;
        entries.push({ blockId, label, tier: LEAF_TIER });
        break;
      }
      // paragraph (loose, or anything else) — no entry. Loose paragraphs are continuation prose, not anchors.
      default:
        break;
    }
  });
  return entries;
}

// resolveBlockPos — given a top-level block's id, return the document position immediately BEFORE that block
// (the position a caller passes to `doc.resolve(pos)` + `TextSelection.near` to scroll it into view through the
// existing seam). Returns null when no top-level block carries the id.
//
// FIRST-MATCH-WINS: a duplicate blockId can surface (e.g. from an imported document); taking the first
// occurrence keeps navigation deterministic, mirroring moveBlock's walk (commands.ts ~1023). Only TOP-LEVEL blocks are
// considered — a card-body paragraph id will never match here (it is not a top-level block), which is correct
// because OutlineEntry.blockId is always a top-level id.
export function resolveBlockPos(doc: PMNode, blockId: string): number | null {
  let pos: number | null = null;
  doc.forEach((node, offset) => {
    // `offset` is the position before this child (doc.forEach yields the start offset of each top-level node).
    // Guard `pos === null` so the FIRST match wins even if a duplicate id appears later.
    if (pos === null && node.attrs.blockId === blockId) {
      pos = offset;
    }
  });
  return pos;
}

// docIsEmpty — is this doc EXACTLY newDoc()'s output? (one child block, that child a paragraph, with empty
// content.) This is the structural teeth of the reuse-empty window predicate: it is deliberately STRICT
// so a multi-block doc, a doc whose single block is a heading/card, or a paragraph that still holds typed text
// all read as non-empty. NOT childCount===0 (a 0-block doc is a degenerate transient, not a fresh Untitled);
// NOT a whitespace test (an empty paragraph has textContent.length===0 already).
function docIsEmpty(doc: PMNode): boolean {
  if (doc.childCount !== 1) return false;
  const only = doc.child(0);
  return only.type.name === "paragraph" && only.textContent.length === 0;
}

// isReusable — may an existing "Untitled" window be REUSED for a new/open instead of spawning a fresh window?
// True ONLY for a window that is not dirty, has no file path, and whose doc is exactly a
// fresh newDoc(). Any edit (dirty), any saved/opened path, or any real content makes it non-reusable so the
// user's window is never silently repurposed out from under their work.
export function isReusable(doc: PMNode, dirty: boolean, path: string | null): boolean {
  return !dirty && path === null && docIsEmpty(doc);
}
