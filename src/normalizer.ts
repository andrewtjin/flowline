// normalizer.ts — the STRUCTURAL absorb normalizer (a standalone one-shot import-repair utility).
//
// WHAT IT DOES. A loose top-level `paragraph` that immediately follows a `card` is absorbed INTO that card's
// `body` (the inverse direction of `convertToTag`'s absorb). It is a STRUCTURAL fixup (cross-block content
// movement), not a mark-coalescer — it relocates whole paragraph nodes between blocks rather than merging
// adjacent marks.
//
// NOT WIRED INTO THE EDITOR (the wet-test verdict). An earlier build installed this normalizer LIVE through an
// `appendTransaction` so a loose paragraph folded into the preceding card on caret-leave/click-off. The
// wet-test rejected that behaviour: silently restructuring the user's document as the caret moves is surprising
// and unwanted. So the plugin WIRING was removed — the renderer never installs the normalizer and the PRODUCT
// NEVER auto-absorbs. The normalizer CODE is RETAINED as a standalone, explicitly-invoked structural repair
// utility (run over a freshly-imported doc), and is exercised by tests/normalizer.test.ts.
//
// APPEND-TRANSACTION SHAPE (a reusable normalizer the editor does not install live). `liveNormalize`/
// `absorbNormalizer` is a bare `appendTransaction`-shaped function with NO origin bypass of its own. Were it ever
// installed live, anything wishing to skip it on a foreign-origin batch would gate it externally; keeping that
// concern OUT of here keeps the function a single, reusable definition. It is NOT installed today.
//
// LIVE PATH vs FULL SCAN ("dirty-region + debounced", and the full-scan utility).
//   - The LIVE path (`liveNormalize`) is CARET-LEAVE driven, which is BOTH the dirty-region (it examines a single
//     block — the one the caret just left — never the whole doc, O(1)) AND a "debounced" deferral:
//     a loose paragraph after a card is absorbed only once the caret LEAVES it. It does NOT absorb a paragraph
//     the caret merely passes NEAR (that eager behaviour fought `moveBlock` and silently ate untouched lines — a
//     serious regression). The block the caret left is identified by its STABLE blockId, NOT by mapping the old
//     caret position forward — a destroy+recreate reorder (moveBlock) collapses the old position onto an unrelated
//     block seam, so a position-mapped "leave" would absorb a bystander run (the same class of regression). This
//     path is NO LONGER installed in the editor.
//   - The FULL-DOC scan (`fullScanNormalize`) examines EVERY top-level block, applies no deferral, and reports how
//     many it touched. It is the intended one-shot IMPORT-REPAIR entry point (run explicitly over a freshly-
//     imported doc; never on appendTransaction). A test asserts touch-count == top-level block count, pinning that
//     the full scan really visits every block rather than only an adjacency-local subset.
//
// IDENTITY (no blockId minting — relocation, not destruction). An absorbed paragraph is REUSED
// verbatim: the same node object (its blockId, inline content, and every mark) becomes a body paragraph. The
// scan NEVER mints or stamps a blockId. Because a top-level `paragraph` and a card-body `paragraph` are the SAME
// node type, the move needs no re-wrapping and the rebuilt card stays `check()`-valid (`body := paragraph+`). To
// keep the relocation invariant intact, the run collection STOPS before any paragraph whose blockId already
// appears in the target body (it would otherwise create a duplicate unit id — a serious bug). Each absorb is
// also exactly SIZE-PRESERVING (the card grows by precisely the paragraphs' node sizes, which leave the top
// level), so positions after the absorbed run are unchanged and any selection outside the run maps through untouched.
//
// FIXPOINT (no oscillation). The whole CONTIGUOUS run of absorbable paragraphs after a card is absorbed in a
// SINGLE pass. ProseMirror does not re-invoke a plugin's `appendTransaction` on the very transaction that plugin
// just appended (it advances the per-plugin seen-pointer), so the absorb cannot trigger itself again — a
// guaranteed fixpoint. (A separate explicit full-scan re-run on the post-absorb doc returning null is asserted
// in the tests as the fixpoint proof.)

import type { EditorState, Transaction } from "prosemirror-state";
import type { Node as PMNode, ResolvedPos } from "prosemirror-model";
import { schema } from "./schema";

const { card, paragraph, body } = schema.nodes;

/**
 * One absorb operation: the `card` at `cardPos` should swallow `paragraphs` (the contiguous run of loose
 * top-level paragraphs immediately after it, up to `spanEnd`) into its body. `paragraphs` are the original
 * node objects — reused verbatim so blockIds + content + marks are preserved (relocation, not re-creation).
 */
interface Absorption {
  readonly cardPos: number; // doc position just before the card's open token
  readonly cardNode: PMNode; // the card to grow
  readonly spanEnd: number; // doc position just after the last absorbed paragraph's close token
  readonly paragraphs: readonly PMNode[]; // the run to move into the card body (≥1)
}

/** Result of a scan: the absorbs to perform, and how many top-level blocks the scan examined ("touched"). */
interface ScanResult {
  readonly absorptions: Absorption[];
  readonly touched: number;
}

/**
 * A loose top-level paragraph is absorbable iff it is a `paragraph` with content (an EMPTY paragraph is a
 * deliberate barrier — it is how a writer parks a blank line / starts a fresh block after a card). A
 * non-paragraph block (analytic / heading / another card) is also a barrier and stops the run. NOTE: a
 * paragraph holding only a `hard_break` has content.size > 0, so it IS absorbable — deliberately matching
 * `convertToTag`'s identical `content.size === 0` barrier test, so the two absorb paths agree.
 */
function isAbsorbableParagraph(node: PMNode): boolean {
  return node.type === paragraph && node.content.size > 0;
}

/** Top-level (depth-1) block index containing a resolved position, clamped to a valid child index. */
function topLevelIndexOf($pos: ResolvedPos): number {
  // For an inline position depth >= 1, index(0) is the enclosing top-level block. For a doc-level position
  // (depth 0, e.g. a NodeSelection boundary or the very end of the doc) index(0) can equal childCount; clamp.
  const raw = $pos.index(0);
  const max = $pos.node(0).childCount - 1;
  return Math.max(0, Math.min(raw, max));
}

/** The top-level indices the selection occupies ($from..$to block span) — used for caret-leave deferral. */
function selectionBlocks(state: EditorState): Set<number> {
  const set = new Set<number>();
  if (state.doc.childCount === 0) return set;
  const sel = state.selection;
  const a = topLevelIndexOf(sel.$from);
  const b = topLevelIndexOf(sel.$to);
  for (let k = Math.min(a, b); k <= Math.max(a, b); k++) set.add(k);
  return set;
}

/**
 * Scan `doc` for absorb operations. `candidates` selects which top-level indices to examine as a possible
 * absorbing card: "all" (the full-doc one-shot import-repair) or a specific set (the live caret-leave
 * path). `deferred` is the set of top-level indices the selection currently occupies — a run STOPS before any
 * such paragraph (caret-deferral), so the writer is never interrupted mid-line. The run also stops before any
 * paragraph whose blockId already exists in the target body (no duplicate unit ids — relocation safety).
 * `touched` counts the candidate indices actually examined (== childCount for "all"; ≤1 for caret-leave).
 */
function scanAbsorptions(doc: PMNode, candidates: "all" | ReadonlySet<number>, deferred: ReadonlySet<number>): ScanResult {
  const n = doc.childCount;
  if (n === 0) return { absorptions: [], touched: 0 };

  // Precompute each top-level block's start position once.
  const starts: number[] = new Array(n);
  let off = 0;
  for (let i = 0; i < n; i++) {
    starts[i] = off;
    off += doc.child(i).nodeSize;
  }

  const absorptions: Absorption[] = [];
  let touched = 0;

  // Examine one candidate index: if it is a card, collect the contiguous absorbable run right after it.
  const visit = (i: number): void => {
    touched++;
    const node = doc.child(i);
    if (node.type !== card) return; // only a card can absorb; paragraphs/headings/analytics never do here
    // Ids already present in this card's body — the run must not introduce a duplicate (relocation safety).
    const ids = new Set<string>();
    node.child(2).forEach((p) => {
      if (typeof p.attrs.blockId === "string") ids.add(p.attrs.blockId);
    });
    const run: PMNode[] = [];
    let j = i + 1;
    for (; j < n; j++) {
      if (deferred.has(j)) break; // the selection's own paragraph — defer until the caret leaves
      const sib = doc.child(j);
      if (!isAbsorbableParagraph(sib)) break; // empty paragraph / non-paragraph block = barrier; stop the run
      const id = sib.attrs.blockId;
      if (typeof id === "string" && ids.has(id)) break; // would duplicate a body unit id — stop the run
      if (typeof id === "string") ids.add(id);
      run.push(sib);
    }
    if (run.length === 0) return;
    const spanEnd = starts[j - 1] + doc.child(j - 1).nodeSize; // just after the last absorbed paragraph
    absorptions.push({ cardPos: starts[i], cardNode: node, spanEnd, paragraphs: run });
  };

  if (candidates === "all") {
    for (let i = 0; i < n; i++) visit(i);
  } else {
    // Ascending, de-duplicated, in-range.
    for (const i of [...candidates].filter((k) => k >= 0 && k < n).sort((a, b) => a - b)) visit(i);
  }
  return { absorptions, touched };
}

/**
 * Turn a list of absorptions into one transaction (or null if there is nothing to do). Each absorb rebuilds
 * the card with its existing tag/cite and a body of [...existing body paragraphs, ...absorbed paragraphs],
 * then replaces [cardPos, spanEnd] with that one card. The rebuild reuses every child node object verbatim, so
 * blockIds + content + marks are preserved and no id is minted. Each replace is exactly size-preserving (the
 * card grows by the paragraphs that leave the top level), so positions computed from the ORIGINAL doc stay
 * valid as we apply absorptions in ascending order within the single transaction.
 */
function applyAbsorptions(state: EditorState, absorptions: readonly Absorption[]): Transaction | null {
  if (absorptions.length === 0) return null;
  const tr = state.tr;
  for (const a of absorptions) {
    const tagNode = a.cardNode.child(0);
    const citeNode = a.cardNode.child(1);
    const oldBody = a.cardNode.child(2);
    const bodyParas: PMNode[] = [];
    oldBody.forEach((p) => bodyParas.push(p)); // keep the card's existing body paragraphs
    for (const p of a.paragraphs) bodyParas.push(p); // append the absorbed run (same node objects)
    const newCard = card.create({ blockId: a.cardNode.attrs.blockId }, [
      tagNode,
      citeNode,
      body.create(null, bodyParas),
    ]);
    tr.replaceWith(a.cardPos, a.spanEnd, newCard);
  }
  return tr.docChanged ? tr : null;
}

const EMPTY_INDEX_SET: ReadonlySet<number> = new Set<number>();

/**
 * The FULL-DOC scan (the one-shot import-repair entry point). Examines EVERY top-level block,
 * applies no caret deferral, and reports `touched` so a test can assert it equals the top-level block count —
 * the proof that the full scan really visits every block, not just an adjacency-local subset. The editor
 * would call it explicitly as import-repair; it is never wired to `appendTransaction`.
 */
export function fullScanNormalize(state: EditorState): { tr: Transaction | null; touched: number } {
  const { absorptions, touched } = scanAbsorptions(state.doc, "all", EMPTY_INDEX_SET);
  return { tr: applyAbsorptions(state, absorptions), touched };
}

/**
 * The ProseMirror `appendTransaction` shape, defined locally so this module depends on nothing external: any
 * caller that wishes to install or wrap a normalizer can reuse this exact signature.
 */
export type AppendTransactionFn = (
  transactions: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState,
) => Transaction | null;

/**
 * The LIVE normalizer (caret-leave driven; dirty-region O(1) + "debounced"). Returns the appended transaction
 * (or null) AND `touched` (≤1) so a test can assert the live path does NOT scan every block.
 *
 * It absorbs ONLY when the caret has just LEFT a single block that is a loose paragraph immediately after a
 * card. The left block is tracked by its STABLE blockId (never by a mapped position — a destroy+recreate
 * reorder would collapse the old position onto a bystander block's seam): the block the old selection occupied
 * must still EXIST in the new doc (same blockId), the new selection must no longer be in it, and the block
 * before it must be a card. That card's contiguous trailing run is then absorbed (deferring the caret's new
 * block). Placing the caret elsewhere, editing without leaving the paragraph, or reordering blocks never
 * triggers an unwanted absorb.
 *
 * The editor does NOT install this; it remains a reusable structural normalizer in bare `appendTransaction`
 * shape. `_transactions` is unused: tracking by blockId is position-independent, so the batch's step maps are
 * irrelevant — which is what makes it robust to reorders.
 */
export function liveNormalize(
  _transactions: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState,
): { tr: Transaction | null; touched: number } {
  if (newState.doc.childCount === 0 || oldState.doc.childCount === 0) return { tr: null, touched: 0 };

  // The old selection must rest in a SINGLE top-level block for "the block the caret left" to be well-defined.
  const oldSel = oldState.selection;
  const oldIdx = topLevelIndexOf(oldSel.$from);
  if (oldIdx !== topLevelIndexOf(oldSel.$to)) return { tr: null, touched: 0 };
  const leftId = oldState.doc.child(oldIdx).attrs.blockId;
  if (typeof leftId !== "string") return { tr: null, touched: 0 }; // no stable id to track

  // Find that SAME block (by id) in the new doc — the actual block the caret may have left. If the id is
  // AMBIGUOUS (it appears on >1 top-level block), BAIL: we cannot tell which occurrence the caret left, and
  // guessing the first could absorb a block the user never touched. This mirrors the duplicate-body-id guard
  // in scanAbsorptions — both refuse to act on an ambiguous unit id.
  let leftIdx = -1;
  let matches = 0;
  newState.doc.forEach((node, _off, i) => {
    if (node.attrs.blockId === leftId) {
      matches++;
      if (leftIdx < 0) leftIdx = i;
    }
  });
  if (matches !== 1) return { tr: null, touched: 0 }; // gone (0) or ambiguous (>1) → defer
  if (leftIdx <= 0) return { tr: null, touched: 0 }; // first block has no preceding card to absorb into

  const deferred = selectionBlocks(newState);
  if (deferred.has(leftIdx)) return { tr: null, touched: 0 }; // caret is still in that block → not a leave

  // Examine exactly the card that could absorb the just-left paragraph (the block before it). scanAbsorptions
  // confirms leftIdx-1 is a card and leftIdx is a loose paragraph before collecting the run.
  const { absorptions, touched } = scanAbsorptions(newState.doc, new Set([leftIdx - 1]), deferred);
  return { tr: applyAbsorptions(newState, absorptions), touched };
}

/**
 * The live normalizer as a bare `AppendTransactionFn` — a reusable normalizer in plain appendTransaction shape.
 * NOT installed in the editor (the live auto-absorb was removed).
 */
export const absorbNormalizer: AppendTransactionFn = (transactions, oldState, newState) =>
  liveNormalize(transactions, oldState, newState).tr;
