// toolbar.test.ts — unit tests for the picker-colour derivation (cheap, jsdom, no browser).
// Proves `activeHighlightColor(state)` reflects the highlight AT the caret/selection: a freshly
// highlighted run lights the right swatch, a recoloured run shows the NEW colour, and a
// selection with no/mixed highlight shows NO active colour. This is the unit proof that the
// recolour bug is fixed without an e2e — the helper is a pure function of EditorState.

import { describe, it, expect } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { schema } from "../src/schema";
import { toggleHighlight } from "../src/commands";
import { activeHighlightColor, createToolbar } from "../src/toolbar";

const hl = schema.marks.highlight;

// Single-paragraph doc; text content begins at pos 1, paragraph closes at content.size - 1.
function paraState(text = "hello world"): EditorState {
  const doc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create({ blockId: "p1" }, schema.text(text))]);
  return EditorState.create({ schema, doc });
}
function selectAll(state: EditorState): EditorState {
  const to = state.doc.content.size - 1;
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, to)));
}
function cursorAt(state: EditorState, pos: number): EditorState {
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}
// Apply a command and return the resulting state, keeping the command's own selection.
function apply(state: EditorState, cmd: (s: EditorState, d: (tr: import("prosemirror-state").Transaction) => void) => boolean): EditorState {
  let next = state;
  cmd(state, (tr) => {
    next = state.apply(tr);
  });
  return next;
}

describe("activeHighlightColor", () => {
  it("returns null when nothing is highlighted", () => {
    expect(activeHighlightColor(selectAll(paraState()))).toBeNull();
  });

  it("reflects the colour of a freshly-highlighted selection (was: showed nothing)", () => {
    const s = apply(selectAll(paraState()), toggleHighlight("yellow"));
    expect(activeHighlightColor(s)).toBe("yellow");
  });

  it("reflects the NEW colour after a recolor yellow -> green (the recolour bug)", () => {
    const yellow = apply(selectAll(paraState()), toggleHighlight("yellow"));
    const green = apply(yellow, toggleHighlight("green"));
    expect(activeHighlightColor(green)).toBe("green");
  });

  it("shows the stored-mark colour at a bare cursor (next typed run will be highlighted)", () => {
    const s = apply(cursorAt(paraState(), 1), toggleHighlight("blue"));
    expect(activeHighlightColor(s)).toBe("blue");
  });

  it("shows NO active colour for a selection that is only partly highlighted (mixed)", () => {
    // Highlight only the first three chars, then select the whole paragraph.
    const base = paraState("abcdef");
    const partial = base.apply(base.tr.setSelection(TextSelection.create(base.doc, 1, 4)));
    const highlighted = apply(partial, toggleHighlight("green"));
    const whole = highlighted.apply(
      highlighted.tr.setSelection(TextSelection.create(highlighted.doc, 1, highlighted.doc.content.size - 1)),
    );
    expect(activeHighlightColor(whole)).toBeNull();
  });

  it("is uniform => returns the common colour when the WHOLE selection shares one colour", () => {
    const s = apply(selectAll(paraState()), toggleHighlight("blue"));
    const reselected = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 1, s.doc.content.size - 1)));
    expect(activeHighlightColor(reselected)).toBe("blue");
  });

  it("derives directly from a doc that carries the highlight mark (no command needed)", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ blockId: "p1" }, schema.text("hi", [hl.create({ color: "lightGray" })])),
    ]);
    let s = EditorState.create({ schema, doc });
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 1, s.doc.content.size - 1)));
    expect(activeHighlightColor(s)).toBe("lightGray");
  });
});

describe("toolbar shortcut hints (E6)", () => {
  // createToolbar builds every button synchronously; getView is only read on a click, so a never-called stub
  // lets us inspect the rendered DOM with no real EditorView.
  const build = (): HTMLElement =>
    createToolbar((() => {
      throw new Error("view not needed for hint render");
    }) as unknown as () => import("prosemirror-view").EditorView).dom;

  const hintOf = (dom: HTMLElement, sel: string): string | null =>
    dom.querySelector(`${sel} .fl-tool-hint`)?.textContent ?? null;

  it("renders the truthful F-key sublabel on each requested button", () => {
    const dom = build();
    expect(hintOf(dom, ".fl-style-pocket")).toBe("F4");
    expect(hintOf(dom, ".fl-style-hat")).toBe("F5");
    expect(hintOf(dom, ".fl-style-block")).toBe("F6");
    expect(hintOf(dom, ".fl-style-tag")).toBe("F7");
    expect(hintOf(dom, ".fl-style-cite")).toBe("F8");
    expect(hintOf(dom, ".fl-tool-underline")).toBe("F9");
    expect(hintOf(dom, ".fl-tool-emphasis")).toBe("F10");
    expect(hintOf(dom, ".fl-tool-clear")).toBe("F12");
    // Highlight (F11) labels the colour-swatch group (swatches are colour-only): the hint is a sibling of the swatches.
    const swatchGroup = dom.querySelector(".fl-swatch")!.parentElement as HTMLElement;
    expect(swatchGroup.querySelector(".fl-tool-hint")?.textContent).toBe("F11");
  });

  it("keeps the label text alongside the hint (label not clobbered by the hint span)", () => {
    const dom = build();
    const pocket = dom.querySelector(".fl-style-pocket") as HTMLButtonElement;
    expect(pocket.textContent).toContain("Pocket");
    expect(pocket.querySelector(".fl-tool-hint")?.textContent).toBe("F4");
  });

  it("does not add hints to the non-F-key buttons (Bold=Mod-B, Muted=Mod-8)", () => {
    const dom = build();
    expect(dom.querySelector(".fl-tool-strong .fl-tool-hint")).toBeNull();
    expect(dom.querySelector(".fl-tool-muted .fl-tool-hint")).toBeNull();
  });

  // Structural proof of the F10-underline fix: each label is its own `.fl-tool-label` span and the F-key hint is a
  // SIBLING of it, never a descendant. The Underline/Emphasis label decoration (CSS) therefore cannot bleed onto the
  // hint — "F10" stays plain inside the bold+underlined+boxed Emphasis button. (Actual paint is the human gate.)
  it("wraps each label in a .fl-tool-label span with the hint OUTSIDE it (so label decoration can't reach the hint)", () => {
    const dom = build();
    const emphasis = dom.querySelector(".fl-tool-emphasis") as HTMLButtonElement;
    expect(emphasis.querySelector(".fl-tool-label")?.textContent).toBe("Emphasis");
    expect(emphasis.querySelector(".fl-tool-label")?.querySelector(".fl-tool-hint")).toBeNull();
    expect(emphasis.querySelector(".fl-tool-hint")?.textContent).toBe("F10");
    const underline = dom.querySelector(".fl-tool-underline") as HTMLButtonElement;
    expect(underline.querySelector(".fl-tool-label")?.textContent).toBe("Underline");
    expect(underline.querySelector(".fl-tool-label")?.querySelector(".fl-tool-hint")).toBeNull();
  });
});
