// sidebar-web-docs.test.ts — the WEB in-window MDI Documents pane (sidebar.setWebDocs). E10b-S4 (+ S5 affordance).
//
// Proves the web Documents pane renders the registry list with the active (▸) + dirty (●) markers and a "+ New
// document" button, and that the title (switch) and × (close) buttons fire the host callbacks with the correct
// registry id. Pure jsdom DOM + stub handlers + a fake view (the pane needs getView for the OUTLINE pane only,
// never for the web docs render). The look/theme is the human gate; this nails the structure + wiring.

import { describe, it, expect, vi } from "vitest";
import { EditorState } from "prosemirror-state";
import { createSidebar } from "../../src/renderer/sidebar";
import type { DocView } from "../../src/renderer/doc-registry";
import { schema } from "../../src/schema";
import { createSeedDoc } from "../../src/seed";

// A minimal fake EditorView good enough for the sidebar's outline sync (the web docs pane never reads it).
const fakeView = () =>
  ({ state: EditorState.create({ schema, doc: createSeedDoc() }) }) as unknown as Parameters<typeof createSidebar>[0]["getView"] extends () => infer V ? V : never;

const make = () => {
  const sidebar = createSidebar({ getView: () => fakeView(), onFocusWindow: vi.fn() });
  document.body.appendChild(sidebar.dom);
  return sidebar;
};

const views = (docs: Array<Partial<DocView> & { id: string }>): DocView[] =>
  docs.map((d) => ({ id: d.id, path: d.path ?? null, dirty: d.dirty ?? false, title: d.title ?? "Untitled", active: d.active ?? false }));

describe("web Documents pane (S4)", () => {
  it("renders a + New button and one row per open doc, with the active/dirty markers", () => {
    const sidebar = make();
    const handlers = { onSelect: vi.fn(), onClose: vi.fn(), onNew: vi.fn() };
    sidebar.setWebDocs(
      views([
        { id: "d0", title: "speech.fl", active: false, dirty: true },
        { id: "d1", title: "Untitled", active: true, dirty: false },
      ]),
      handlers,
    );
    expect(sidebar.dom.querySelector(".fl-doc-new")).toBeTruthy();
    const rows = [...sidebar.dom.querySelectorAll(".fl-doc-entry")];
    expect(rows.length).toBe(2);
    // d0 is dirty (● + fl-dirty), d1 is active (▸ + fl-current).
    expect(rows[0].classList.contains("fl-dirty")).toBe(true);
    expect(rows[0].querySelector(".fl-doc-marker")!.textContent).toBe("●");
    expect(rows[1].classList.contains("fl-current")).toBe(true);
    expect(rows[1].querySelector(".fl-doc-current")!.textContent).toBe("▸");
    expect([...sidebar.dom.querySelectorAll(".fl-doc-title")].map((t) => t.textContent)).toEqual(["speech.fl", "Untitled"]);
  });

  it("clicking a row title fires onSelect with that doc's id", () => {
    const sidebar = make();
    const onSelect = vi.fn();
    sidebar.setWebDocs(views([{ id: "d0", title: "A" }, { id: "d1", title: "B" }]), { onSelect, onClose: vi.fn(), onNew: vi.fn() });
    (sidebar.dom.querySelectorAll(".fl-doc-switch")[1] as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledWith("d1");
  });

  it("clicking a row × fires onClose with that doc's id (the S5 close affordance)", () => {
    const sidebar = make();
    const onClose = vi.fn();
    sidebar.setWebDocs(views([{ id: "d0", title: "A" }, { id: "d1", title: "B" }]), { onSelect: vi.fn(), onClose, onNew: vi.fn() });
    (sidebar.dom.querySelectorAll(".fl-doc-close")[0] as HTMLElement).click();
    expect(onClose).toHaveBeenCalledWith("d0");
  });

  it("clicking + New document fires onNew", () => {
    const sidebar = make();
    const onNew = vi.fn();
    sidebar.setWebDocs(views([{ id: "d0", title: "A" }]), { onSelect: vi.fn(), onClose: vi.fn(), onNew });
    (sidebar.dom.querySelector(".fl-doc-new") as HTMLElement).click();
    expect(onNew).toHaveBeenCalledOnce();
  });

  it("re-rendering with setWebDocs replaces the list (no stale rows)", () => {
    const sidebar = make();
    const handlers = { onSelect: vi.fn(), onClose: vi.fn(), onNew: vi.fn() };
    sidebar.setWebDocs(views([{ id: "d0", title: "A" }, { id: "d1", title: "B" }]), handlers);
    expect(sidebar.dom.querySelectorAll(".fl-doc-entry").length).toBe(2);
    sidebar.setWebDocs(views([{ id: "d0", title: "A" }]), handlers); // one closed
    expect(sidebar.dom.querySelectorAll(".fl-doc-entry").length).toBe(1);
  });
});
