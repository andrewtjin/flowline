// toolbar.ts — the mark toolbar: four highlight colour swatches + emphasis + muted.
//
// Pure renderer UI, built from `fl-`-classed DOM (clean-implementation CSS gate). Each control runs a mark
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
  toggleCite,
  clearFormatting,
  setHeadingLevel,
  convertToTag,
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

// Truthful keyboard hint shown as a gray sublabel on each heading-style button — matches the F4/F5/F6
// bindings in runtime.ts (structuralKeyBindings). Tag(F7)/Cite(F8)/Underline(F9)/Clear(F12) carry hints inline.
const STYLE_HINTS: Record<HeadingLevel, string> = { pocket: "F4", hat: "F5", block: "F6" };

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
  // `hint`, when given, renders a gray/lighter shortcut sublabel (e.g. "F4") as a child span AFTER the label.
  // The label is set via a TEXT NODE (not b.textContent =, which would clobber the appended hint span). The
  // hint is display-only — the real binding lives in runtime.ts (structuralKeyBindings / the mark F-keys).
  const toolButton = (label: string, title: string, cls: string, cmd: Command, hint?: string): HTMLButtonElement => {
    const b = elem("button", `fl-tool ${cls}`.trim());
    b.type = "button";
    // Label lives in its OWN span (not a bare text node) so per-button label styling decorates the WORD only —
    // the Underline button underlines its label; Emphasis boxes+underlines its label (it self-demonstrates the
    // mark it applies). Keeping the decoration on `.fl-tool-label` rather than the whole button is what stops it
    // bleeding onto the gray F-key hint: a CSS ancestor underline cannot be cancelled by a descendant, so the
    // hint must live OUTSIDE the decorated span — which is exactly why "F10" reads plain inside Emphasis.
    const labelSpan = elem("span", "fl-tool-label");
    labelSpan.textContent = label;
    b.appendChild(labelSpan);
    if (hint) {
      const h = elem("span", "fl-tool-hint");
      h.textContent = hint;
      b.appendChild(h);
    }
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
    const key = STYLE_HINTS[level];
    const b = toolButton(cap(level), `${cap(level)} heading (${key})`, `fl-style fl-style-${level}`, setHeadingLevel(level), key);
    styleGroup.appendChild(b);
    levelBtns.push({ level, node: b });
  }
  // "Tag" converts the current block into a card (tag = its text), absorbing following paragraphs as the
  // body — the Verbatim-style "make this a card" action. (A blank-paragraph "Tag" press absorbs nothing, so it
  // reads as "insert a card here".) "Cite" toggles the inline CITE MARK on the selection (bold, full-size
  // source styling) — it no longer inserts a card; cite is a mark now, so it lights up like the other mark
  // buttons when the selection carries it.
  styleGroup.appendChild(toolButton("Tag", "Make card from this block (tag) — F7", "fl-style fl-style-tag", convertToTag(), "F7"));
  const citeBtn = toolButton("Cite", "Toggle citation — bold source style on the selection (F8)", "fl-style fl-style-cite", toggleCite, "F8");
  styleGroup.appendChild(citeBtn);
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
  // The F11 shortcut toggles highlight (default colour). The swatches are colour-only with no space for a label,
  // so a gray "F11" hint after them mirrors the F-key sublabels on the other buttons.
  const highlightHint = elem("span", "fl-tool-hint");
  highlightHint.textContent = "F11";
  group.appendChild(highlightHint);
  dom.appendChild(group);

  // Mark buttons: bold/strong (B), underline (read marker), emphasis (bold+ul+box), muted (small), and
  // Clear (strip all marks). Tooltips carry the F-key / shortcut hints. All buttons use fl- classes.
  const boldBtn = toolButton("B", "Bold — Ctrl+B", "fl-tool-strong", toggleStrong);
  const underlineBtn = toolButton("Underline", "Underline — read-aloud marker (F9, Ctrl+U)", "fl-tool-underline", toggleUnderline, "F9");
  const emphasisBtn = toolButton("Emphasis", "Emphasis — bold + underline + box (F10)", "fl-tool-emphasis", toggleEmphasis, "F10");
  const mutedBtn = toolButton("Muted", "Muted — small, skip-past text (Mod-8)", "fl-tool-muted", toggleMuted);
  // "Clear" runs clearFormatting: strip marks AND reset a heading/analytic to a plain
  // paragraph — the same action F12 performs, so the button and the key stay in lockstep.
  const clearBtn = toolButton("Clear", "Clear to plain text — strip marks + reset block (F12)", "fl-tool-clear", clearFormatting, "F12");
  dom.append(boldBtn, underlineBtn, emphasisBtn, mutedBtn, clearBtn);

  function syncActive(state: EditorState): void {
    const active = activeHighlightColor(state);
    for (const s of swatches) s.node.classList.toggle("fl-active", s.color === active);
    boldBtn.classList.toggle("fl-active", markActive(state, schema.marks.strong));
    underlineBtn.classList.toggle("fl-active", markActive(state, schema.marks.underline));
    emphasisBtn.classList.toggle("fl-active", markActive(state, schema.marks.emphasis));
    mutedBtn.classList.toggle("fl-active", markActive(state, schema.marks.muted));
    citeBtn.classList.toggle("fl-active", markActive(state, schema.marks.cite));
    const lvl = currentHeadingLevel(state);
    for (const lb of levelBtns) lb.node.classList.toggle("fl-active", lb.level === lvl);
  }

  return { dom, syncActive };
}
