// renderer/runtime.ts — the editor runtime seam (the product wiring; testable WITHOUT a DOM).
//
// `buildEditorRuntime` resolves the editor configuration: the seed document plus the ordered ProseMirror
// plugin list (prosemirror-history undo, the mark/function-key/block keymaps, click-below, cite placeholder,
// and the paste guard). No network — a single-user editor.
//
// WHY a separate seam (not inline in main.ts): the exact plugin order is the correctness-critical part of the
// editor, and it must be unit-testable without mounting a real EditorView. main.ts becomes a thin shell that
// mounts whatever this returns and wires the editor surface.

import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { Plugin } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { createSeedDoc } from "../seed";
import {
  toggleHighlight,
  toggleUnderline,
  toggleEmphasis,
  toggleMuted,
  toggleStrong,
  clearFormatting,
  enter,
  backspace,
  insertCard,
  moveCurrentBlock,
  setHeadingLevel,
  convertToTag,
  convertToAnalytic,
  caretToDocEnd,
} from "../commands";
import { citePlaceholderPlugin } from "../cite-placeholder";
import { pasteGuardPlugin } from "../paste-guard";

/**
 * Click-below-content plugin. When the user mousedowns in the empty area BELOW the last rendered
 * block (still inside the editor; the .ProseMirror box has padding-bottom so there is room to click), drop
 * the caret at the END of the document and focus the editor. Detection is pure DOM geometry: a click whose
 * clientY sits below the bottom edge of the editor's LAST element child is "below all content".
 *
 * The selection change goes THROUGH `view.dispatch` (→ dispatchTransaction → the single dispatch seam) via the
 * `caretToDocEnd` command — never `view.updateState` and never a second dispatch path. Returning true marks
 * the event handled so the browser does not also place a caret. NOTE: jsdom has no layout (every rect is
 * 0×0), so this geometry is exercised manually in the live app; the command it runs (caretToDocEnd) is unit-tested.
 *
 * MOVED here from main.ts: it is part of the renderer plugin list (shared by both modes) and depends only
 * on `caretToDocEnd` + PM — no toolbar coupling — so it belongs with the plugin-building seam.
 */
export function clickBelowContentPlugin(): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        mousedown(view, event) {
          // Only a primary-button click in the editor's own empty tail should reposition the caret.
          if (event.button !== 0) return false;
          const last = view.dom.lastElementChild;
          // No content yet, or the click is at/above the last block → let ProseMirror handle it normally.
          if (!last) return false;
          if (event.clientY <= last.getBoundingClientRect().bottom) return false;
          caretToDocEnd(view.state, view.dispatch, view); // through the single dispatch seam
          view.focus();
          return true; // handled — suppress the browser's own caret placement
        },
      },
    },
  });
}

// ── shared plugin sub-lists (DRY across the two modes) ──────────────────────────────────────────────────
//
// These keymaps are IDENTICAL in single and unit mode (marks, the mark/structural F-keys, the block keymap);
// clickBelow, cite, and the pasteGuard are shared too. What differs between modes: the UNDO system
// (prosemirror-history vs session.commands) and the prepended binding/history. NEITHER mode installs a live
// normalizer — the editor installs no live absorb normalizer (auto-absorb was unwanted).
// Factored into functions (not module constants) so each mode gets its OWN plugin instances — a Plugin is
// stateful (it owns per-view binding state), so two EditorStates must never share one instance.

/** Ctrl/Cmd-H toggle highlight (default blue), Ctrl/Cmd-U toggle read-aloud underline. */
const markKeymap = (): Plugin => keymap({ "Mod-h": toggleHighlight(), "Mod-u": toggleUnderline });

/** Mark F-keys: F9 underline, F10 emphasis, F11 highlight, F12 clear, Mod-8 muted, Mod-b strong. */
const markFKeys = (): Plugin =>
  keymap({
    F9: toggleUnderline,
    F10: toggleEmphasis,
    F11: toggleHighlight(),
    F12: clearFormatting,
    "Mod-8": toggleMuted,
    "Mod-b": toggleStrong,
  });

/** Structural conversion F-keys: F4/F5/F6 heading levels, F7 card, Mod-F7 analytic. */
const structuralFKeys = (): Plugin =>
  keymap({
    F4: setHeadingLevel("pocket"),
    F5: setHeadingLevel("hat"),
    F6: setHeadingLevel("block"),
    F7: convertToTag(),
    "Mod-F7": convertToAnalytic(),
  });

/** Block keymap: context-aware Enter/Backspace, Mod-Enter inserts a card, Alt-↑/↓ reorder. */
const blockKeymap = (): Plugin =>
  keymap({
    Enter: enter,
    "Mod-Enter": insertCard,
    Backspace: backspace,
    "Alt-ArrowUp": moveCurrentBlock("up"),
    "Alt-ArrowDown": moveCurrentBlock("down"),
  });

// ── Pure, exported e2e position helpers (DOM-free, testable against the real seed) ─────────────────────
//
// The old `bodyPos` in main.ts assumed body paragraph ids follow the `${cardId}p1` convention used by the
// HARNESS demo doc. The real seed (createSeedDoc) mints body paragraphs with random crypto.randomUUID()
// blockIds — so that convention never matched. These helpers descend the actual doc tree instead, making
// edit/caret/ids/text robust to the real seed and unit-testable without a view.

/**
 * Returns the `blockId` of every top-level node in `doc`, in document order.
 * Used by the e2e surface's `ids()` to enumerate addressable blocks.
 */
export function topLevelBlockIds(doc: PMNode): string[] {
  const ids: string[] = [];
  doc.forEach((node) => {
    if (node.attrs?.blockId) ids.push(node.attrs.blockId as string);
  });
  return ids;
}

/**
 * Returns the `textContent` of the top-level block whose `blockId === id`, or `""` if not found.
 * Reads the full text of the block (all descendants), matching `view.state.doc.forEach` behavior.
 */
export function blockText(doc: PMNode, id: string): string {
  let result = "";
  doc.forEach((node) => {
    if (node.attrs?.blockId === id) result = node.textContent;
  });
  return result;
}

/**
 * Returns the first inline text position INSIDE the top-level block whose `blockId === id`.
 * Descends to the first textblock child (covers card>body>paragraph, plain paragraph, heading, analytic).
 * Returns -1 if the block is not found — callers must guard on `pos > 0` before dispatching.
 *
 * WHY NOT `${id}p1`: the real seed's body paragraphs have random UUIDs, not a derived id convention.
 * We descend the actual node tree so the helper is schema-agnostic and works after any block type.
 */
export function firstBodyPos(doc: PMNode, id: string): number {
  let result = -1;
  doc.forEach((node, offset) => {
    if (result !== -1 || node.attrs?.blockId !== id) return;
    const base = offset + 1; // first position inside this top-level block
    node.descendants((child, childPos) => {
      if (result !== -1) return false;
      if (child.isTextblock) {
        // +1 to step inside the textblock's opening token — this is the first writable inline pos.
        result = base + childPos + 1;
        return false;
      }
      return true;
    });
    // Fallback: if the top-level node itself is a textblock (plain paragraph, heading, analytic)
    // and no child textblock was found, the block IS the textblock — use base directly.
    if (result === -1 && node.isTextblock) result = base;
  });
  return result;
}

/**
 * The resolved editor configuration: the seed document and the ordered plugin list to mount.
 */
export interface EditorRuntime {
  doc: PMNode;
  plugins: Plugin[];
}

/**
 * Resolve the editor runtime. Pure with respect to the DOM (it constructs plugins + a doc but mounts
 * nothing), so it is unit-testable without an EditorView.
 *
 * prosemirror-history is the undo system; the seed is the real product seed doc. The list ends
 * clickBelow → cite → pasteGuard → baseKeymap; there is no live absorb normalizer (auto-absorb of a loose
 * paragraph into the preceding card on caret-leave was unwanted — it silently restructured the document).
 */
export function buildEditorRuntime(): EditorRuntime {
  return {
    doc: createSeedDoc(),
    plugins: [
      history(),
      keymap({ "Mod-z": undo, "Mod-y": redo, "Shift-Mod-z": redo }),
      markKeymap(),
      markFKeys(),
      structuralFKeys(),
      blockKeymap(),
      clickBelowContentPlugin(),
      citePlaceholderPlugin(),
      pasteGuardPlugin(), // paste guard: rebuild a pasted Slice as text + the 5 marks (no structure)
      keymap(baseKeymap),
    ],
  };
}
