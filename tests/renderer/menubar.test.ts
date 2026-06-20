// menubar.test.ts — E10: proves the in-renderer application menu bar (renderer/menubar.ts) renders the native
// menu's command vocabulary and dispatches the correct MenuCommand for each item. Pure jsdom DOM + a stub dispatch,
// so the menu structure and command wiring are proven with no Electron, no view, and no native menu. The actual
// look (theme colors, positioning) is the human gate; this nails down the structure and the command mapping.

import { describe, it, expect, vi, afterEach } from "vitest";
import { createMenuBar, type MenuBar } from "../../src/renderer/menubar";

// Fire a cancelable, bubbling mousedown (the bar listens on mousedown, not click, to preserve editor focus).
function md(el: Element): void {
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
}
const titlesOf = (dom: HTMLElement): (string | null)[] =>
  [...dom.querySelectorAll(".fl-menubar-trigger")].map((t) => t.textContent);
const labelsOf = (panel: Element): (string | null)[] =>
  [...panel.querySelectorAll(".fl-menu-item")].map((i) => i.querySelector(".fl-menu-item-label")!.textContent);

// Track every bar so afterEach disposes its document-level listeners. In production there is one bar per window
// (window-lifetime), but this suite builds several in the same jsdom document — destroy() keeps them isolated and
// also exercises the disposability contract.
const bars: MenuBar[] = [];
function mount(opts: Parameters<typeof createMenuBar>[0]): MenuBar {
  const bar = createMenuBar(opts);
  bars.push(bar);
  document.body.appendChild(bar.dom);
  return bar;
}
afterEach(() => {
  while (bars.length) bars.pop()!.destroy();
  document.body.innerHTML = "";
});

describe("in-renderer menu bar (E10)", () => {
  it("renders the four top-level menus in order", () => {
    const { dom } = mount({ dispatch: vi.fn() });
    expect(titlesOf(dom)).toEqual(["File", "Edit", "View", "Window"]);
  });

  it("opens the File dropdown on trigger mousedown, with the file commands in order", () => {
    const { dom } = mount({ dispatch: vi.fn() });
    md(dom.querySelector(".fl-menubar-trigger")!); // File is first
    const panel = dom.querySelector(".fl-menu-dropdown")!;
    expect(panel).toBeTruthy();
    expect(labelsOf(panel)).toEqual(["New", "Open…", "Save", "Save As…", "Export to Word…"]);
  });

  it("dispatches the correct MenuCommand and closes the dropdown when an item is clicked", () => {
    const dispatch = vi.fn();
    const { dom } = mount({ dispatch });
    md(dom.querySelector(".fl-menubar-trigger")!); // File
    const items = [...dom.querySelectorAll(".fl-menu-item")];
    md(items[2]); // "Save"
    expect(dispatch).toHaveBeenCalledWith("save");
    expect(dom.querySelector(".fl-menu-dropdown")).toBeNull(); // closed after selection
  });

  it("maps every menu's items to their commands (edit/view/window)", () => {
    const dispatch = vi.fn();
    const { dom } = mount({ dispatch });
    const triggers = [...dom.querySelectorAll(".fl-menubar-trigger")];
    const pick = (triggerIdx: number, label: string): void => {
      md(triggers[triggerIdx]);
      const item = [...dom.querySelectorAll(".fl-menu-item")].find(
        (i) => i.querySelector(".fl-menu-item-label")!.textContent === label,
      )!;
      md(item);
    };
    pick(1, "Undo"); // Edit
    pick(2, "Toggle Sidebar"); // View
    pick(3, "Close"); // Window
    expect(dispatch.mock.calls.map((c) => c[0])).toEqual(["edit:undo", "view:toggleSidebar", "window:close"]);
  });

  it("closes the open dropdown on Escape", () => {
    const { dom } = mount({ dispatch: vi.fn() });
    md(dom.querySelector(".fl-menubar-trigger")!);
    expect(dom.querySelector(".fl-menu-dropdown")).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(dom.querySelector(".fl-menu-dropdown")).toBeNull();
  });

  it("destroy() removes the document listeners (Escape no longer closes a fresh bar's menu)", () => {
    const bar = mount({ dispatch: vi.fn() });
    bar.destroy();
    // After destroy, re-open via the trigger (its own listener is intact) but Escape — a document listener — is gone.
    md(bar.dom.querySelector(".fl-menubar-trigger")!);
    expect(bar.dom.querySelector(".fl-menu-dropdown")).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(bar.dom.querySelector(".fl-menu-dropdown")).toBeTruthy(); // still open — Escape listener was removed
  });
});
