// editor.ts — the single dispatchTransaction seam and view factory.
//
// There is ONE EditorView and ONE place transactions are applied — the `dispatchTransaction`
// callback below. Every command and (later) the normalizer funnel through it; there is no second
// dispatch path and no out-of-band state injection elsewhere. Concentrating all transactions in
// THIS seam is why it is a single named function: any wrapper can intercept transactions in one place.
//
// The view is built with NO `nodeViews`. All rendering flows through the schema's toDOM.
// `buildViewProps` deliberately omits the key; the no-NodeViews test asserts it stays omitted.

import { EditorState } from "prosemirror-state";
import type { Plugin, Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { DirectEditorProps } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "./schema";

/** The single dispatch seam — the one function any transaction wrapper hooks. */
export type DispatchSeam = (view: EditorView, tr: Transaction) => void;

/**
 * Meta key marking a transaction that LOADS a document from a file (the Open path replaces the whole
 * doc through THIS seam, not via `view.updateState`, so the single-dispatch invariant is preserved). Consumers that react to *user* edits
 * must skip a tr carrying this flag — today that is the renderer's dirty-flag (so a freshly opened doc is not
 * "dirty"). The live absorb normalizer that also consumed this flag (to avoid restructuring a just-loaded doc)
 * has since been removed, so the dirty-flag is now the sole consumer. Defined here, on the seam module, so the
 * marker has one shared literal.
 */
export const LOAD_META = "flowlineLoad";

/** Default seam: apply the transaction to the one view's state. The only place updateState is called. */
export const applyTransaction: DispatchSeam = (view, tr) => {
  view.updateState(view.state.apply(tr));
};

/** Build the EditorView props. NO nodeViews; a single dispatchTransaction. */
export function buildViewProps(state: EditorState, dispatch: DispatchSeam = applyTransaction): DirectEditorProps {
  return {
    state,
    dispatchTransaction(this: EditorView, tr) {
      dispatch(this, tr);
    },
    // Intentionally NO `nodeViews` key. Do not add one.
  };
}

/** Create the one Flowline EditorView, mounting `doc` into `mount`. */
export function createFlowlineView(
  mount: HTMLElement,
  doc: PMNode,
  plugins: readonly Plugin[] = [],
  dispatch: DispatchSeam = applyTransaction,
): EditorView {
  const state = EditorState.create({ schema, doc, plugins: [...plugins] });
  return new EditorView(mount, buildViewProps(state, dispatch));
}
