// renderer/main.ts — the renderer entry (browser dev preview AND the Electron renderer).
//
// Mounts the one Flowline EditorView with the mark toolbar, the keymaps, and the File machinery. The
// dispatch passed to `createFlowlineView` is the documented extension point (editor.ts): it calls the
// single real `applyTransaction` (the only `view.updateState`) and then syncs the toolbar's active state —
// there is still ONE place state is applied.
//
// This is the single-user multi-window desktop editor: prosemirror-history undo, File/Edit/View/Window menus,
// the tabbed sidebar + live outline, the initial-doc PULL, .fl persistence, .docx export. `buildEditorRuntime`
// (runtime.ts) resolves the doc + plugins; this file mounts whatever it returns. The File/persistence + windowing
// machinery is gated on the `window.flowline` preload bridge (absent in the bare browser preview ⇒ inert there).
//
// Multi-window: the desktop shell adds a tabbed sidebar (Documents | Outline) + a live outline derivation, a
// per-window doc-state report to MAIN, the multi-window menu commands, a guarded per-window close, a synchronous
// quit-guard, and an initial-doc PULL from MAIN to decide this window's start doc.

import { TextSelection, Selection } from "prosemirror-state";
import { undo, redo } from "prosemirror-history";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { applyTransaction, createFlowlineView, LOAD_META } from "../editor";
import { createSeedDoc } from "../seed";
import { createToolbar } from "../toolbar";
import { createSidebar } from "./sidebar";
import { isReusable } from "./outline";
import { schema } from "../schema";
import { structureHost } from "../structure-host";
import { docFromJson } from "../persistence/document";
import { SCHEMA_VERSION } from "../version";
import { buildEditorRuntime } from "./runtime";
import "../styles.css";

const mount = document.getElementById("app");
const topbar = document.querySelector(".fl-topbar");
const mainRow = document.querySelector(".fl-main-row");
const sidebarToggleBtn = document.getElementById("fl-sidebar-toggle");

if (mount) {
  // The toolbar's click handlers need the live view, and the view's dispatch needs the toolbar (to sync
  // active state) — a construction cycle. Break it with a ref the getter reads at click time (always after
  // construction), so the view itself stays a `const`.
  const viewRef: { current: EditorView | null } = { current: null };
  const getView = (): EditorView => {
    if (!viewRef.current) throw new Error("Flowline view not initialised");
    return viewRef.current;
  };
  const toolbar = createToolbar(getView);

  // The single tabbed sidebar (Documents | Outline). It reads the doc READ-ONLY (buildOutline) and
  // scrolls a clicked heading into view THROUGH the existing dispatch seam (no mutation, no new dispatch path).
  // A Documents click focuses that window via the bridge (absent in the bare browser preview → guarded `?.`).
  const sidebar = createSidebar({
    getView,
    onFocusWindow: (winId) => {
      void window.flowline?.focusWindow(winId);
    },
  });

  // Learn THIS window's id so the Documents pane can mark "this doc". Async; the sidebar re-marks the
  // (possibly already-rendered) list when it resolves. Guarded — absent in the bare browser preview (no bridge).
  void window.flowline?.getWinId().then((id) => sidebar.setSelfWinId(id));

  // ── File state (PERIPHERAL — lives here in session scope, NEVER in the doc) ──────────
  let currentPath: string | null = null;
  let dirty = false;

  const fileLabel = (): string => (currentPath ? (currentPath.split(/[\\/]/).pop() ?? "Untitled") : "Untitled");

  // Report this window's (title,dirty,path) to MAIN so its Documents-tab entry stays live, deduped so an
  // identical tuple never re-fires (the dispatch seam calls updateTitle on every dirtying edit). The reported
  // `title` is the bare filename (no ● / freshness suffix) — MAIN renders the dirty marker itself in the list.
  // Session/main-process state only — never part of doc.toJSON().
  let lastReported = "";
  const reportDocState = (): void => {
    const title = fileLabel();
    const key = `${title} ${dirty ? "1" : "0"} ${currentPath ?? ""}`;
    if (key === lastReported) return; // dedupe: only report a real change
    lastReported = key;
    window.flowline?.reportDocState({ title, dirty, path: currentPath });
  };

  // The window title shows the filename + a ● dirty marker and the schema version. Set whenever dirty/path
  // changes; also (de-duped) reports the doc-state to MAIN for the live Documents list.
  const updateTitle = (): void => {
    document.title = `${dirty ? "● " : ""}${fileLabel()} — Flowline · schema v${SCHEMA_VERSION}`;
    reportDocState();
  };

  // A fresh "New" document: one empty paragraph (a 0-block doc is a valid but degenerate transient).
  const newDoc = (): PMNode =>
    schema.nodes.doc.create(null, [schema.nodes.paragraph.create({ blockId: structureHost.structure.newUnitId() })]);

  // Replace the whole document THROUGH the single dispatch seam (never view.updateState). The load tr is
  // tagged LOAD_META so the absorb normalizer ignores it (preserving save→reopen identity) and the dirty-flag
  // skips it; addToHistory:false so Ctrl+Z can't revert to the previous file; the caret goes to the doc start.
  // An empty payload (0 blocks) is seeded with one paragraph so the editor stays usable.
  const loadDoc = (doc: PMNode): void => {
    const content = doc.childCount > 0 ? doc.content : newDoc().content;
    const view = getView();
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, content);
    tr.setMeta(LOAD_META, true);
    tr.setMeta("addToHistory", false);
    tr.setSelection(Selection.atStart(tr.doc));
    view.dispatch(tr);
  };

  // New (renderer-decides reuse): Ctrl+N opens a blank doc in a NEW window UNLESS THIS window
  // is an untouched empty "Untitled" (isReusable), in which case we reuse it in place (no new window — the empty
  // window the user is already looking at becomes the new doc). When NOT reusable, ask MAIN to spawn a fresh
  // window and leave THIS window's doc untouched. No unsaved-guard here: a reuse only happens when the doc is clean
  // + empty (nothing to lose), and a spawn never touches the current doc.
  const doNew = async (): Promise<void> => {
    if (isReusable(getView().state.doc, dirty, currentPath)) {
      loadDoc(newDoc());
      currentPath = null;
      dirty = false;
      updateTitle();
      getView().focus();
      return;
    }
    await window.flowline?.requestNewWindow();
  };

  // Open (renderer-decides reuse): main shows the dialog + frame-decodes; we validate the
  // payload as a doc. If THIS window is reusable (untouched empty Untitled) we load the file in place; otherwise we
  // ask MAIN to spawn a new window pre-loaded with the decoded doc + path, leaving THIS window untouched. On a
  // cancel/frame-error/bad-doc nothing changes. All native dialogs go through main.
  const doOpen = async (): Promise<void> => {
    const bridge = window.flowline;
    if (!bridge) return;
    const res = await bridge.open();
    if (!res.ok) {
      if (res.message) await bridge.showError(res.message); // a frame error; a plain cancel is silent
      return;
    }
    if (isReusable(getView().state.doc, dirty, currentPath)) {
      // Reuse in place: validate + load the decoded doc through the seam (a bad doc leaves the current one intact).
      let doc: PMNode;
      try {
        doc = docFromJson(res.docJson); // root-type assert + nodeFromJSON + check(); throws on a bad doc
      } catch (err) {
        await bridge.showError(err instanceof Error ? err.message : "Could not open the file.");
        return;
      }
      loadDoc(doc);
      currentPath = res.path;
      dirty = false;
      updateTitle();
      getView().focus();
      return;
    }
    // Not reusable → hand the decoded payload to a freshly spawned window (MAIN stashes it for that window's PULL).
    await bridge.requestNewWindow({ docJson: res.docJson, path: res.path });
  };

  // Never PERSIST a check()-invalid doc — Open runs check() and would refuse it, so writing one means an
  // unreopenable file. A null-blockId block can still arise from a structural replace over a node-selection (a
  // pre-existing editor-core edge the paste guard now avoids on the paste path); refuse to save/export rather
  // than write a file that can't be reopened. Returns the doc JSON, or null after showing the error.
  const validDocJson = async (): Promise<unknown | null> => {
    try {
      getView().state.doc.check();
    } catch {
      await window.flowline?.showError("This document has an invalid block and cannot be saved. Undo your last change and try again.");
      return null;
    }
    return getView().state.doc.toJSON();
  };

  // Save (Ctrl+S → save to the current path, prompting only if none) / Save As (always prompt).
  const doSave = async (forceDialog: boolean): Promise<void> => {
    const bridge = window.flowline;
    if (!bridge) return;
    const json = await validDocJson();
    if (json === null) return;
    const res = forceDialog ? await bridge.saveAs(json) : await bridge.save(json, currentPath ?? undefined);
    if (!res.ok) {
      if (res.message) await bridge.showError(res.message);
      return;
    }
    currentPath = res.path;
    dirty = false;
    updateTitle();
  };

  // Unsaved-work guard, shared by New, Open, and the window-close attempt. Returns true if it is safe to
  // PROCEED (discard the current doc / close), false to ABORT. When the doc is clean (or there is no bridge —
  // the bare browser dev preview) there is nothing to guard, so proceed. Otherwise show the native dialog:
  //   - cancel  → abort (return false)
  //   - save    → run doSave; proceed ONLY if the save actually cleared `dirty` (a cancelled Save-As / write
  //               error leaves `dirty` set, so we abort rather than silently lose the work)
  //   - discard → proceed (return true), dropping the unsaved edits
  const guardUnsaved = async (): Promise<boolean> => {
    const bridge = window.flowline;
    if (!dirty || !bridge) return true;
    const choice = await bridge.confirmUnsaved();
    if (choice === "cancel") return false;
    if (choice === "save") {
      await doSave(false); // may itself prompt (no current path); dirty clears iff the save succeeded
      return !dirty;
    }
    return true; // discard
  };

  // Export to Word: prompt + write a .docx; does not affect the current .fl path or the dirty flag.
  const doExport = async (): Promise<void> => {
    const bridge = window.flowline;
    if (!bridge) return;
    const json = await validDocJson();
    if (json === null) return;
    const res = await bridge.exportDocx(json);
    if (!res.ok && res.message) await bridge.showError(res.message);
  };

  // The MAIN-orchestrated SEQUENTIAL quit guard. MAIN shows+focuses this window and sends "flowline:quitGuard"
  // one window at a time during a Quit; we run the SAME unsaved-work guard as a close and reply "clear" (safe to quit
  // this window — saved/discarded/clean) or "cancel" (abort the whole quit). If the guard itself throws we reply
  // "clear" so a guard failure never wedges the quit. Distinct channel from the single-window close-request.
  // Registered HERE — SYNCHRONOUSLY, before the boot IIFE's `await getInitialDoc` below — on purpose: if it lived
  // inside the IIFE (after the await), a Quit fired during this window's boot round-trip would hit a not-yet-
  // subscribed renderer, the quitGuard would be dropped (ipcRenderer.on has no buffering), and MAIN's reply-await
  // would hang the whole app. guardUnsaved is safe pre-view: `dirty` is false until the first edit (which needs the
  // built view), so it returns "clear" immediately without touching getView().
  window.flowline?.onQuitGuard(() => {
    void (async () => {
      try {
        window.flowline?.replyQuitGuard((await guardUnsaved()) ? "clear" : "cancel");
      } catch {
        window.flowline?.replyQuitGuard("clear"); // never wedge the quit on a guard failure
      }
    })();
  });

  // Resolve the editor configuration and mount it through the view factory + dispatch seam.
  const rt = buildEditorRuntime();

  // ── BOOT (initial doc) ─────────────────────────────────────────────────────────────────────────────────
  // The whole view construction + post-view wiring runs inside an async IIFE so we can `await` the initial-doc
  // PULL from MAIN before constructing the editor. PULL this window's initial doc from MAIN: `seed` → the
  // DEV-gated stand-in intro doc (createSeedDoc, itself import.meta.env.DEV-guarded so seed.ts tree-shakes from a
  // prod bundle); `empty` → a blank newDoc; `file` → decode docJson via the existing document-validation path and
  // remember its path. A bare browser preview (no window.flowline) falls back to the seed.
  void (async () => {
    let initialDoc: PMNode;
    const init = window.flowline ? await window.flowline.getInitialDoc() : ({ kind: "seed" } as const);
    if (init.kind === "file") {
      try {
        initialDoc = docFromJson(init.docJson); // validated decode (root assert + check); throws on a bad doc
        currentPath = init.path;
      } catch {
        // A corrupt hand-off should never strand the window blank-but-broken: fall back to an empty New doc and
        // surface the error through the same native dialog the file ops use.
        initialDoc = newDoc();
        void window.flowline?.showError("Could not open the file (it may be unreadable).");
      }
    } else if (init.kind === "empty") {
      initialDoc = newDoc();
    } else {
      // seed: DEV-only content. import.meta.env.DEV is statically false in prod so createSeedDoc tree-shakes out
      // and a prod first-window falls back to a blank doc (MAIN only ever sends "seed" in DEV anyway).
      initialDoc = import.meta.env.DEV ? createSeedDoc() : newDoc();
    }

    const view = createFlowlineView(mount, initialDoc, rt.plugins, (v, tr) => {
      applyTransaction(v, tr); // the single dispatch seam
      toolbar.syncActive(v.state);
      // Keep the Outline pane in sync with the live doc. Read-only derivation (buildOutline) — never
      // mutates the doc, never opens a second dispatch path.
      sidebar.syncOutline(v.state);
      // Dirty-tracking: a user edit dirties the doc; the file-LOAD tr (open/new) carries LOAD_META and is exempt.
      // dirty/path are session state, never in the doc.
      if (tr.docChanged && tr.getMeta(LOAD_META) !== true && !dirty) {
        dirty = true;
        updateTitle();
      }
    });
    viewRef.current = view;

    if (topbar) topbar.appendChild(toolbar.dom);
    toolbar.syncActive(view.state);

    // Mount the sidebar as the LEFT column of the main row (before the content column with the surface),
    // and do an initial outline paint. The bottom-strip toggle button flips the sidebar's visibility (mirrored by
    // the View menu). Both are absent in environments without the restructured shell — guarded.
    if (mainRow) mainRow.insertBefore(sidebar.dom, mainRow.firstChild);
    sidebar.syncOutline(view.state);
    sidebarToggleBtn?.addEventListener("click", () => sidebar.toggle());

    // Set the initial window title (filename + ● dirty marker + schema version).
    updateTitle();
    view.focus();

    // ── File/menu wiring (Electron only — guarded on the preload bridge) ────────────────────────────────
    // Main relays accelerator/menu clicks ("flowline:menu") via the preload bridge; we gather/replace the doc
    // here. Absent in the bare browser dev preview (no preload) — guarded with `?.`. Run an async menu action,
    // surfacing a rejection through the same native error dialog the file ops use, rather than letting a rejected
    // promise fail silently.
    const run = (p: Promise<void>): void => {
      void p.catch(() => window.flowline?.showError("That action could not be completed."));
    };
    // The guarded window-close flow, shared by the Window>Close menu command and MAIN's close-request. Run the
    // unsaved-work guard; only if it clears (or the guard itself throws) tell MAIN it is safe to close THIS window.
    const requestGuardedClose = async (): Promise<void> => {
      try {
        if (await guardUnsaved()) await window.flowline?.requestClose();
      } catch {
        await window.flowline?.requestClose(); // never trap the user if the guard itself fails
      }
    };

    window.flowline?.onMenuCommand((cmd) => {
      switch (cmd) {
        case "new":
          run(doNew()); // async (guards unsaved work first / spawns a window)
          break;
        case "open":
          run(doOpen());
          break;
        case "save":
          run(doSave(false));
          break;
        case "saveAs":
          run(doSave(true));
          break;
        case "export":
          run(doExport());
          break;
        // Edit menu: route undo/redo to PM's existing history commands through the single dispatch seam. These
        // are the SAME commands bound to Mod-Z / Shift-Mod-Z in the runtime — the menu items carry
        // registerAccelerator:false so PM's keymap stays the sole keyboard owner; the menu is a click affordance for
        // the identical action. Cut/copy/paste arrive as NATIVE roles on the focused webContents (not these
        // commands), so they're not handled here — PM's clipboard/pasteGuard handling stays intact.
        case "edit:undo": {
          const view = getView();
          undo(view.state, view.dispatch);
          view.focus();
          break;
        }
        case "edit:redo": {
          const view = getView();
          redo(view.state, view.dispatch);
          view.focus();
          break;
        }
        // View menu: toggle the sidebar, or switch its tab (also forcing it visible so the chosen tab shows).
        case "view:toggleSidebar":
          sidebar.toggle();
          break;
        case "view:tabDocuments":
          sidebar.setTab("documents");
          sidebar.setVisible(true);
          break;
        case "view:tabOutline":
          sidebar.setTab("outline");
          sidebar.setVisible(true);
          break;
        // Window>Close: run the SAME guarded close flow MAIN's close-request uses (per-window unsaved guard).
        case "window:close":
          run(requestGuardedClose());
          break;
        default:
          break;
      }
    });

    // Handle a window-close attempt. Main intercepts the close and emits "flowline:close-request"; we run the
    // shared guarded close flow and, only if it clears, tell main it is safe to close (which re-issues the close).
    // A "cancel" / a still-dirty failed save aborts — the window stays open. Absent in the bare browser preview.
    window.flowline?.onCloseRequest(() => {
      void requestGuardedClose();
    });

    // Keep the Documents tab live. MAIN broadcasts the full open-windows list on every registry mutation
    // (a window opens / closes / renames / changes dirty); the sidebar re-renders it. Absent in the bare preview.
    window.flowline?.onOpenDocs((docs) => sidebar.setOpenDocs(docs));

    // (The SEQUENTIAL quit guard — window.flowline.onQuitGuard — is registered earlier, synchronously, BEFORE this
    // boot IIFE's await, so a Quit during boot is never dropped. See the comment by that registration above.)

    // Report the initial doc-state once the window is wired, so a freshly spawned window appears with its real title
    // (e.g. an Open-spawned window's filename) in every Documents tab even before the first edit. updateTitle above
    // already fired one report; this is the same de-duped call, harmless if the tuple is unchanged.
    reportDocState();

    // ── DEV-only e2e control surface ─────────────────────────────────────────────────────────────────────
    // `import.meta.env.DEV` is statically false in the production build, so this whole block is tree-shaken out
    // of the shipped bundle.
    if (import.meta.env.DEV) {
      // The __flowlineCaret hook drives the caret THROUGH ProseMirror's dispatch (not native DOM selection) so
      // headless tests (e2e/blocks.spec.ts) get a deterministic caret with no PM adoption race.
      (window as unknown as { __flowlineCaret?: (selector: string, where: "end" | number) => void }).__flowlineCaret = (
        selector,
        where,
      ) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`__flowlineCaret: no block for selector ${selector}`);
        const pos =
          where === "end"
            ? view.posAtDOM(el, el.childNodes.length) // end of this block's content
            : view.posAtDOM(el, 0) + where; // `where` chars into the block's content
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))).scrollIntoView());
        view.focus();
      };
    }
  })(); // end the async boot IIFE (awaited getInitialDoc before constructing the view)
}
