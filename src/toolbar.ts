// toolbar.ts — the mark toolbar: four highlight colour swatches + emphasis + muted.
//
// Pure renderer UI, built from `fl-`-classed DOM. Each control runs a mark
// command from `commands.ts` against the live view through `view.dispatch` (the single dispatch seam),
// then returns focus to the editor so typing continues uninterrupted.
//
// The crucial detail: controls listen on `mousedown` with `preventDefault()`, NOT `click`. A plain
// click would blur the editor and collapse the selection BEFORE the command runs, so the highlight
// would apply to nothing. Preventing the default mousedown keeps the editor's selection intact.

import type { EditorView } from "prosemirror-view";
import type { EditorState } from "prosemirror-state";
import type { Command } from "prosemirror-state";
import type { MarkType } from "prosemirror-model";
import { schema, HIGHLIGHT_COLORS, HEADING_LEVELS } from "./schema";
import type { HighlightColor, HeadingLevel } from "./schema";
import {
  toggleHighlight,
  toggleEmphasis,
  toggleMuted,
  toggleUnderline,
  toggleStrong,
  clearFormatting,
  setHeadingLevel,
  convertToTag,
  insertCardAtCite,
} from "./commands";

export interface Toolbar {
  /** The toolbar root element — caller mounts it (e.g. into the topbar). */
  readonly dom: HTMLElement;
  /** Refresh active-state styling from the current editor state. Call after every transaction. */
  syncActive(state: EditorState): void;
}

// ── small DOM helpers (kept local; the app has no UI framework) ────────────────────────────────
function elem<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

// Is `type` active at the current selection (range has it, or it's the stored/cursor mark)?
function markActive(state: EditorState, type: MarkType): boolean {
  const { from, to, empty } = state.selection;
  if (empty) {
    const marks = state.storedMarks ?? state.selection.$from.marks();
    return marks.some((m) => m.type === type);
  }
  return state.doc.rangeHasMark(from, to, type);
}

// The highlight colour reflected by the picker. Exported so it is unit-testable as a pure
// function of state, independent of any DOM. The rule the picker must obey:
//   - empty cursor: the highlight in the stored marks (just-toggled) or, failing that, the marks at the
//     caret — this is what a freshly-highlighted run sets, so the swatch lights up immediately.
//   - non-empty selection: the highlight colour COMMON to the whole selected text. We scan every text
//     leaf in the range and return its colour only if EVERY leaf carries highlight of the SAME colour;
//     a mixed/partly-unhighlighted selection shows NO active colour. This is the fix for "recolor a span
//     yellow->green still shows yellow": $from.marks() read the boundary char (often just OUTSIDE the
//     selection) and went stale; scanning the actual selected content reflects the real colour.
// Returns null when there is no single highlight colour to show.
export function activeHighlightColor(state: EditorState): HighlightColor | null {
  const sel = state.selection;
  const highlight = schema.marks.highlight;

  if (sel.empty) {
    const marks = state.storedMarks ?? sel.$from.marks();
    const hl = marks.find((m) => m.type === highlight);
    return hl ? (hl.attrs.color as HighlightColor) : null;
  }

  // Non-empty: the colour common across every text leaf in the selection, else null. `seeded` marks
  // whether the first leaf has set `common` yet (it stays set across ranges, so `common` is seeded once).
  let common: HighlightColor | null = null;
  let seeded = false;
  let uniform = true;
  for (const r of sel.ranges) {
    state.doc.nodesBetween(r.$from.pos, r.$to.pos, (node) => {
      if (!node.isText) return true;
      const hl = node.marks.find((m) => m.type === highlight);
      const color = hl ? (hl.attrs.color as HighlightColor) : null;
      if (!seeded) {
        common = color;
        seeded = true;
      } else if (color !== common) {
        uniform = false;
      }
      return false;
    });
  }
  return seeded && uniform ? common : null;
}

// The heading level of the current top-level block, or null if it isn't a heading. Lights up the
// matching pocket/hat/block style button — display affordance only.
function currentHeadingLevel(state: EditorState): HeadingLevel | null {
  const { $from } = state.selection;
  if ($from.depth < 1) return null;
  const block = $from.node(1);
  return block.type === schema.nodes.heading ? (block.attrs.level as HeadingLevel) : null;
}

// Capitalize a style label ("pocket" -> "Pocket").
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export function createToolbar(getView: () => EditorView): Toolbar {
  const dom = elem("div", "fl-toolbar");

  // Run a command against the current view, then refocus the editor.
  const run = (cmd: Command): void => {
    const view = getView();
    cmd(view.state, view.dispatch, view);
    view.focus();
  };

  // A labelled text button that runs `cmd` on mousedown (preventDefault keeps the selection). Returns
  // the node so callers can track active state.
  const toolButton = (label: string, title: string, cls: string, cmd: Command): HTMLButtonElement => {
    const b = elem("button", `fl-tool ${cls}`.trim());
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      run(cmd);
    });
    return b;
  };

  // ── Block-style buttons: pocket/hat/block convert the current block to a heading at that
  // level; tag/cite insert a new card (caret in tag / cite). These are the Word/Verbatim-style buttons.
  const styleGroup = elem("div", "fl-tool-group fl-style-group");
  const levelBtns: { level: HeadingLevel; node: HTMLButtonElement }[] = [];
  for (const level of HEADING_LEVELS) {
    const b = toolButton(cap(level), `${cap(level)} heading`, `fl-style fl-style-${level}`, setHeadingLevel(level));
    styleGroup.appendChild(b);
    levelBtns.push({ level, node: b });
  }
  // "Tag" converts the current block into a card (tag = its text), absorbing following paragraphs as the
  // body — the Verbatim-style "make this a card" action. "Cite" still inserts a fresh empty card
  // with the caret in the cite line. (A blank-paragraph "Tag" press absorbs nothing, so it reads as
  // "insert a card here".)
  styleGroup.appendChild(toolButton("Tag", "Make card from this block (tag)", "fl-style fl-style-tag", convertToTag()));
  styleGroup.appendChild(toolButton("Cite", "New card (caret in cite)", "fl-style fl-style-cite", insertCardAtCite));
  dom.appendChild(styleGroup);

  // Highlight swatches.
  const group = elem("div", "fl-tool-group");
  const swatches: { color: HighlightColor; node: HTMLButtonElement }[] = [];
  for (const color of HIGHLIGHT_COLORS) {
    const b = elem("button", "fl-swatch");
    b.type = "button";
    b.setAttribute("data-color", color);
    b.title = `Highlight ${color} (F11)`;
    b.setAttribute("aria-label", `Highlight ${color}`);
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      run(toggleHighlight(color));
    });
    group.appendChild(b);
    swatches.push({ color, node: b });
  }
  dom.appendChild(group);

  // Mark buttons: bold/strong (B), underline (read marker), emphasis (bold+ul+box), muted (small), and
  // Clear (strip all marks). Tooltips carry the F-key / shortcut hints. All buttons use fl- classes.
  const boldBtn = toolButton("B", "Bold — Ctrl+B", "fl-tool-strong", toggleStrong);
  const underlineBtn = toolButton("Underline", "Underline — read-aloud marker (F9, Ctrl+U)", "fl-tool-underline", toggleUnderline);
  const emphasisBtn = toolButton("Emphasis", "Emphasis — bold + underline + box (F10)", "fl-tool-emphasis", toggleEmphasis);
  const mutedBtn = toolButton("Muted", "Muted — small, skip-past text (Mod-8)", "fl-tool-muted", toggleMuted);
  // "Clear" runs clearFormatting: strip marks AND reset a heading/analytic to a plain
  // paragraph — the same action F12 performs, so the button and the key stay in lockstep.
  const clearBtn = toolButton("Clear", "Clear to plain text — strip marks + reset block (F12)", "fl-tool-clear", clearFormatting);
  dom.append(boldBtn, underlineBtn, emphasisBtn, mutedBtn, clearBtn);

  function syncActive(state: EditorState): void {
    const active = activeHighlightColor(state);
    for (const s of swatches) s.node.classList.toggle("fl-active", s.color === active);
    boldBtn.classList.toggle("fl-active", markActive(state, schema.marks.strong));
    underlineBtn.classList.toggle("fl-active", markActive(state, schema.marks.underline));
    emphasisBtn.classList.toggle("fl-active", markActive(state, schema.marks.emphasis));
    mutedBtn.classList.toggle("fl-active", markActive(state, schema.marks.muted));
    const lvl = currentHeadingLevel(state);
    for (const lb of levelBtns) lb.node.classList.toggle("fl-active", lb.level === lvl);
  }

  return { dom, syncActive };
}
