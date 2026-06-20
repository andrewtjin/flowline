// renderer/menubar.ts — the in-renderer application menu bar.
//
// WHY THIS EXISTS: the native Electron menu (File/Edit/View/Window, built in main/index.ts) only exists in the
// desktop app. The browser dev preview and the web build have NO menu at all, so those actions are invisible and
// undiscoverable there. This renders the SAME command vocabulary as a themeable DOM menu bar in the topbar,
// dispatching through the one `MenuCommand` seam the renderer already owns (dispatchMenuCommand in main.ts). On
// desktop the native menu bar is auto-hidden (main/index.ts), so this DOM bar is the single VISIBLE menu while
// the native accelerators (Ctrl+N/S/W…) keep firing.
//
// It is pure presentation: it knows nothing about what a command DOES — it only emits MenuCommands to the host.
// Clean-room: every class is `fl-` prefixed. No schema, no document state.

import type { MenuCommand } from "../persistence/bridge";

export interface MenuBar {
  /** The menu-bar root element — the caller mounts it (e.g. after the topbar brand). */
  readonly dom: HTMLElement;
  /** Close any open dropdown — call when the host opens a modal or otherwise needs the menu dismissed. */
  closeAll(): void;
  /** Remove the document-level listeners. Not needed in normal use (one bar per window, window-lifetime), but makes
   *  the bar safely disposable for HMR / tests / any future site that builds more than one bar in a document. */
  destroy(): void;
}

// One row in a dropdown: an item that emits a MenuCommand (with an optional display-only shortcut hint), or a
// separator that renders a divider rule. The hint is cosmetic — the real accelerator lives in the keymap / the
// native menu; the bar never registers a shortcut itself.
type MenuRow =
  | { readonly kind: "item"; readonly label: string; readonly cmd: MenuCommand; readonly hint?: string }
  | { readonly kind: "separator" };

// A top-level menu: a title + its rows. Mirrors the native `buildMenu` template MINUS the MAIN-only entries that
// have no MenuCommand and cannot run in the renderer (Quit, the native Cut/Copy/Paste roles, Minimize, and the
// live open-windows list). Those stay native-only.
interface MenuDef {
  readonly title: string;
  readonly rows: readonly MenuRow[];
}

const item = (label: string, cmd: MenuCommand, hint?: string): MenuRow => ({ kind: "item", label, cmd, hint });
const SEP: MenuRow = { kind: "separator" };

// Platform-aware modifier label for the hints (⌘ on macOS, Ctrl elsewhere). `navigator` is always present in the
// renderer (browser + Electron); a wrong guess is purely cosmetic. userAgent (not the deprecated platform) is used.
const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
const MOD = IS_MAC ? "⌘" : "Ctrl";

// The menu structure: File / Edit / View / Window.
function menuDefs(): MenuDef[] {
  return [
    {
      title: "File",
      rows: [
        // This in-renderer bar is WEB-ONLY (desktop uses the native menu, where New is the native Ctrl+N). On web
        // Ctrl+N is browser-reserved, so the real web New accelerator is Ctrl+M, ctrl-only — see web-keys.ts isNewChord.
        // The chord is ctrl-ONLY on every platform (never ⌘, to dodge macOS ⌘M-minimize), so the hint shows ⌃M on Mac.
        item("New", "new", IS_MAC ? "⌃M" : "Ctrl+M"),
        item("Open…", "open", `${MOD}+O`),
        SEP,
        item("Save", "save", `${MOD}+S`),
        item("Save As…", "saveAs", `${MOD}+Shift+S`),
        SEP,
        item("Export to Word…", "export", `${MOD}+Shift+E`),
      ],
    },
    {
      title: "Edit",
      rows: [item("Undo", "edit:undo", `${MOD}+Z`), item("Redo", "edit:redo", IS_MAC ? "⇧⌘Z" : "Ctrl+Y")],
    },
    {
      title: "View",
      rows: [
        item("Toggle Sidebar", "view:toggleSidebar"),
        SEP,
        item("Documents", "view:tabDocuments"),
        item("Outline", "view:tabOutline"),
      ],
    },
    { title: "Window", rows: [item("Close", "window:close", `${MOD}+W`)] },
  ];
}

// Build a single dropdown panel for `def`, wiring each item to dispatch+close. Returned, not yet mounted.
function buildDropdown(def: MenuDef, dispatch: (cmd: MenuCommand) => void, close: () => void): HTMLElement {
  const dropdown = document.createElement("div");
  dropdown.className = "fl-menu-dropdown";
  dropdown.setAttribute("role", "menu");
  for (const row of def.rows) {
    if (row.kind === "separator") {
      const hr = document.createElement("div");
      hr.className = "fl-menu-sep";
      dropdown.appendChild(hr);
      continue;
    }
    const it = document.createElement("button");
    it.type = "button";
    it.className = "fl-menu-item";
    it.setAttribute("role", "menuitem");
    const lbl = document.createElement("span");
    lbl.className = "fl-menu-item-label";
    lbl.textContent = row.label;
    it.appendChild(lbl);
    if (row.hint) {
      const h = document.createElement("span");
      h.className = "fl-menu-item-hint";
      h.textContent = row.hint;
      it.appendChild(h);
    }
    // mousedown + preventDefault keeps the editor's focus/selection intact (the same reason the toolbar uses
    // mousedown, not click): a click would blur the editor before a selection-dependent command (undo/redo) runs.
    it.addEventListener("mousedown", (e) => {
      e.preventDefault();
      close();
      dispatch(row.cmd);
    });
    dropdown.appendChild(it);
  }
  return dropdown;
}

/**
 * Create the in-renderer menu bar. `dispatch` runs a MenuCommand (the host's `dispatchMenuCommand`).
 */
export function createMenuBar(opts: { dispatch: (cmd: MenuCommand) => void }): MenuBar {
  const dom = document.createElement("nav");
  dom.className = "fl-menubar";
  dom.setAttribute("aria-label", "Application menu");

  // Exactly one dropdown is open at a time. Tracking both the panel and its trigger lets click-outside, Escape, and
  // a second click on the same trigger all resolve to a clean close.
  let openPanel: HTMLElement | null = null;
  let openTrigger: HTMLButtonElement | null = null;

  const closeAll = (): void => {
    openPanel?.remove();
    openTrigger?.classList.remove("fl-menubar-open");
    openPanel = null;
    openTrigger = null;
  };

  const openFor = (trigger: HTMLButtonElement, def: MenuDef): void => {
    closeAll();
    const panel = buildDropdown(def, opts.dispatch, closeAll);
    trigger.classList.add("fl-menubar-open");
    // The slot is position:relative, so the absolutely-positioned panel anchors directly under its trigger.
    trigger.parentElement?.appendChild(panel);
    openPanel = panel;
    openTrigger = trigger;
  };

  for (const def of menuDefs()) {
    const slot = document.createElement("div");
    slot.className = "fl-menubar-slot";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "fl-menubar-trigger";
    trigger.textContent = def.title;
    // mousedown toggles: re-clicking the open menu closes it, clicking another switches. stopPropagation keeps the
    // document-level closer (below) from immediately re-closing what we just opened.
    trigger.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (openTrigger === trigger) closeAll();
      else openFor(trigger, def);
    });
    // Hover-to-switch: once any menu is open, hovering a different top-level opens it (classic menu-bar behavior).
    trigger.addEventListener("mouseenter", () => {
      if (openPanel && openTrigger !== trigger) openFor(trigger, def);
    });
    slot.appendChild(trigger);
    dom.appendChild(slot);
  }

  // Global closers: a mousedown anywhere outside the open panel, or the Escape key, dismisses the menu. They hang off
  // `document` (the trigger/panel handlers stopPropagation so opening doesn't immediately re-close). Both are tied to
  // an AbortController so the bar is cleanly disposable — `destroy()` removes them. Normal use never needs that (one
  // bar per window, window-lifetime), but HMR and tests can build several bars in one document.
  const ac = new AbortController();
  document.addEventListener(
    "mousedown",
    (e) => {
      if (openPanel && !openPanel.contains(e.target as Node)) closeAll();
    },
    { signal: ac.signal },
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") closeAll();
    },
    { signal: ac.signal },
  );

  const destroy = (): void => {
    closeAll();
    ac.abort();
  };
  return { dom, closeAll, destroy };
}
