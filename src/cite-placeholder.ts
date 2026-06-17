// cite-placeholder.ts — a view-layer hint that shows "[citation]" inside an EMPTY card cite.
//
// A card built without a cite (insertCard and convertToTag both leave the cite empty) gets a muted
// "[citation]" hint so the writer sees where the source line goes. This is PURELY a decoration: it never
// changes the document, never serializes, and adds NO NodeView — so it is safe to wrap and leaves the
// single-toDOM substrate rule and the single dispatch seam completely untouched. The hint
// disappears the moment the cite has content (typed OR pasted) or the caret is inside it (you clicked in to
// add the citation), and returns whenever the cite is empty and unfocused again.

import { Plugin } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { schema } from "./schema";

const cite = schema.nodes.cite;

/**
 * Compute the placeholder decorations for `state`: a node decoration (adding the `fl-cite--placeholder`
 * class, whose CSS ::before renders the hint text) over every EMPTY cite the caret is NOT inside. Exported
 * pure so the show/hide logic is unit-testable without a DOM or an EditorView.
 *
 * Hide rule: an empty cite at position `pos` has exactly one valid inner cursor position, `pos + 1`; while a
 * collapsed selection sits there (the user clicked/focused the cite to type or paste) the hint is suppressed.
 * A non-empty cite never gets a hint. Everything is recomputed from scratch each call, so the hint tracks
 * both document edits and selection moves.
 */
export function citePlaceholderDecorations(state: EditorState): DecorationSet {
  const { doc, selection } = state;
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type === cite) {
      if (node.content.size === 0) {
        const caretInside = selection.empty && selection.from === pos + 1;
        if (!caretInside) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "fl-cite--placeholder" }));
      }
      return false; // a cite holds only inline content — nothing nested to scan
    }
    return true; // keep descending to reach the cites (depth 2: doc > card > cite)
  });
  return DecorationSet.create(doc, decos);
}

/**
 * The plugin: surface `citePlaceholderDecorations` through the view's `decorations` prop. ProseMirror
 * recomputes this on every state change — including pure selection changes — so the hint appears/disappears
 * exactly as the cite gains/loses content or the caret enters/leaves it. No state, no dispatch, no NodeView.
 */
export function citePlaceholderPlugin(): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        return citePlaceholderDecorations(state);
      },
    },
  });
}
