// sidebar.ts — the single, TABBED left sidebar. Documents | Outline; one pane visible at a time.
//
// WHY a standalone component: the sidebar is renderer UI with its own DOM + a tiny visible/tab/selected-tab
// state machine, all of it SESSION state (never in the doc). It reads the doc READ-ONLY via the pure
// `buildOutline`/`resolveBlockPos` helpers (outline.ts) and scrolls a clicked heading into view THROUGH the
// existing `view.dispatch` seam (NO doc mutation, NO new dispatch path — same dispatch tail the DEV
// `__flowlineCaret` affordance uses in main.ts). The Documents pane lists the open windows MAIN broadcasts and
// focuses a window on click. All of that lives behind the small interface this returns so main.ts only wires.
//
// CONTAINMENT: every class is `fl-`-prefixed. The component owns no persisted state — toggling/visibility/
// active-tab are pure in-memory affordances.

import { TextSelection } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { OpenDocEntry } from "../persistence/bridge";
import type { DocView } from "./doc-registry";
import { buildOutline, resolveBlockPos } from "./outline";

// Which tab is showing. The two values map 1:1 to the two panes (only one mounted-visible at a time).
type SidebarTab = "documents" | "outline";

/**
 * The dependencies the sidebar needs from its host (renderer/main.ts). Kept to the minimum so the component is
 * decoupled from the file-op/session machinery:
 *   - getView()       — the live EditorView (lazily read at click time, after construction; mirrors main.ts).
 *   - onFocusWindow() — invoked with a winId when a Documents entry is clicked (host calls bridge.focusWindow).
 */
export interface SidebarDeps {
  readonly getView: () => EditorView;
  readonly onFocusWindow: (winId: number) => void;
  /**
   * Create a new document — invoked by the "+ New document" button atop the DESKTOP Documents pane (mirrors the
   * web pane's button + File▸New). Optional: omitted in tests/contexts that don't wire New, where the button is
   * inert. (The web MDI pane has its own onNew via WebDocHandlers; this is the desktop multi-window path.)
   */
  readonly onNewDoc?: () => void;
}

/**
 * Callbacks for the WEB (in-window MDI) Documents pane: select a doc by its registry id, close a doc by id, or
 * create a new doc. Distinct from the desktop pane (which focuses a separate BrowserWindow); the web pane swaps
 * the ACTIVE in-window doc and shows a per-row close (x). Wired by main.ts only when `!window.flowline`.
 */
export interface WebDocHandlers {
  readonly onSelect: (id: string) => void;
  readonly onClose: (id: string) => void;
  readonly onNew: () => void;
}

/** The narrow control surface main.ts drives. Everything else (DOM, tab/visibility state) is private. */
export interface Sidebar {
  /** The root element to mount into `.fl-main-row` (before the surface, as the left column). */
  readonly dom: HTMLElement;
  /** Re-render the Documents pane from MAIN's latest open-windows broadcast (DESKTOP multi-window). */
  setOpenDocs(docs: OpenDocEntry[]): void;
  /**
   * Re-render the Documents pane from the WEB in-window MDI registry. One-time `handlers` wire select/close/new;
   * `docs` is re-passed on every registry mutation. Mutually exclusive with `setOpenDocs` — a window is either the
   * desktop multi-window shell or the web single-window MDI, never both.
   */
  setWebDocs(docs: DocView[], handlers: WebDocHandlers): void;
  /** Re-derive + re-render the Outline pane from the current editor state (called in the dispatch seam). */
  syncOutline(state: EditorState): void;
  /** Show/hide the whole sidebar (the bottom strip + View menu toggle this). */
  setVisible(visible: boolean): void;
  /** Switch the active tab (the View menu's tab commands call this). */
  setTab(tab: SidebarTab): void;
  /** Flip visibility (the bottom strip button + the View toggle command). */
  toggle(): void;
  /** Tell the sidebar which BrowserWindow is THIS one, so the Documents pane marks "this doc". */
  setSelfWinId(winId: number): void;
}

// createSidebar — build the sidebar DOM + return the control surface. The outline re-render is data-driven:
// each `syncOutline` rebuilds the pane from the pure outline derivation, so there is no stale DOM to patch.
export function createSidebar(deps: SidebarDeps): Sidebar {
  // ── State (all SESSION-only; never serialized, never in the doc) ──────────────────────────────────
  let visible = true; // the sidebar starts open
  let tab: SidebarTab = "documents"; // Documents is the default pane
  let selfWinId: number | null = null; // which BrowserWindow is THIS one (set async after boot)
  let lastDocs: OpenDocEntry[] = []; // latest open-docs list, kept so setSelfWinId can re-mark it
  const collapsed = new Set<string>(); // blockIds whose Outline subtree is collapsed (session-only UI state)

  // ── DOM scaffold ─────────────────────────────────────────────────────────────────────────────────
  const root = document.createElement("aside");
  root.className = "fl-sidebar";

  // Tab header — two buttons; the active one carries `.fl-active`.
  const tabs = document.createElement("div");
  tabs.className = "fl-sidebar-tabs";
  const docTab = document.createElement("button");
  docTab.type = "button";
  docTab.className = "fl-sidebar-tab";
  docTab.textContent = "Documents";
  const outlineTab = document.createElement("button");
  outlineTab.type = "button";
  outlineTab.className = "fl-sidebar-tab";
  outlineTab.textContent = "Outline";
  tabs.append(docTab, outlineTab);

  // The two panes — only the active one is shown (toggled via `.fl-active` + CSS display).
  const docsPane = document.createElement("div");
  docsPane.className = "fl-sidebar-pane fl-doc-list";
  const outlinePane = document.createElement("div");
  outlinePane.className = "fl-sidebar-pane fl-outline";

  // ── user-adjustable width ────────────────────────────────────────────────────────────────────────────
  // The width is driven by the `--fl-sidebar-w` custom property (CSS owns the actual width/flex-basis), dragged via
  // a handle on the right edge and persisted to localStorage so it survives a reload. UI preference only — never
  // the doc. Clamp keeps it usable. (The DEFAULT lives in CSS so a fresh window is never too wide.)
  const WIDTH_KEY = "flowline.sidebarWidth";
  const MIN_W = 170;
  const MAX_W = 460;
  const applyWidth = (w: number): void => root.style.setProperty("--fl-sidebar-w", `${Math.max(MIN_W, Math.min(MAX_W, w))}px`);
  // Restore a persisted width if present + sane (ignore a non-numeric / non-positive stored value).
  const storedWidth = typeof localStorage !== "undefined" ? Number(localStorage.getItem(WIDTH_KEY)) : NaN;
  if (Number.isFinite(storedWidth) && storedWidth > 0) applyWidth(storedWidth);

  // The drag handle. Move/up are bound on `document` (not the 6px handle) so a fast drag that outruns the handle
  // still tracks; body user-select is killed during the drag so the gesture never selects editor text. The width
  // is the cursor's distance from the sidebar's live left edge. The final width is persisted on mouseup.
  const resizer = document.createElement("div");
  resizer.className = "fl-sidebar-resizer";
  resizer.setAttribute("aria-hidden", "true"); // pointer affordance only (keyboard users keep the default width)
  resizer.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startLeft = root.getBoundingClientRect().left;
    const onMove = (ev: MouseEvent): void => applyWidth(ev.clientX - startLeft);
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      const finalW = parseInt(root.style.getPropertyValue("--fl-sidebar-w"), 10);
      if (typeof localStorage !== "undefined" && Number.isFinite(finalW)) localStorage.setItem(WIDTH_KEY, String(finalW));
    };
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  root.append(tabs, docsPane, outlinePane, resizer);

  // ── Render helpers ───────────────────────────────────────────────────────────────────────────────
  // Reflect `visible` + `tab` onto the DOM. Visibility uses a class so CSS owns the actual hide rule (and the
  // bottom strip stays in flow); the active tab toggles `.fl-active` on both the tab buttons and the panes.
  const render = (): void => {
    root.classList.toggle("fl-hidden", !visible);
    docTab.classList.toggle("fl-active", tab === "documents");
    outlineTab.classList.toggle("fl-active", tab === "outline");
    docsPane.classList.toggle("fl-active", tab === "documents");
    outlinePane.classList.toggle("fl-active", tab === "outline");
  };

  // Documents pane: one clickable row per open window (a "this doc" caret + a ● dirty marker + the title),
  // focusing that window on click. The current window's row is marked so the user always knows which doc is THIS.
  const renderDocs = (docs: OpenDocEntry[]): void => {
    lastDocs = docs; // remember the list so setSelfWinId can re-mark it once this window's id resolves
    docsPane.replaceChildren(); // full re-render — the list is small and changes wholesale on each broadcast

    // "+ New document" affordance at the top of the desktop Documents pane (mirrors the web pane + File▸New) so New
    // is one click from the open-windows list — the user asked for parity with the web pane. Click runs the host's
    // New (a reused-empty / freshly-spawned window). Inert if the host didn't wire onNewDoc (tests).
    const newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "fl-doc-new";
    newBtn.textContent = "+ New document";
    newBtn.setAttribute("aria-label", "New document"); // so screen readers don't read the literal "+"
    newBtn.addEventListener("click", () => deps.onNewDoc?.());
    docsPane.appendChild(newBtn);

    for (const entry of docs) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "fl-doc-entry";
      if (entry.dirty) row.classList.add("fl-dirty");
      // is this row THIS window? (selfWinId is null until getWinId resolves → nothing marked yet.)
      const isCurrent = selfWinId !== null && entry.winId === selfWinId;
      if (isCurrent) row.classList.add("fl-current");
      // A "you are here" caret on THIS window's row, then a ● dirty marker, then the title. Both indicator spans
      // are ALWAYS present (CSS/▸ control their visibility) so titles stay left-aligned across every row.
      const here = document.createElement("span");
      here.className = "fl-doc-current";
      here.textContent = isCurrent ? "▸" : "";
      const marker = document.createElement("span");
      marker.className = "fl-doc-marker";
      marker.textContent = entry.dirty ? "●" : "";
      const title = document.createElement("span");
      title.className = "fl-doc-title";
      title.textContent = entry.title;
      row.append(here, marker, title);
      // Click → ask the host to focus that window. winId is captured per-row.
      row.addEventListener("click", () => deps.onFocusWindow(entry.winId));
      docsPane.appendChild(row);
    }
  };

  // ── WEB in-window MDI Documents pane ───────────────────────────────────────────────────────────────
  // The web build opens multiple docs in ONE window (no Electron multi-window), so its Documents pane lists the
  // renderer-side registry: a "New document" button on top, then one row per open doc with a ● dirty marker, a
  // ▸ active marker, the title (click to switch), and an × to close that doc (guarded by the host's close-guard).
  // Held so a re-render keeps the same callbacks; `null` until main.ts calls setWebDocs (desktop never does).
  let webHandlers: WebDocHandlers | null = null;
  const renderWebDocs = (docs: DocView[]): void => {
    docsPane.replaceChildren();
    if (!webHandlers) return;
    const handlers = webHandlers;

    // "New document" affordance at the top of the list (mirrors File > New for discoverability on web).
    const newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "fl-doc-new";
    newBtn.textContent = "+ New document";
    newBtn.setAttribute("aria-label", "New document"); // so screen readers don't read the literal "+"
    newBtn.addEventListener("click", () => handlers.onNew());
    docsPane.appendChild(newBtn);

    for (const doc of docs) {
      // The row is a flex container (not itself a button) so it can hold a clickable title AND a separate close ×
      // without nesting interactive elements (a button inside a button is invalid + breaks click semantics).
      const row = document.createElement("div");
      row.className = "fl-doc-entry";
      if (doc.dirty) row.classList.add("fl-dirty");
      if (doc.active) row.classList.add("fl-current");

      const here = document.createElement("span");
      here.className = "fl-doc-current";
      here.textContent = doc.active ? "▸" : "";
      const marker = document.createElement("span");
      marker.className = "fl-doc-marker";
      marker.textContent = doc.dirty ? "●" : "";
      // The title is the switch affordance — a button so keyboard users can activate it; click switches active doc.
      const title = document.createElement("button");
      title.type = "button";
      title.className = "fl-doc-title fl-doc-switch";
      title.textContent = doc.title;
      title.addEventListener("click", () => handlers.onSelect(doc.id));
      // The close ×. stopPropagation is not needed (title is a sibling, not an ancestor), but the host's onClose
      // runs the unsaved-changes guard before actually removing the doc.
      const close = document.createElement("button");
      close.type = "button";
      close.className = "fl-doc-close";
      close.textContent = "×";
      close.title = "Close document";
      close.setAttribute("aria-label", `Close ${doc.title}`);
      close.addEventListener("click", () => handlers.onClose(doc.id));

      row.append(here, marker, title, close);
      docsPane.appendChild(row);
    }
  };

  // Outline pane: one indented row per heading/card/analytic, with Word-nav-pane collapse carets. A label click
  // scrolls that block into view THROUGH the existing dispatch seam (selection + scrollIntoView only — no mutation,
  // no new dispatch path). A caret click hides/shows that heading's deeper children.
  //
  // COLLAPSE MODEL: the flat outline is implicitly a tree by `tier` (pocket 0 < hat 1 < block 2 < card/analytic 3).
  // An entry "owns" the contiguous run of strictly-greater-tier entries that follow it (its subtree). `collapseFloor`
  // is the tier at/below which we're currently collapsed: any entry with tier > floor is hidden; the first entry with
  // tier <= floor ends the collapsed subtree. `collapsed` (blockIds) is session state that survives re-renders, so a
  // doc edit (syncOutline) re-derives the list but keeps what the user folded.
  const renderOutline = (state: EditorState): void => {
    outlinePane.replaceChildren();
    const entries = buildOutline(state.doc);
    const n = entries.length;
    let collapseFloor = Infinity;
    for (let i = 0; i < n; i++) {
      const entry = entries[i];
      if (entry.tier > collapseFloor) continue; // inside a collapsed ancestor's subtree → hidden
      collapseFloor = Infinity; // reached an entry at/above the collapse level → that subtree has ended
      // Has deeper children iff the NEXT entry is at a strictly greater tier (a child). Only such entries get a caret.
      const hasChildren = i + 1 < n && entries[i + 1].tier > entry.tier;
      const isCollapsed = collapsed.has(entry.blockId);

      const row = document.createElement("div");
      row.className = "fl-outline-row";
      row.dataset.tier = String(entry.tier); // drives the CSS indentation so the hierarchy reads at a glance

      // The collapse caret — only for an entry that actually has children (mirrors Word's nav pane). A childless
      // entry gets an inert spacer so every label lines up.
      const caret = document.createElement("button");
      caret.type = "button";
      caret.className = "fl-outline-caret";
      if (hasChildren) {
        caret.textContent = isCollapsed ? "▸" : "▾"; // ▸ collapsed / ▾ expanded
        caret.setAttribute("aria-label", isCollapsed ? "Expand section" : "Collapse section");
        caret.addEventListener("click", (e) => {
          e.stopPropagation(); // a caret click only folds — it must NOT also navigate
          if (collapsed.has(entry.blockId)) collapsed.delete(entry.blockId);
          else collapsed.add(entry.blockId);
          renderOutline(deps.getView().state); // re-derive from the live doc with the new fold state
        });
      } else {
        caret.classList.add("fl-leaf"); // hidden, non-interactive spacer
        caret.tabIndex = -1;
        caret.setAttribute("aria-hidden", "true");
      }

      const label = document.createElement("button");
      label.type = "button";
      label.className = "fl-outline-entry";
      label.dataset.tier = String(entry.tier);
      // An empty heading would render a zero-height row; show a placeholder so it is still clickable/visible.
      label.textContent = entry.label.length > 0 ? entry.label : "(untitled)";
      // Capture the blockId; resolve its CURRENT position at click time (the doc may have changed since render).
      label.addEventListener("click", () => {
        const view = deps.getView();
        const pos = resolveBlockPos(view.state.doc, entry.blockId);
        if (pos === null) return; // the block was deleted/merged away → no-op (never mutate)
        // Same dispatch tail as the DEV __flowlineCaret affordance: a selection near the block + scrollIntoView,
        // pushed through view.dispatch (→ the single seam). No content change; addToHistory is irrelevant (a
        // pure selection tr is not added to history by PM).
        const tr = view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))).scrollIntoView();
        view.dispatch(tr);
        view.focus();
      });

      row.append(caret, label);
      outlinePane.appendChild(row);

      // If THIS entry is collapsed, hide its subtree: every following entry with tier > this tier is skipped until
      // an entry with tier <= this tier ends the run.
      if (hasChildren && isCollapsed) collapseFloor = entry.tier;
    }
  };

  // ── Public control surface ───────────────────────────────────────────────────────────────────────
  const setTab = (next: SidebarTab): void => {
    tab = next;
    render();
  };
  const setVisible = (next: boolean): void => {
    visible = next;
    render();
  };
  const toggle = (): void => setVisible(!visible);

  // syncOutline always re-derives from the passed state, so the pane is never stale and the component caches no
  // doc state (no risk of parking doc state in the component).
  const syncOutline = (state: EditorState): void => renderOutline(state);
  const setOpenDocs = (docs: OpenDocEntry[]): void => renderDocs(docs);
  // Web MDI: remember the handlers (first call) and (re-)render the registry list. The host calls this on every
  // registry mutation (new/open/close/switch/dirty/rename) so the pane always mirrors the live registry.
  const setWebDocs = (docs: DocView[], handlers: WebDocHandlers): void => {
    webHandlers = handlers;
    renderWebDocs(docs);
  };
  // record this window's id and re-mark the Documents pane (the open-docs list may already be rendered).
  const setSelfWinId = (winId: number): void => {
    selfWinId = winId;
    renderDocs(lastDocs);
  };

  // ── Wire the tab buttons ─────────────────────────────────────────────────────────────────────────
  docTab.addEventListener("click", () => setTab("documents"));
  outlineTab.addEventListener("click", () => setTab("outline"));

  render(); // initial paint (Documents tab, visible, empty panes)

  return { dom: root, setOpenDocs, setWebDocs, syncOutline, setVisible, setTab, toggle, setSelfWinId };
}
