// @vitest-environment jsdom
//
// sidebar-nav.test.ts — jsdom tests for two navigation-pane affordances:
//   Documents pane: marks "this doc" (the current window) with a ▸ caret + `.fl-current` once the window
//       learns its own id (setSelfWinId), and re-marks correctly whichever of id / docs-list arrives first.
//   Outline pane: renders Word-nav-pane collapse carets — a caret only on an entry that has deeper
//       children, and collapsing a heading hides its whole subtree (siblings stay) until it is expanded again.
//
// Both panes are exercised through the real createSidebar control surface (DOM-level assertions). The Outline
// tests stub getView to expose a fixed doc as state — the Outline pane only reads state.doc (buildOutline) and
// never mutates on a caret toggle.

import { describe, it, expect, vi } from "vitest";
import type { EditorView } from "prosemirror-view";
import type { EditorState } from "prosemirror-state";
import { schema, buildCard } from "../../src/schema";
import { createSidebar } from "../../src/renderer/sidebar";
import type { OpenDocEntry } from "../../src/persistence/bridge";

// A nested outline: pocket P1 ▸ hat H1 ▸ card C1, then a SIBLING pocket P2 (so a collapse must keep P2 visible).
function outlineDoc() {
  const h = (blockId: string, level: "pocket" | "hat" | "block", text: string) =>
    schema.nodes.heading.create({ blockId, level }, schema.text(text));
  return schema.nodes.doc.create(null, [
    h("h-p1", "pocket", "Pocket One"),
    h("h-h1", "hat", "Hat One"),
    buildCard({ blockId: "c-1", tag: [schema.text("Card claim")], body: [{ blockId: "c-1-p", content: [schema.text("ev")] }] }),
    h("h-p2", "pocket", "Pocket Two"),
  ]);
}

// A sidebar on the Outline tab whose getView returns a stub view exposing the fixed doc as state.
function outlineSidebar() {
  const state = { doc: outlineDoc() } as unknown as EditorState;
  const view = { state } as unknown as EditorView;
  const sidebar = createSidebar({ getView: () => view, onFocusWindow: () => {} });
  sidebar.setTab("outline");
  sidebar.syncOutline(state);
  return sidebar;
}

const labelTexts = (sidebar: ReturnType<typeof createSidebar>): (string | null)[] =>
  [...sidebar.dom.querySelectorAll(".fl-outline-entry")].map((e) => e.textContent);

describe("Outline pane — collapse carets", () => {
  it("renders one row per entry, with a real caret only on entries that have deeper children", () => {
    const sidebar = outlineSidebar();
    expect(sidebar.dom.querySelectorAll(".fl-outline-entry")).toHaveLength(4); // P1, H1, C1, P2
    const carets = [...sidebar.dom.querySelectorAll(".fl-outline-caret")];
    expect(carets).toHaveLength(4); // one slot per row (a leaf gets an inert spacer)
    // P1 (has the hat child) and H1 (has the card child) get real carets; the card + P2 are leaves.
    expect(carets.filter((c) => !c.classList.contains("fl-leaf"))).toHaveLength(2);
  });

  it("collapsing a pocket heading hides its WHOLE subtree; expanding restores it (sibling untouched)", () => {
    const sidebar = outlineSidebar();
    expect(labelTexts(sidebar)).toEqual(["Pocket One", "Hat One", "Card claim", "Pocket Two"]);

    // P1's caret is the first row's caret. Collapse → hide H1 + the card, keep the sibling pocket P2.
    (sidebar.dom.querySelector(".fl-outline-row .fl-outline-caret") as HTMLButtonElement).click();
    expect(labelTexts(sidebar)).toEqual(["Pocket One", "Pocket Two"]);
    expect((sidebar.dom.querySelector(".fl-outline-row .fl-outline-caret") as HTMLElement).textContent).toBe("▸");

    // Expand again → all four return, caret flips back to ▾.
    (sidebar.dom.querySelector(".fl-outline-row .fl-outline-caret") as HTMLButtonElement).click();
    expect(labelTexts(sidebar)).toEqual(["Pocket One", "Hat One", "Card claim", "Pocket Two"]);
    expect((sidebar.dom.querySelector(".fl-outline-row .fl-outline-caret") as HTMLElement).textContent).toBe("▾");
  });

  it("collapsing only the hat hides just its card child, not the sibling pocket", () => {
    const sidebar = outlineSidebar();
    const hatCaret = [...sidebar.dom.querySelectorAll(".fl-outline-row")][1].querySelector(".fl-outline-caret") as HTMLButtonElement;
    hatCaret.click();
    expect(labelTexts(sidebar)).toEqual(["Pocket One", "Hat One", "Pocket Two"]); // card hidden, P2 still shown
  });

  it("handles a NON-CONTIGUOUS tier jump (pocket → card, skipping hat/block): collapse still hides the deep child", () => {
    // buildOutline tiers are non-contiguous (pocket 0 then card 3) — exercises the `tier > collapseFloor` test
    // across a gap. The pocket still "owns" the deeper card as its subtree.
    const h = (blockId: string, text: string) => schema.nodes.heading.create({ blockId, level: "pocket" as const }, schema.text(text));
    const state = {
      doc: schema.nodes.doc.create(null, [
        h("p", "Pocket"),
        buildCard({ blockId: "c", tag: [schema.text("Card")], body: [{ blockId: "c-p", content: [schema.text("x")] }] }),
        h("p2", "Pocket Two"),
      ]),
    } as unknown as EditorState;
    const view = { state } as unknown as EditorView;
    const sidebar = createSidebar({ getView: () => view, onFocusWindow: () => {} });
    sidebar.setTab("outline");
    sidebar.syncOutline(state);
    expect(labelTexts(sidebar)).toEqual(["Pocket", "Card", "Pocket Two"]);
    // The pocket has a child (the card, tier 3 > 0) → a real caret. Collapse → hide the card, keep the sibling.
    (sidebar.dom.querySelector(".fl-outline-row .fl-outline-caret") as HTMLButtonElement).click();
    expect(labelTexts(sidebar)).toEqual(["Pocket", "Pocket Two"]);
  });
});

describe("Documents pane — 'this doc' marker", () => {
  // The Documents pane never reads the view, so a throwing stub asserts it stays view-independent.
  const makeDocsSidebar = () =>
    createSidebar({ getView: () => { throw new Error("Documents pane must not read the view"); }, onFocusWindow: () => {} });

  it("marks ONLY the current window's row (caret + .fl-current) once setSelfWinId resolves", () => {
    const sidebar = makeDocsSidebar();
    const docs: OpenDocEntry[] = [
      { winId: 1, title: "Alpha", dirty: false },
      { winId: 2, title: "Bravo (me)", dirty: false },
      { winId: 3, title: "Charlie", dirty: true },
    ];
    sidebar.setOpenDocs(docs);
    // Before we know our own id, nothing is marked and every caret slot is empty.
    expect(sidebar.dom.querySelector(".fl-doc-entry.fl-current")).toBeNull();
    expect([...sidebar.dom.querySelectorAll(".fl-doc-current")].every((s) => s.textContent === "")).toBe(true);

    sidebar.setSelfWinId(2); // our window is #2
    const current = sidebar.dom.querySelectorAll(".fl-doc-entry.fl-current");
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain("Bravo (me)");
    // Exactly one row shows the ▸ caret.
    expect([...sidebar.dom.querySelectorAll(".fl-doc-current")].filter((s) => s.textContent === "▸")).toHaveLength(1);
  });

  it("marks correctly even if the window id arrives BEFORE the docs list", () => {
    const sidebar = makeDocsSidebar();
    sidebar.setSelfWinId(7); // id first
    sidebar.setOpenDocs([
      { winId: 7, title: "self", dirty: false },
      { winId: 8, title: "other", dirty: false },
    ]);
    const current = sidebar.dom.querySelectorAll(".fl-doc-entry.fl-current");
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain("self");
  });

  it("renders a '+ New document' button at the top that fires onNewDoc when clicked", () => {
    const onNewDoc = vi.fn();
    const sidebar = createSidebar({
      getView: () => { throw new Error("Documents pane must not read the view"); },
      onFocusWindow: () => {},
      onNewDoc,
    });
    sidebar.setOpenDocs([{ winId: 1, title: "Alpha", dirty: false }]);
    const newBtn = sidebar.dom.querySelector(".fl-doc-new") as HTMLButtonElement | null;
    expect(newBtn).not.toBeNull();
    expect(newBtn!.textContent).toBe("+ New document");
    // It is the FIRST child of the Documents pane (above the open-windows rows).
    expect(newBtn!.previousElementSibling).toBeNull();
    newBtn!.click();
    expect(onNewDoc).toHaveBeenCalledTimes(1);
  });
});
