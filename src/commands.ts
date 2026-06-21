// commands.ts — the mark commands.
//
// Every command here is a ProseMirror `Command`: `(state, dispatch?, view?) => boolean`. When bound to
// a keymap or invoked from the toolbar with `view.dispatch`, the resulting transaction flows through
// the view's `dispatchTransaction` — i.e. through the SINGLE dispatch seam. These commands
// never construct a second EditorView and never call `view.updateState` themselves.
//
// No caret jump: all three commands only ADD or REMOVE marks (or set a stored mark at the
// cursor). They never replace the selection, so ProseMirror maps the existing selection through the
// mark steps unchanged and the caret stays exactly where the user left it.

import { toggleMark } from "prosemirror-commands";
import { TextSelection, NodeSelection, Selection } from "prosemirror-state";
import type { Command, EditorState, Transaction } from "prosemirror-state";
import type { Mark, Node as PMNode, ResolvedPos } from "prosemirror-model";
import { schema, DEFAULT_HIGHLIGHT_COLOR, buildCard } from "./schema";
import type { HighlightColor, HeadingLevel, CardBodyParagraph } from "./schema";
import { structureHost } from "./structure-host";

const highlight = schema.marks.highlight;

// True iff `marks` already carries a highlight of EXACTLY `color`. Written explicitly (rather than
// relying on `Mark.isInSet` attribute-equality) so the add / remove / switch decision is unambiguous.
function hasHighlightColor(marks: readonly Mark[], color: HighlightColor): boolean {
  return marks.some((m) => m.type === highlight && m.attrs.color === color);
}

// Does every text leaf in [from,to] already carry a highlight of exactly `color`? A range with no
// text leaves counts as "not fully highlighted" so the first action adds rather than no-ops.
function rangeFullyHighlighted(state: EditorState, from: number, to: number, color: HighlightColor): boolean {
  let sawText = false;
  let all = true;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isText) {
      sawText = true;
      if (!hasHighlightColor(node.marks, color)) all = false;
    }
  });
  return sawText && all;
}

// Does [from,to] contain any text leaf at all? Used to refuse a no-op highlight on a selection that
// spans only empty blocks (so the Ctrl+H keystroke is reported unhandled rather than silently eaten).
function rangeHasText(state: EditorState, from: number, to: number): boolean {
  let hasText = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isText) hasText = true;
  });
  return hasText;
}

/**
 * Toggle the read-aloud highlighter at `color` (default blue) — the highest-frequency debate action.
 * Three cases, chosen so the colour picker behaves the way a writer expects:
 *  - cursor (empty selection): flip the stored mark, so the next typed run is / isn't highlighted;
 *  - range already fully highlighted in `color`: remove the highlight;
 *  - otherwise: set the whole range to `color`. We `removeMark` then `addMark` so a DIFFERENT existing
 *    colour is cleanly switched (two highlights of different colour can't coexist on a char anyway —
 *    same-type marks exclude each other — but removing first keeps the transaction's intent obvious).
 * Selection is preserved.
 */
export function toggleHighlight(color: HighlightColor = DEFAULT_HIGHLIGHT_COLOR): Command {
  return (state, dispatch) => {
    const sel = state.selection;
    const $cursor = sel instanceof TextSelection ? sel.$cursor : null;
    // Nothing to target (e.g. a node selection with no text run) — let other handlers try.
    if (sel.empty && !$cursor) return false;
    // A non-empty selection with no text leaves (e.g. spanning empty blocks) has nothing to highlight;
    // report not-handled so a no-op transaction doesn't silently swallow the Ctrl+H keystroke.
    if (!$cursor && !sel.ranges.some((r) => rangeHasText(state, r.$from.pos, r.$to.pos))) return false;

    if (dispatch) {
      const tr = state.tr;
      if ($cursor) {
        const stored = state.storedMarks ?? $cursor.marks();
        if (hasHighlightColor(stored, color)) tr.removeStoredMark(highlight);
        else tr.addStoredMark(highlight.create({ color }));
      } else {
        const removeAll = sel.ranges.every((r) =>
          rangeFullyHighlighted(state, r.$from.pos, r.$to.pos, color),
        );
        for (const r of sel.ranges) {
          tr.removeMark(r.$from.pos, r.$to.pos, highlight);
          if (!removeAll) tr.addMark(r.$from.pos, r.$to.pos, highlight.create({ color }));
        }
      }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

// Read-aloud stress (bold + underline + box). Plain `toggleMark`: no attrs, and `excludes:"muted"` in
// the schema means applying emphasis automatically evicts muted — no extra logic needed.
export const toggleEmphasis: Command = toggleMark(schema.marks.emphasis);

// Skip-past "mud" text (small font). `excludes:"emphasis"` evicts emphasis symmetrically. inclusive
// is false in the schema, so the mark does NOT grow when you type at its right edge.
export const toggleMuted: Command = toggleMark(schema.marks.muted);

// Read-aloud underline (schema v2) — the plain "read this" marker, distinct from emphasis (bold+ul+box).
// Plain `toggleMark`: no attrs, no excludes, so it layers freely over highlight/emphasis/muted.
export const toggleUnderline: Command = toggleMark(schema.marks.underline);

// Bold/strong (schema v3) — the Word/Ctrl+B "B" affordance. Plain `toggleMark`: no attrs, no excludes,
// so it layers freely over highlight/underline/emphasis/muted (a word can be bold AND highlighted).
export const toggleStrong: Command = toggleMark(schema.marks.strong);

// Citation/source (schema v5) — the "Cite" button / F8. Plain `toggleMark` on the cite mark: it applies the
// bold, full-size cite style to ONLY the current selection, or — at a bare caret — sets a stored mark so the
// next typed run is cite-styled. NO card is created: cite is an inline mark now, not a structural card child.
export const toggleCite: Command = toggleMark(schema.marks.cite);

// The six inline marks Clear (F12) removes. Listed explicitly (not derived from schema.marks) so the
// set is auditable and a future mark isn't silently swept up. highlight first to match render order; cite last.
const CLEARABLE_MARKS = [
  schema.marks.highlight,
  schema.marks.emphasis,
  schema.marks.muted,
  schema.marks.underline,
  schema.marks.strong,
  schema.marks.cite,
];

/**
 * The byte-identical mark-strip shared by clearMarks and clearFormatting: at a bare cursor it clears the
 * stored marks (so the next typed run is plain), otherwise it removes every CLEARABLE_MARK across each
 * selection range. Mutates `tr` in place; callers own the gating decision and the dispatch. Factored out so
 * the two Clear commands cannot drift in WHICH marks they strip or HOW — only their gating/structural steps
 * (intentionally) differ. `$cursor` is the caller's already-resolved `sel.$cursor` (null for a non-text or
 * non-empty selection); passing it in keeps this helper from re-deriving it and matching clearMarks exactly.
 */
function stripClearableMarks(tr: Transaction, sel: Selection, $cursor: ResolvedPos | null): void {
  if (sel.empty) {
    if ($cursor) for (const m of CLEARABLE_MARKS) tr.removeStoredMark(m);
  } else {
    for (const r of sel.ranges) for (const m of CLEARABLE_MARKS) tr.removeMark(r.$from.pos, r.$to.pos, m);
  }
}

/**
 * clearMarks (F12 / the "Clear" button) — strip every inline mark from the target, leaving the
 * text and block structure untouched. Two cases, mirroring the toggle commands:
 *  - cursor (empty selection): clear the stored marks so the next typed run is plain. Reported handled
 *    (true) only when there was actually a stored/cursor mark to clear, so an unmarked caret lets the
 *    F12 keystroke fall through rather than being silently eaten.
 *  - non-empty selection: remove all CLEARABLE_MARKS across every selected range. Selection is preserved.
 * Never touches block nodes (no blockId churn), so it is safe on any selection shape.
 */
export const clearMarks: Command = (state, dispatch) => {
  const sel = state.selection;
  const $cursor = sel instanceof TextSelection ? sel.$cursor : null;

  if (sel.empty) {
    if (!$cursor) return false; // node selection with no text run — let other handlers try
    const marks = state.storedMarks ?? $cursor.marks();
    if (marks.length === 0) return false; // nothing to clear — don't swallow the keystroke
    if (dispatch) {
      const tr = state.tr;
      stripClearableMarks(tr, sel, $cursor); // cursor branch: clears stored marks (no scrollIntoView, as before)
      dispatch(tr);
    }
    return true;
  }

  if (dispatch) {
    const tr = state.tr;
    stripClearableMarks(tr, sel, $cursor); // range branch: $cursor is null, so this strips across the ranges
    dispatch(tr.scrollIntoView());
  }
  return true;
};

// ── Block commands ─────────────────────────────────────────────────────────────────────────────
//
// Design constraint shared by every command below: all four top-level blocks (card/analytic/heading/
// paragraph) are ISOLATING with a REQUIRED, stable `blockId`, and `card` is a fixed `tag body`.
// So NO command here ever splits or merges a block — splitting would have to mint a new blockId and
// decide which half keeps the old one, and a card's children can't be split sanely. Instead:
//   - structural change = create a brand-new sibling block (fresh blockId) or destroy+recreate one;
//   - everything else stays at the INLINE level inside the current container.
// This is what makes "Enter never crosses an isolating boundary" and "Backspace never merges
// two isolating blocks / deletes a required child" true by construction rather than by luck.

const hard_break = schema.nodes.hard_break;
// Card construction goes through `buildCard` (schema.ts), which wires the tag/body children — but the
// unified card-line split needs the `tag` TYPE to identify when the caret sits in the card's claim line,
// so it is pulled here alongside the block types this module touches directly.
const { paragraph, analytic, heading, card, body, tag } = schema.nodes;

/** Mint a fresh block id through the StructureHost predicate surface (clean implementation; never a node-name string). */
const freshBlockId = (): string => structureHost.structure.newUnitId();

/**
 * Absolute position at which a new sibling block should be inserted: directly AFTER the depth-1
 * top-level block that contains `$from`. `$from.after(1)` is that boundary for a caret anywhere inside
 * a top-level block OR inside a card child (depth 2) — in both cases depth-1 is the isolating block, so
 * the new block always lands as its sibling, never inside an isolating boundary. Falls back to the raw
 * position only for the degenerate depth-0 case (an empty doc with the selection at the doc level).
 */
function siblingInsertPos(state: EditorState): number {
  const { $from } = state.selection;
  return $from.depth >= 1 ? $from.after(1) : $from.pos;
}

/**
 * Is the resolved position the content of a card-BODY paragraph? A body paragraph lives at
 * depth 3 — doc(0) > card(1) > body(2) > paragraph(3) — so its parent is a `paragraph` whose grandparent
 * is a `body`. A TOP-LEVEL paragraph (depth 1) has `doc` as its grandparent, so this is false for it.
 * Used by Enter/Backspace to keep body edits INSIDE the card's `paragraph+` body instead of escaping it.
 */
function inBodyParagraph($pos: ResolvedPos): boolean {
  return $pos.depth === 3 && $pos.parent.type === paragraph && $pos.node(2).type === body;
}

/**
 * Enter — context-aware, and deliberately NEVER an isolating-boundary split:
 *  - collapsed caret at the END of a card BODY paragraph → SPLIT into a new paragraph WITHIN the body
 *    (fresh blockId), so a multi-paragraph card body grows in place and the caret never escapes the card;
 *  - collapsed caret at the END of a top-level `heading` / `paragraph` → new `paragraph` sibling;
 *  - collapsed caret ANYWHERE in an `analytic` → SPLIT into TWO separate analytic blocks at the caret:
 *    each half is its own isolating block with its own blockId, so a run of argument prose becomes
 *    independently-editable analytic lines (Clear/restyle hits exactly one). At END this is observably the
 *    same as a new analytic sibling; at START/MID the content divides across the two blocks;
 *  - collapsed caret inside a card `tag`, inside a body paragraph MID-inline, or anywhere else
 *    MID-inline → a `hard_break` (soft line break) inside the current container — the `tag` never spawns
 *    a sibling, and a mid-body-paragraph break stays inside the card (you stay where you are);
 *  - a non-empty selection within ONE textblock → replace it with a `hard_break`;
 *  - a selection spanning textblocks (e.g. tag→body in a card) → swallowed, so the key can never
 *    collapse a required-child / isolating boundary.
 * Every path returns true (Enter is fully owned here; baseKeymap's splitBlock must never run on these
 * isolating blocks). New blocks carry a fresh blockId and the caret lands inside the new block.
 */
export const enter: Command = (state, dispatch) => {
  const sel = state.selection;

  if (sel.empty && sel instanceof TextSelection && sel.$cursor) {
    const $cursor = sel.$cursor;
    const atEnd = $cursor.parentOffset === $cursor.parent.content.size;

    // A caret in a card BODY paragraph is handled FIRST, before the generic paragraph rule below
    // (whose `container === "paragraph"` would otherwise match a body paragraph too and wrongly spawn a
    // sibling AFTER the card — escaping the isolating boundary). At the END of a body paragraph, SPLIT it
    // into a new body paragraph WITHIN the same body so the caret never leaves the card. We OWN the split
    // because base `splitBlock` returns false inside a `paragraph+` container: tr.split mints
    // the AFTER paragraph with a fresh blockId; the BEFORE paragraph keeps its id. A mid-/start-inline
    // caret falls through to the shared hard_break path (Enter only ever SPLITS at end-of-paragraph, same
    // as a top-level paragraph), so it stays inside the body too.
    if (inBodyParagraph($cursor)) {
      if (atEnd) {
        if (dispatch) {
          const tr = state.tr.split($cursor.pos, 1, [{ type: paragraph, attrs: { blockId: freshBlockId() } }]);
          // After a split at `$cursor.pos`, the new paragraph opens at pos+1; its content starts at pos+2.
          tr.setSelection(TextSelection.create(tr.doc, $cursor.pos + 2));
          dispatch(tr.scrollIntoView());
        }
        return true;
      }
      // mid-/start-inline inside a body paragraph → soft line break (never escapes the card).
      if (dispatch) dispatch(state.tr.replaceSelectionWith(hard_break.create()).scrollIntoView());
      return true;
    }

    // An analytic is OWNED here, BEFORE the generic `spawns` rule, and Enter ALWAYS SPLITS it into
    // TWO separate analytic blocks at the caret — never a soft hard_break inside one block. Each half is a
    // real isolating analytic with its own blockId, so per-block actions (Clear/F12, restyle) hit exactly
    // one line, not a run of soft-broken lines sharing a single blockId. This mirrors the card-body split
    // above (tr.split mints the AFTER block with a fresh id; the BEFORE block keeps the source id):
    //   - at START  → an empty analytic above, the content stays below with the caret on it;
    //   - at END    → an empty analytic below with the caret in it (same observable as a new end sibling);
    //   - mid       → the content is divided across the two analytics.
    // We split with depth 1 (the analytic itself); the depth-0 doc boundary is never crossed (analytic is
    // isolating, but a split at depth 1 stays inside `doc`'s `block*`, producing two sibling blocks).
    if ($cursor.parent.type === analytic) {
      if (dispatch) {
        const tr = state.tr.split($cursor.pos, 1, [{ type: analytic, attrs: { blockId: freshBlockId() } }]);
        // After a split at `$cursor.pos`, the new analytic opens at pos+1; its content starts at pos+2.
        tr.setSelection(TextSelection.create(tr.doc, $cursor.pos + 2));
        dispatch(tr.scrollIntoView());
      }
      return true;
    }

    // A collapsed caret at the END of a card TAG → move the caret INTO the start of the card's first body
    // paragraph (do NOT insert a hard_break — the old fallback rendered a <br> inside the tag that read as a
    // second tag line). The schema's `card = "tag body"` with `body = "paragraph+"` guarantees a first body
    // paragraph always exists, so this is always a valid target. We resolve it from the CARD node rather than by
    // hand-counting tokens: the card opens at `$cursor.before(1)`; its first body paragraph's content begins one
    // token inside the body, which itself begins one token after the tag closes. Compute that position from the
    // node sizes (tag size + the body + paragraph open tokens) and snap with TextSelection.near so an EMPTY first
    // body paragraph still lands a valid caret. No split, no spawn, no break — just a caret move.
    if (atEnd && $cursor.parent.type === tag && $cursor.node(1).type === card) {
      if (dispatch) {
        const cardNode = $cursor.node(1);
        const cardPos = $cursor.before(1); // position just before the card's open token
        const tagNode = cardNode.child(0); // child 0 is the tag (card = "tag body")
        // From cardPos: +1 enters the card (tag open), + tagNode.nodeSize skips the whole tag node, +1 enters the
        // body (body open), +1 enters the first body paragraph (paragraph open) → its content-start position.
        const target = cardPos + 1 + tagNode.nodeSize + 1 + 1;
        const tr = state.tr;
        tr.setSelection(TextSelection.near(tr.doc.resolve(target), 1));
        dispatch(tr.scrollIntoView());
      }
      return true;
    }

    const container = $cursor.parent.type.name;
    // tag is intentionally absent: a caret in a card's tag never spawns a sibling block.
    // analytic is intentionally absent too: it is fully owned by the explicit SPLIT branch above.
    const spawns = atEnd && (container === "paragraph" || container === "heading");
    if (spawns) {
      if (dispatch) {
        // heading and paragraph both spawn a plain `paragraph` sibling (a heading's "normal style" next
        // line). analytic never reaches here — it SPLITS in the dedicated branch above.
        const at = $cursor.after(1); // after the depth-1 top-level isolating block
        const tr = state.tr.insert(at, paragraph.create({ blockId: freshBlockId() }));
        tr.setSelection(TextSelection.create(tr.doc, at + 1)); // caret inside the new empty block
        dispatch(tr.scrollIntoView());
      }
      return true;
    }
    // mid-inline collapsed caret, or inside the tag → soft line break at the cursor.
    if (dispatch) dispatch(state.tr.replaceSelectionWith(hard_break.create()).scrollIntoView());
    return true;
  }

  // Non-empty selection inside one textblock → replace with a hard_break (the selected text is removed,
  // a break takes its place). Anything wider is swallowed so no isolating/required boundary collapses.
  if (!sel.empty && sel.$from.sameParent(sel.$to) && sel.$from.parent.isTextblock) {
    if (dispatch) dispatch(state.tr.replaceSelectionWith(hard_break.create()).scrollIntoView());
    return true;
  }
  return true; // swallow every other shape — never cross an isolating boundary
};

/**
 * Backspace — keeps every deletion at the inline level and refuses any isolating merge:
 *  - non-empty selection within one textblock → delete it; a cross-textblock selection is swallowed
 *    (deleting across a card's required children is never allowed);
 *  - collapsed caret at the START of a card BODY paragraph that is NOT the first → JOIN it with the
 *    previous body paragraph (a within-body merge; both ends stay inside the same `paragraph+` body). At
 *    the FIRST body paragraph it is a NO-OP (a join would pull content toward the `tag` / threaten the card);
 *  - collapsed caret at the very START of a top-level textblock → NO-OP (a join here would merge two
 *    isolating blocks or delete a required card child — forbidden), EXCEPT the blank-line removal below;
 *  - a `hard_break` immediately before the caret → delete it (joins the two inline lines);
 *  - an ordinary character before the caret → return false, letting the browser delete it so multi-unit
 *    graphemes are handled correctly (the structural invariants above are what this command guarantees).
 */
export const backspace: Command = (state, dispatch) => {
  const sel = state.selection;

  if (!sel.empty) {
    // Only an inline range INSIDE one textblock is a safe delete. A NodeSelection or a single-block
    // AllSelection ALSO satisfies `sameParent` (both ends resolve with the doc as their parent), so we
    // must additionally require a real textblock parent — exactly the guard `enter` uses — or
    // `deleteSelection()` would wipe a whole isolating block / a card's required tag·body. Every
    // other selection shape (node / all / cross-textblock) is swallowed.
    if (sel instanceof TextSelection && sel.$from.sameParent(sel.$to) && sel.$from.parent.isTextblock) {
      if (dispatch) dispatch(state.tr.deleteSelection().scrollIntoView());
      return true;
    }
    return true; // node / all / cross-textblock selection → swallow (never delete a required child)
  }

  const $cursor = sel instanceof TextSelection ? sel.$cursor : null;
  if (!$cursor) return true; // non-text (e.g. node) selection → swallow

  if ($cursor.parentOffset === 0) {
    // A caret at the START of a card BODY paragraph is handled FIRST. If this is NOT the first body
    // paragraph, JOIN it with the previous body paragraph (a within-body merge — both ends stay inside the
    // same `paragraph+` body, never crossing the card's isolating boundary and never touching the tag). If
    // it IS the first body paragraph, NO-OP: a join would pull content up into the `tag` (a different required
    // child) or, at depth, threaten the card — both forbidden. The deletion of the card itself is likewise
    // never reachable here.
    if (inBodyParagraph($cursor)) {
      if ($cursor.index(2) > 0) {
        if (dispatch) {
          const joinPos = $cursor.before(); // open token of this body paragraph = the seam to join across
          const tr = state.tr.join(joinPos);
          // After the join, the merge seam (end of the previous paragraph's original content) is joinPos-1.
          tr.setSelection(TextSelection.near(tr.doc.resolve(joinPos - 1)));
          dispatch(tr.scrollIntoView());
        }
        return true;
      }
      return true; // first body paragraph → no-op (never merge into the tag / destroy the card)
    }

    // At the very start of a textblock. The general rule is no-op (a join here would merge two
    // isolating blocks or delete a required card child). EXCEPTION: a blank line — an EMPTY
    // TOP-LEVEL block (depth 1: analytic/heading/paragraph; never a depth-2 card child) — is removed,
    // landing the caret at the end of the previous block. This deletes an empty, non-required block and
    // moves NO content across an isolating boundary, so the invariant holds.
    const emptyTopLevelBlock = $cursor.depth === 1 && $cursor.parent.content.size === 0;
    if (emptyTopLevelBlock && $cursor.index(0) > 0) {
      if (dispatch) {
        const start = $cursor.before(1); // boundary just before this empty block (= after the previous)
        const tr = state.tr.delete(start, start + $cursor.parent.nodeSize);
        // end of the previous block's content sits at start-1, unaffected by a deletion at `start`.
        tr.setSelection(TextSelection.near(tr.doc.resolve(start - 1), -1));
        dispatch(tr.scrollIntoView());
      }
      return true;
    }
    return true; // otherwise no-op — never merge isolating blocks / delete a required child
  }

  const before = $cursor.nodeBefore;
  if (before && before.type === hard_break) {
    if (dispatch) dispatch(state.tr.delete($cursor.pos - 1, $cursor.pos).scrollIntoView());
    return true;
  }
  return false; // ordinary character → let the browser delete it (correct grapheme handling)
};

/**
 * insertCard (Mod-Enter) — build a complete `tag body` card with a fresh blockId in ONE transaction,
 * inserted as the next sibling, caret landing in the empty tag. One tr keeps the create atomic (a card
 * never appears half-built).
 *
 * body is `paragraph+`, so the card is seeded with EXACTLY ONE empty body paragraph (its own fresh blockId)
 * via `buildCard` — an inline/empty body would violate the schema and be rejected by check(). The tag is
 * empty, 2-wide, and comes first, so the tag content sits at at+2 regardless of how the body after it is
 * shaped. (Token stream from the card open at `at`: <card> tag </tag> <body> <p> </p> </body> </card>
 *  → at+2 is inside the empty tag.) The source/cite line is no longer a card child — it is the `cite` mark
 * (toggleCite, below), applied inline; so there is no "caret in cite" variant anymore.
 */
export const insertCard: Command = (state, dispatch) => {
  if (dispatch) {
    const at = siblingInsertPos(state);
    const node = buildCard({ blockId: freshBlockId(), body: [{ blockId: freshBlockId() }] });
    const tr = state.tr.insert(at, node);
    tr.setSelection(TextSelection.create(tr.doc, at + 2));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

// Shared body for the single-textblock inserts (analytic/heading/paragraph): insert a fresh empty block
// of `type` as the next sibling, caret inside it (content start = at + 1).
function insertSimpleBlock(make: (blockId: string) => PMNode): Command {
  return (state, dispatch) => {
    if (dispatch) {
      const at = siblingInsertPos(state);
      const tr = state.tr.insert(at, make(freshBlockId()));
      tr.setSelection(TextSelection.create(tr.doc, at + 1));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** insertAnalytic — a fresh empty analytic sibling. */
export const insertAnalytic: Command = insertSimpleBlock((blockId) => analytic.create({ blockId }));
/** insertParagraph — a fresh empty paragraph sibling. */
export const insertParagraph: Command = insertSimpleBlock((blockId) => paragraph.create({ blockId }));
/** insertHeading(level) — a fresh empty heading sibling at the given level. */
export function insertHeading(level: HeadingLevel): Command {
  return insertSimpleBlock((blockId) => heading.create({ blockId, level }));
}

// ── Structural restyle core ──────────────────────────────────────────────────────────────────
//
// setHeadingLevel and convertToAnalytic share ONE engine. They differ only in (a) what they restyle a
// convertible top-level block INTO and (b) what they do when the SINGLE target is a card (dissolve vs
// refuse). The engine resolves the target the same way for both, and converts EVERY top-level
// block the selection touches, not just one.

/** A convertible top-level block is paragraph / heading / analytic (NOT a card or a card child). */
function isConvertibleTopLevel(node: PMNode): boolean {
  return node.type === paragraph || node.type === heading || node.type === analytic;
}

/**
 * The resolved target of a structural-restyle command, derived from the selection:
 *  - "single": the selection touches exactly ONE top-level block (a caret, a selection contained in one
 *    block, or a NodeSelection on a top-level block). `block`/`pos` identify it. The single case is the
 *    only one that may dissolve a card — multi-block selections leave cards intact.
 *  - "range": the selection spans ≥2 top-level blocks ([fromIndex..toIndex] inclusive). Every convertible
 *    block in the span is restyled; cards in the span are skipped.
 *  - null: no actionable target (e.g. an AllSelection that pins no single block, a NodeSelection on a card
 *    CHILD — which must NOT dissolve the whole card — or an empty doc).
 */
type RestyleTarget =
  | { kind: "single"; block: PMNode; index: number; pos: number }
  | { kind: "range"; fromIndex: number; toIndex: number };

/** Start position (doc coordinate just before) the top-level block at `index`. */
function topLevelStart(doc: PMNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
}

/**
 * Resolve which top-level block(s) a structural-restyle command targets. Mirrors moveCurrentBlock for the
 * single/NodeSelection cases, then adds the multi-block span.
 *
 * A NodeSelection is only treated as a single target when its selected node is a
 * TOP-LEVEL block (`$from.depth === 0`). A NodeSelection on a card CHILD (depth > 0, e.g. a body paragraph)
 * returns null so it can never dissolve the whole card — an ambiguous child gesture must not nuke the unit.
 */
function resolveRestyleTarget(state: EditorState): RestyleTarget | null {
  const sel = state.selection;

  // A node-selected TOP-LEVEL block is an unambiguous single target.
  if (sel instanceof NodeSelection) {
    if (sel.$from.depth === 0) {
      return { kind: "single", block: sel.node, index: sel.$from.index(0), pos: sel.from };
    }
    return null; // NodeSelection on a card child → no whole-card dissolve (fall through to nothing)
  }

  // Otherwise work from the inline range. Map the selection's endpoints to the indices of the first and
  // last TOP-LEVEL blocks they touch (a caret has from === to, so both land on the same block).
  const doc = state.doc;
  if (doc.childCount === 0) return null;
  const $from = sel.$from;
  const $to = sel.$to;
  if ($from.depth < 1) return null; // selection sits at the doc level (degenerate) — nothing to target
  const fromIndex = $from.index(0);
  const toIndex = $to.depth >= 1 ? $to.index(0) : fromIndex;

  if (fromIndex === toIndex) {
    return { kind: "single", block: doc.child(fromIndex), index: fromIndex, pos: topLevelStart(doc, fromIndex) };
  }
  return { kind: "range", fromIndex, toIndex };
}

/** The new (type, attrs) a convertible block should take on, computed from the source block. */
type RestyleSpec = { type: PMNode["type"]; attrs: Record<string, unknown> };

/**
 * Restyle every convertible top-level block in [fromIndex..toIndex] to the (type, attrs) produced by
 * `spec`, skipping cards (left intact) and any other non-convertible block. Uses `tr.setNodeMarkup`, which
 * changes a block's TYPE/ATTRS IN PLACE while leaving its content — and therefore every inner position —
 * untouched (the same mechanism prosemirror-commands' setBlockType uses). Because positions are stable, the
 * order of the per-block markups is irrelevant and the user's selection survives verbatim (no remap needed:
 * a caret stays exactly put; a multi-block selection still spans the now-restyled blocks). content is
 * `inline*` for every type involved, so it transfers without re-wrapping. Returns true iff ≥1 block changed.
 */
function restyleRange(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  fromIndex: number,
  toIndex: number,
  spec: (block: PMNode) => RestyleSpec,
): boolean {
  const doc = state.doc;
  // Collect convertible blocks with their start positions (the position just before each block's open).
  const targets: { start: number; node: PMNode }[] = [];
  let start = topLevelStart(doc, fromIndex);
  for (let i = fromIndex; i <= toIndex; i++) {
    const node = doc.child(i);
    if (isConvertibleTopLevel(node)) targets.push({ start, node });
    start += node.nodeSize;
  }
  if (targets.length === 0) return false; // nothing convertible in the span (e.g. all cards)

  if (dispatch) {
    const tr = state.tr;
    for (const { start: s, node } of targets) {
      const { type, attrs } = spec(node);
      tr.setNodeMarkup(s, type, attrs); // in-place type/attrs change; content + inner positions preserved
    }
    // setNodeMarkup keeps content positions stable, but mapping an endpoint that sat exactly on a block's
    // content boundary can momentarily resolve at the doc level; re-anchor via TextSelection.between, which
    // snaps each endpoint back to the nearest valid inline position (a caret stays put).
    reanchorSelection(tr, state.selection.from, state.selection.to);
    dispatch(tr.scrollIntoView());
  }
  return true;
}

/**
 * Re-point a transaction's selection at the mapped [from,to], snapped to valid inline positions. Used after
 * in-place block-type rewrites (setNodeMarkup) so a selection that touched a content boundary never resolves
 * at the doc level (which ProseMirror warns about). TextSelection.between searches outward for a usable text
 * position, so a caret (from === to) lands cleanly and a range stays over the rewritten blocks.
 */
function reanchorSelection(tr: Transaction, from: number, to: number): void {
  const $from = tr.doc.resolve(tr.mapping.map(from));
  const $to = tr.doc.resolve(tr.mapping.map(to));
  // TextSelection.between searches outward for a usable endpoint — and PM's dev build logs a warning when an
  // endpoint resolves into a node WITHOUT inline content (e.g. the card/body level, which happens when a
  // selection-spanning restyle leaves an endpoint inside a card that was NOT restyled). Use .between only when
  // both endpoints already sit in inline content (the common case: a range over the rewritten blocks, or a
  // caret); otherwise snap to the nearest valid inline position with .near (silent), preferring whichever
  // endpoint is itself inline. The final selection is valid either way — this only avoids the dev-noise warning.
  if ($from.parent.inlineContent && $to.parent.inlineContent) {
    tr.setSelection(TextSelection.between($from, $to));
  } else {
    tr.setSelection(TextSelection.near($from.parent.inlineContent ? $from : $to));
  }
}

/**
 * dissolveCardTo — eject a card, in doc order: the tag content → a `heading[level]` with a FRESH blockId;
 * then each body paragraph → a top-level `paragraph` KEEPING its blockId (a card-body paragraph and a
 * top-level paragraph are the SAME node type, so the node object is RELOCATED as-is — id + content + marks
 * preserved — exactly like splitCardAtBody's trailing-paragraph reuse). The tag is an INTERIOR node with no
 * blockId, so the heading minted from it gets a fresh id; only the body paragraphs carry their own blockId, so
 * only they keep theirs. ONE replaceWith; caret lands in the new heading. This is the inverse of convertToTag and
 * the ONLY path that touches a structured card here — and it preserves every piece of the card's content
 * (any cite-marked source text rides along inside the body), so no required child is silently destroyed.
 */
function dissolveCardTo(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  cardNode: PMNode,
  pos: number,
  level: HeadingLevel,
): boolean {
  if (dispatch) {
    const tagNode = cardNode.child(0);
    const bodyNode = cardNode.child(1);
    const out: PMNode[] = [heading.create({ blockId: freshBlockId(), level }, tagNode.content)];
    // Each body paragraph is RELOCATED as a top-level paragraph: the node object is reused verbatim so its
    // blockId (and content + marks) carries onto the ejected top-level paragraph — minting a fresh id here
    // would lose the relocated block's blockId (the card-line-split contract / structural move shape).
    bodyNode.forEach((p) => out.push(p));
    const tr = state.tr.replaceWith(pos, pos + cardNode.nodeSize, out);
    // caret into the new heading's content (heading opens at `pos`, content starts at pos+1).
    tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)));
    dispatch(tr.scrollIntoView());
  }
  return true;
}

/**
 * The line a structural-restyle gesture targets INSIDE a single card, for the unified card-split. A
 * card's children, in doc order, are [tag, body0, body1, ...]; the user's caret/selection identifies
 * exactly one of them as the SELECTED LINE `L`:
 *   - "tag":  L is the tag (depth 2: doc>card>tag);
 *   - "body": L is a body paragraph at `bodyIndex` (depth 3: doc>card>body>paragraph).
 * The whole card and its doc position are carried so the caller can replace it in one step.
 */
type CardLine =
  | { card: PMNode; cardPos: number; line: "tag" }
  | { card: PMNode; cardPos: number; line: "body"; bodyIndex: number };

/**
 * resolveCardLine — detect a TextSelection caret/selection contained entirely within ONE child of ONE
 * card, and report which child (tag / a specific body paragraph). Returns null for anything that is
 * NOT a clean single-line target so the existing guards are preserved:
 *   - a NodeSelection or AllSelection (never splits — the NodeSelection-on-card-child guard and the
 *     node-selected-whole-card dissolve path stay owned by resolveRestyleTarget);
 *   - a selection that spills across two card children (e.g. tag→body) — `sameParent` fails;
 *   - a caret outside any card.
 * cardPos is `$from.before(1)` (the position just before the card's open token). The tag lives at depth 2
 * with the card as `$from.node(1)`; a body paragraph lives at depth 3 (detected by `inBodyParagraph`) with
 * the card at `$from.node(1)` and its body index at `$from.index(2)`.
 */
function resolveCardLine(state: EditorState): CardLine | null {
  const sel = state.selection;
  if (!(sel instanceof TextSelection)) return null; // node / all selections never split (guards stay)
  const $from = sel.$from;
  if (!$from.sameParent(sel.$to)) return null; // a selection spilling across card children never splits

  // A body paragraph (depth 3) — the most specific case, checked first.
  if (inBodyParagraph($from)) {
    const cardNode = $from.node(1);
    if (cardNode.type !== card) return null; // defensive: inBodyParagraph already implies a card grandparent
    return { card: cardNode, cardPos: $from.before(1), line: "body", bodyIndex: $from.index(2) };
  }

  // The tag (depth 2: doc>card>tag). The parent IS the tag; its parent is the card. (The body wrapper holds
  // no inline content, so a depth-2 text caret inside a card can only be the tag.)
  if ($from.depth === 2 && $from.node(1).type === card && $from.parent.type === tag) {
    return { card: $from.node(1), cardPos: $from.before(1), line: "tag" };
  }
  return null; // caret outside any card child (or in the body wrapper itself, which holds no text)
}

/**
 * splitCardAtLine — the unified "the SELECTED line becomes the heading, everything below it ejects out
 * of the card" operation. Given the resolved `CardLine`, it builds the doc-order output array and replaces the
 * WHOLE card in ONE replaceWith; the caret lands in the new heading's content. The output depends on which
 * line `L` is (card children, in order, are [tag, body0, body1, ...]):
 *
 *   L = body[k], k ≥ 1   → FRONT-CARD SPLIT: keep [tag, body0..body(k-1)] as the front card (its blockId
 *                          preserved); body[k] → heading[level] keeping body[k]'s id; body[k+1..] →
 *                          top-level paragraphs keeping their ids. (The front card is `paragraph+`-valid
 *                          because k ≥ 1 leaves ≥1 preceding body paragraph.)
 *   L = body[0]          → tag content → a top-level paragraph (fresh id); body0 → heading[level] keeping
 *                          body0's id; body1.. → top-level paragraphs keeping ids. (The whole card is
 *                          consumed — no front card.)
 *   L = tag              → tag content → heading[level] (fresh id); every body paragraph → a top-level
 *                          paragraph keeping its id. (This equals the legacy dissolveCardTo, reused below.)
 *
 * Identity rules: body paragraphs are RELOCATED (node objects reused; ids + content preserved). The tag is an
 * INTERIOR node with NO blockId, so any block minted FROM it gets a FRESH id. The selected body paragraph's
 * id carries onto its heading. No blockId is ever duplicated, because each source line appears in exactly one
 * output block. Every output node is node.check()-valid.
 */
function splitCardAtLine(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  target: CardLine,
  level: HeadingLevel,
): boolean {
  const cardNode = target.card;
  const cardPos = target.cardPos;

  // The body[k≥1] case keeps a FRONT card, so it is handled on its own path; every other case consumes the
  // whole card into a flat top-level array.
  if (target.line === "body" && target.bodyIndex >= 1) {
    if (dispatch) {
      const tagNode = cardNode.child(0);
      const bodyNode = cardNode.child(1);

      // Preceding body paragraphs [0 .. k-1] stay in the front card (node objects reused → ids + content kept).
      // bodyIndex ≥ 1 ⇒ this is non-empty, so the front card is `paragraph+`-valid.
      const preceding: PMNode[] = [];
      for (let i = 0; i < target.bodyIndex; i++) preceding.push(bodyNode.child(i));
      const frontCard = card.create({ blockId: cardNode.attrs.blockId }, [
        tagNode,
        body.create(null, preceding),
      ]);

      // The targeted paragraph → a heading at `level`, same id + inline content.
      const targetPara = bodyNode.child(target.bodyIndex);
      const newHeading = heading.create({ blockId: targetPara.attrs.blockId, level }, targetPara.content);

      // Trailing body paragraphs [k+1 ..] → floating top-level paragraphs (a body paragraph and a top-level
      // paragraph are the SAME node type, so the node objects are reused as-is; ids + content preserved).
      const trailing: PMNode[] = [];
      for (let i = target.bodyIndex + 1; i < bodyNode.childCount; i++) trailing.push(bodyNode.child(i));

      const tr = state.tr.replaceWith(cardPos, cardPos + cardNode.nodeSize, [frontCard, newHeading, ...trailing]);
      // The heading opens right after the front card; its content starts +1 — drop the caret there.
      tr.setSelection(TextSelection.near(tr.doc.resolve(cardPos + frontCard.nodeSize + 1)));
      dispatch(tr.scrollIntoView());
    }
    return true;
  }

  // The tag case is exactly the legacy whole-card dissolve (tag→heading, each body paragraph→paragraph;
  // fresh id for the tag-derived heading). Reuse it to stay DRY.
  if (target.line === "tag") {
    return dissolveCardTo(state, dispatch, cardNode, cardPos, level);
  }

  // The only remaining target is `body` with bodyIndex 0 (tag is handled above; the body[k≥1] front-card
  // split is handled above): body0 becomes the heading and the whole card is consumed (no front card).
  if (dispatch) {
    const tagNode = cardNode.child(0);
    const bodyNode = cardNode.child(1);
    // tag ejects first (fresh-id paragraph), then body0 → heading (its id kept), then body1.. eject (ids kept).
    const out: PMNode[] = [paragraph.create({ blockId: freshBlockId() }, tagNode.content)];
    const body0 = bodyNode.child(0);
    const headingIndex = out.length;
    out.push(heading.create({ blockId: body0.attrs.blockId, level }, body0.content));
    for (let i = 1; i < bodyNode.childCount; i++) out.push(bodyNode.child(i));

    const tr = state.tr.replaceWith(cardPos, cardPos + cardNode.nodeSize, out);
    // Sum the sizes of every output block BEFORE the heading to find its open position; its content starts +1.
    let headingPos = cardPos;
    for (let i = 0; i < headingIndex; i++) headingPos += out[i].nodeSize;
    tr.setSelection(TextSelection.near(tr.doc.resolve(headingPos + 1)));
    dispatch(tr.scrollIntoView());
  }
  return true;
}

/**
 * setHeadingLevel(level) — dissolve-card, selection-spanning, unified card-line split combined; backs
 * the pocket/hat/block style buttons. Behaviour by target:
 *
 *  - Caret / selection inside ONE card child → the SELECTED LINE becomes the heading and everything
 *    BELOW it in the card ejects out as top-level paragraphs, in doc order. The selected line may be the tag
 *    or any body paragraph; blockIds are preserved (body paragraphs keep their ids; the tag-derived heading
 *    gets a fresh id). One transaction; the caret lands in the new heading. This is checked FIRST so a caret
 *    in tag/body0 promotes that exact line rather than always making the TAG the heading. The body[k≥1]
 *    front-card split is one sub-case of this.
 *  - SINGLE target is a NODE-SELECTED whole CARD → DISSOLVE it (the tag becomes the heading; every body
 *    paragraph ejects; fresh id for the tag-derived heading). A node selection never enters resolveCardLine,
 *    so this whole-card path is preserved unchanged.
 *  - SINGLE target is a convertible top-level analytic/heading/paragraph → restyle it INTO a `heading` at
 *    `level`, PRESERVING the blockId (same unit, restyled). An already-heading-at-this-level is idempotent.
 *  - RANGE (selection spanning ≥2 top-level blocks) → restyle EVERY convertible block the selection
 *    touches into a `heading` at `level` in ONE transaction; cards in the span are SKIPPED (left intact),
 *    never dissolved — only the single-line/whole-card case touches a card.
 *
 * No-op (false) on anything else (an AllSelection pinning no block, a NodeSelection on a card CHILD, an
 * empty doc, or a span with nothing convertible in it).
 */
export function setHeadingLevel(level: HeadingLevel): Command {
  return (state, dispatch) => {
    // A caret/selection inside ONE card child promotes THAT line to the heading and ejects everything
    // below it. Checked first so tag / first-body-paragraph carets promote the selected line instead
    // of falling through to the "tag always becomes the heading" dissolve. Node/all selections and
    // cross-child selections return null here, leaving the whole-card and range paths to resolveRestyleTarget.
    const cardLine = resolveCardLine(state);
    if (cardLine) return splitCardAtLine(state, dispatch, cardLine, level);

    const target = resolveRestyleTarget(state);
    if (target === null) return false;

    const toHeading = (b: PMNode): RestyleSpec => ({ type: heading, attrs: { blockId: b.attrs.blockId, level } });
    if (target.kind === "single") {
      if (target.block.type === card) return dissolveCardTo(state, dispatch, target.block, target.pos, level);
      if (!isConvertibleTopLevel(target.block)) return false;
      return restyleRange(state, dispatch, target.index, target.index, toHeading);
    }
    // RANGE: convert every convertible block the selection touches; cards are skipped (not dissolved).
    return restyleRange(state, dispatch, target.fromIndex, target.toIndex, toHeading);
  };
}

/**
 * convertToAnalytic() (Mod-F7) — restyle convertible top-level block(s) INTO `analytic`, preserving
 * each block's blockId (mirrors setHeadingLevel's NON-card restyle branch). Selection-spanning: every
 * convertible block the selection touches becomes an analytic in ONE transaction.
 *
 * On a CARD or a card CHILD → return false (do NOT dissolve to analytic — an analytic has no tag/body
 * to receive the card's content). In a multi-block span, cards are simply SKIPPED (left intact), like
 * setHeadingLevel. The NodeSelection-on-card-child guard (resolveRestyleTarget) keeps a child gesture from
 * acting on the whole card.
 */
export function convertToAnalytic(): Command {
  return (state, dispatch) => {
    const target = resolveRestyleTarget(state);
    if (target === null) return false;

    const toAnalytic = (b: PMNode): RestyleSpec => ({ type: analytic, attrs: { blockId: b.attrs.blockId } });
    if (target.kind === "single") {
      if (target.block.type === card) return false; // never dissolve a card to an analytic
      if (!isConvertibleTopLevel(target.block)) return false;
      return restyleRange(state, dispatch, target.index, target.index, toAnalytic);
    }
    return restyleRange(state, dispatch, target.fromIndex, target.toIndex, toAnalytic);
  };
}

/**
 * The inclusive index range of TOP-LEVEL blocks the selection touches ([fromIndex..toIndex]), or null when
 * it pins none (empty doc / doc-level selection). Used by clearFormatting to know which blocks to reset.
 * A caret has from === to so both endpoints land on one block; a NodeSelection's from/to span its node, so
 * a node-selected top-level block / card resolves to that single block.
 */
function touchedTopLevelRange(state: EditorState): { fromIndex: number; toIndex: number } | null {
  const sel = state.selection;
  // A node-selected TOP-LEVEL block resolves its $from at depth 0, which would fail the `$from.depth < 1`
  // guard below — handle it FIRST (mirroring resolveRestyleTarget's node-selection branch) so clearFormatting
  // can reset a node-selected heading/analytic. The resets loop's type check still skips a card, so a
  // node-selected card is left intact.
  if (sel instanceof NodeSelection && sel.$from.depth === 0) {
    const i = sel.$from.index(0);
    return { fromIndex: i, toIndex: i };
  }
  const { $from, $to } = sel;
  if (state.doc.childCount === 0 || $from.depth < 1) return null;
  const fromIndex = $from.index(0);
  const toIndex = $to.depth >= 1 ? $to.index(0) : fromIndex;
  return { fromIndex, toIndex };
}

/**
 * clearFormatting (F12 — "clear to plain text") — the harder sibling of clearMarks. In ONE
 * transaction it:
 *   1. strips every inline mark over the target (the clearMarks logic: stored marks at a bare cursor,
 *      else all CLEARABLE_MARKS across the selection ranges), AND
 *   2. resets each TOUCHED convertible top-level block (heading / analytic) → a plain `paragraph`,
 *      preserving its blockId. A paragraph is already plain (left as-is); a CARD is NEVER destroyed —
 *      its marks are cleared in step 1 but the card structure stays (it isn't a convertible top-level
 *      block, so the reset skips it).
 *
 * Returns true iff it changes anything (marks cleared or a block reset); on a bare cursor in a plain,
 * unmarked paragraph it returns false so the F12 keystroke falls through (parity with clearMarks). Steps run
 * block-resets → re-anchor selection → mark-strip: the in-place markups are size-stable, and re-anchoring
 * before the stored-mark clear keeps setSelection from wiping the just-cleared stored marks (cursor case).
 */
export const clearFormatting: Command = (state, dispatch) => {
  const sel = state.selection;
  const $cursor = sel instanceof TextSelection ? sel.$cursor : null;

  // What marks would be cleared (mirrors clearMarks' two cases)?
  let marksToClear = false;
  if (sel.empty) {
    if ($cursor) {
      const marks = state.storedMarks ?? $cursor.marks();
      marksToClear = marks.some((m) => CLEARABLE_MARKS.includes(m.type));
    }
  } else {
    marksToClear = sel.ranges.some((r) =>
      CLEARABLE_MARKS.some((m) => state.doc.rangeHasMark(r.$from.pos, r.$to.pos, m)),
    );
  }

  // Which touched top-level blocks are convertible headings/analytics to reset → paragraph?
  const span = touchedTopLevelRange(state);
  const resets: { start: number }[] = [];
  if (span) {
    let start = topLevelStart(state.doc, span.fromIndex);
    for (let i = span.fromIndex; i <= span.toIndex; i++) {
      const node = state.doc.child(i);
      if (node.type === heading || node.type === analytic) resets.push({ start });
      start += node.nodeSize;
    }
  }

  if (!marksToClear && resets.length === 0) return false; // nothing to do — let F12 fall through

  if (dispatch) {
    const tr = state.tr;
    // 1) Reset heading/analytic → paragraph via setNodeMarkup (in-place type change; content + every inner
    //    position preserved). All block types here are size-stable, so the original mark ranges and caret
    //    position remain valid afterwards.
    for (const { start } of resets) {
      tr.setNodeMarkup(start, paragraph, { blockId: tr.doc.nodeAt(start)!.attrs.blockId });
    }
    // 2) Re-anchor the selection BEFORE removing marks, but ONLY when a block reset actually ran (a
    //    boundary endpoint could otherwise resolve at the doc level). Skipping it when there are no
    //    structural steps keeps the cursor path byte-identical to clearMarks. setSelection resets
    //    storedMarks, so the stored-mark clear below MUST run after it.
    if (resets.length > 0) reanchorSelection(tr, sel.from, sel.to);
    // 3) Strip marks via the SHARED helper, so this is byte-identical to clearMarks. Cursor → clear stored
    //    marks so the next typed run is plain; range → remove every CLEARABLE_MARK across the ranges
    //    (positions still valid — the block resets are size-stable).
    stripClearableMarks(tr, sel, $cursor);
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/**
 * convertToTag (the "Tag" button / inverse of dissolveCard) — turn the top-level block at the
 * selection's FROM side into a CARD: its inline content becomes the card's `tag`, and
 * the card's body ABSORBS the contiguous following top-level PARAGRAPH siblings — stopping BEFORE the first
 * EMPTY paragraph, the first non-paragraph block, or the doc end. If nothing is absorbable, the body is a
 * single empty paragraph (so the card still satisfies `paragraph+`). ONE transaction (a single replaceWith
 * over [blockStart .. end of the last absorbed block]); the result passes node.check(); the caret lands at
 * the end of the tag.
 *
 * SAFETY: only acts when the from-side block is a CONVERTIBLE top-level block
 * (paragraph/heading/analytic — never a card or a card child, which would destroy an isolating block or a
 * required child). For an inline selection it additionally requires
 * `sel instanceof TextSelection && sel.$from.sameParent(sel.$to) && sel.$from.parent.isTextblock` so a
 * whole-block NodeSelection / AllSelection (whose endpoints resolve with the doc as parent) is NOT
 * mis-read as inline. A NodeSelection on a single depth-0 block resolves to that one block; an AllSelection
 * (no single unambiguous block) returns false. The absorbed paragraphs keep their own blockIds (relocated
 * units); the new card gets a fresh blockId.
 */
export function convertToTag(): Command {
  return (state, dispatch) => {
    const sel = state.selection;

    // Resolve the single source block + its index, honoring the SAFETY rule above. `null` => not a safe, unambiguous target.
    let sourceIndex = -1;
    if (sel instanceof NodeSelection && sel.$from.depth === 0) {
      sourceIndex = sel.$from.index(0); // a node-selected top-level block: unambiguous
    } else if (
      sel instanceof TextSelection &&
      sel.$from.sameParent(sel.$to) &&
      sel.$from.parent.isTextblock &&
      sel.$from.depth >= 1
    ) {
      sourceIndex = sel.$from.index(0); // an inline caret/selection inside one top-level textblock
    } else {
      return false; // AllSelection, cross-block, or a non-textblock target → never act
    }

    const doc = state.doc;
    const source = doc.child(sourceIndex);
    // Only convertible top-level blocks. A card / card child is never converted (would destroy structure).
    if (source.type !== paragraph && source.type !== heading && source.type !== analytic) return false;

    // Absorb contiguous FOLLOWING paragraphs, stopping at the first empty paragraph / non-paragraph / end.
    const absorbed: PMNode[] = [];
    for (let i = sourceIndex + 1; i < doc.childCount; i++) {
      const sib = doc.child(i);
      if (sib.type !== paragraph || sib.content.size === 0) break; // stop BEFORE empty / non-paragraph
      absorbed.push(sib);
    }

    if (dispatch) {
      // `Fragment.content` is the node array of an inline fragment; spreading it hands buildCard the
      // inline children verbatim (text + every mark survives, since these are the SAME node objects).
      // body = absorbed paragraphs (keep their ids — relocated units), or one fresh empty paragraph.
      const bodyParas: CardBodyParagraph[] =
        absorbed.length > 0
          ? absorbed.map((p) => ({ blockId: p.attrs.blockId as string, content: [...p.content.content] }))
          : [{ blockId: freshBlockId() }];
      const newCard = buildCard({
        blockId: freshBlockId(),
        tag: [...source.content.content], // the source block's inline content becomes the tag
        body: bodyParas,
      });

      // One replaceWith over [start of source .. end of the last absorbed block].
      let start = 0;
      for (let i = 0; i < sourceIndex; i++) start += doc.child(i).nodeSize;
      let end = start + source.nodeSize;
      for (const p of absorbed) end += p.nodeSize;

      const tr = state.tr.replaceWith(start, end, newCard);
      // caret → end of the tag: card opens at `start`, tag opens at start+1, tag content ends at
      // start+2+tagContentSize (the tag's inline content size equals the source block's content size).
      tr.setSelection(TextSelection.create(tr.doc, start + 2 + source.content.size));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/**
 * moveBlock — reorder a top-level block by DESTROY + RECREATE, not by mutation:
 * the block is deleted and a freshly-recreated copy is inserted at the adjacent slot. The copy is built
 * with `schema.nodeFromJSON(node.toJSON())` — a genuine rebuild from serialized form — so it is a NEW
 * node object that is nonetheless DEEP-EQUAL to the original (children, text, every mark + position,
 * hard_breaks) AND keeps the SAME blockId (the id is an attr → it round-trips; it is never re-minted).
 * Modelling a reorder as delete-then-reinsert under the same id keeps the move a clean structural operation:
 * tombstone the old block, re-insert an identical block elsewhere under the same id.
 *
 * Delete + insert happen in ONE transaction. Insert position uses the UNCHANGED neighbour sizes from the
 * pre-delete doc: moving up lands the copy before the previous block (`startOffset - prevSize`); moving
 * down lands it after the next block (`startOffset + nextSize`). Returns false (no-op) at the edges.
 */
export function moveBlock(blockId: string, dir: "up" | "down"): Command {
  return (state, dispatch) => {
    const doc = state.doc;
    let index = -1;
    let startOffset = -1;
    // First match wins. Impossible to collide today (ids are crypto.randomUUID), but should a duplicate
    // blockId ever surface, deterministically taking the first keeps the move well-defined rather than
    // silently jumping to the last occurrence.
    doc.forEach((node, offset, i) => {
      if (index < 0 && node.attrs.blockId === blockId) {
        index = i;
        startOffset = offset;
      }
    });
    if (index < 0) return false; // no block with that id

    const targetIndex = dir === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= doc.childCount) return false; // already at the edge

    if (dispatch) {
      const node = doc.child(index);
      const copy = schema.nodeFromJSON(node.toJSON()); // destroy + recreate; deep-equal; same blockId
      // Neighbour sizes are taken from the pre-delete doc (blocks adjacent to the moved one are not
      // affected by removing it), giving the post-delete insertion boundary directly.
      const insertAt =
        dir === "up" ? startOffset - doc.child(index - 1).nodeSize : startOffset + doc.child(index + 1).nodeSize;
      const tr = state.tr.delete(startOffset, startOffset + node.nodeSize).insert(insertAt, copy);
      tr.setSelection(TextSelection.near(tr.doc.resolve(insertAt + 1))); // caret back into the moved block
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/**
 * moveCurrentBlock(dir) — the keybinding-friendly wrapper (Alt-↑ / Alt-↓): resolve the top-level block
 * containing the caret (`$from.node(1)`) and move it. Keeps `moveBlock` itself addressable by blockId
 * (what the tests use) while the keymap needs only a direction.
 */
export function moveCurrentBlock(dir: "up" | "down"): Command {
  return (state, dispatch) => {
    const sel = state.selection;
    // The block to move is the one holding the caret — OR, when a whole top-level block is node-selected
    // (depth 0, e.g. after selectParentNode / a gap-cursor click), that block itself. Resolving the
    // NodeSelection case keeps Alt-↑/↓ live after a block has been node-selected instead of dropping the
    // keystroke. (AllSelection identifies no single block, so it correctly falls through to false.)
    let blockId: string | null = null;
    if (sel instanceof NodeSelection && sel.$from.depth === 0) {
      const id = sel.node.attrs.blockId;
      if (typeof id === "string") blockId = id;
    } else if (sel.$from.depth >= 1) {
      const id = sel.$from.node(1).attrs.blockId;
      if (typeof id === "string") blockId = id;
    }
    if (blockId === null) return false;
    return moveBlock(blockId, dir)(state, dispatch);
  };
}

/**
 * caretToDocEnd — drop the caret at the very END of the document and scroll it into view. Backs
 * the "click in the empty area below the last block" affordance: the click-below plugin (renderer/main.ts)
 * runs this THROUGH the single dispatch seam when it detects a click beneath all content. Kept here as a
 * plain, dispatch-only Command so it is unit-testable without any DOM geometry — `Selection.atEnd(doc)`
 * resolves the last valid cursor position (inside the last textblock, or a gap/node selection if the doc
 * ends in a non-textblock), exactly where typing should resume.
 */
export const caretToDocEnd: Command = (state, dispatch) => {
  if (dispatch) dispatch(state.tr.setSelection(Selection.atEnd(state.doc)).scrollIntoView());
  return true;
};
