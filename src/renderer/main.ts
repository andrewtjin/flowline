// renderer/main.ts — the renderer entry (browser dev preview, the Electron renderer, AND the web build).
//
// Mounts the one Flowline EditorView with the mark toolbar, the keymaps, and the File machinery. The
// dispatch passed to `createFlowlineView` is the documented extension point (editor.ts): it calls the
// single real `applyTransaction` (the only `view.updateState`) and then syncs the toolbar's active state —
// there is still ONE place state is applied.
//
// This is the single-user editor: prosemirror-history undo, File/Edit/View/Window menus, the tabbed sidebar +
// live outline, the initial-doc PULL, .fl persistence, .docx export, Settings + dark mode. `buildEditorRuntime`
// (runtime.ts) resolves the doc + plugins; this file mounts whatever it returns.
//
// Two host shapes, gated on the `window.flowline` preload bridge:
//   - DESKTOP (Electron, bridge present): File/persistence + multi-window machinery routes through MAIN — a
//     tabbed sidebar (Documents | Outline), a per-window doc-state report, the menu commands, a guarded close,
//     a synchronous quit-guard, and an initial-doc PULL from MAIN to decide this window's start doc.
//   - WEB (no bridge, E10b): the renderer owns the File machinery itself — an in-window MDI registry, web file
//     dialogs (File System Access API + Blob-download fallback), an in-renderer menu bar + Ctrl+S/Ctrl+M
//     accelerators, and a web close-guard. The bare browser preview (also no bridge) shares the web path.

import { TextSelection, Selection, EditorState } from "prosemirror-state";
import { undo, redo } from "prosemirror-history";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { applyTransaction, createFlowlineView, LOAD_META } from "../editor";
import { createSeedDoc } from "../seed";
import { createToolbar } from "../toolbar";
import { createSidebar } from "./sidebar";
import { createMenuBar } from "./menubar";
import { createDocRegistry } from "./doc-registry";
import { webSaveFl, webOpenFl } from "./web-files";
import { webExportDocx } from "../persistence/web-docx";
import { needsClosePrompt, resolveClose } from "./close-guard";
import { isSaveChord, isSaveAsChord, isNewChord } from "./web-keys";
import type { UnsavedChoice, MenuCommand } from "../persistence/bridge";
import { isReusable } from "./outline";
import { schema } from "../schema";
import { structureHost } from "../structure-host";
import { docFromJson } from "../persistence/document";
import { SCHEMA_VERSION } from "../version";
import { buildEditorRuntime } from "./runtime";
import { openOverlay, openSettings, registerBuiltinSettings, settingsRegistries } from "./settings";
import { loadPersistedTheme } from "./settings-registry";
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

  // ── Settings + theme (PERIPHERAL — per-user chrome, NEVER in the doc) ────────────────────────────────
  // Register the built-in Appearance section + light/dark themes once, then re-apply the persisted theme. The
  // no-flash boot script in index.html already set documentElement.dataset.theme synchronously to avoid a white
  // flash; loadPersistedTheme re-runs the SAME resolution through the theme registry (so a programmatic theme's
  // `vars` re-apply) and keeps the persisted key + dataset in lockstep. Theme state lives ONLY on the dataset +
  // localStorage — it never enters doc.toJSON() (S-003).
  registerBuiltinSettings();
  loadPersistedTheme(settingsRegistries().themes);

  // ── File state (PERIPHERAL — lives here in session scope, NEVER in the doc) ──────────
  let currentPath: string | null = null;
  let dirty = false;

  // ── WEB single-user mode (E10b) ──────────────────────────────────────────────────────────────────────
  // The desktop app routes File/Window actions through the `window.flowline` preload bridge; the bare web build
  // has NO bridge, so those were inert (E10's web menu only ran View). E10b makes them work on web, gated on
  // `!window.flowline`: web file I/O + the in-window MDI registry activate ONLY when there is no bridge. Desktop
  // (bridge present) is byte-for-byte unchanged.
  const isWeb = !window.flowline;
  // The in-window MDI registry (web only): the open docs, their parked EditorStates, paths, and dirty flags. It is
  // renderer-only session state and NEVER enters any doc.toJSON() (the F2/S-003 invariant — see doc-registry.ts).
  const registry = createDocRegistry();
  // Per-doc File System Access handle (web only), keyed by registry id, so a plain Save overwrites the same file
  // with no re-prompt. Kept OUT of the registry (which is typed for doc/path/dirty) — session state, never in a doc.
  const handles = new Map<string, FileSystemFileHandle | null>();

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

  // ── WEB helpers (only invoked when isWeb; defined here so the File handlers below can delegate) ──────────
  // `webPrompt` is assigned in the boot IIFE once createModal exists; until then it is a no-op resolving to
  // "cancel" (it is never CALLED before boot — dirty is false until the first edit, which needs the built view).
  // It shows the SAME Save/Discard/Cancel choice as the desktop native dialog, so web S5/S6 mirror desktop.
  let webPrompt: () => Promise<UnsavedChoice> = () => Promise.resolve("cancel");

  // Sync the live editor + active doc-state INTO the active registry entry, so switching away parks the latest
  // edits/path/dirty and switching back restores them exactly. Called before any active-doc switch/close.
  const parkActive = (): void => {
    registry.syncActiveState(getView().state);
    registry.setActivePath(currentPath);
    registry.setActiveDirty(dirty);
  };

  // Make the registry's active entry the live editor: load its parked doc through the seam and adopt its
  // path/dirty as the module-scope active state. Re-renders the Documents pane so the active marker tracks.
  const activateEntry = (): void => {
    const entry = registry.active();
    if (!entry) return;
    // Replace the whole doc through the single seam (LOAD_META so it is not counted as a user edit / dirtying).
    const view = getView();
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, entry.state.doc.content);
    tr.setMeta(LOAD_META, true);
    tr.setMeta("addToHistory", false);
    tr.setSelection(Selection.atStart(tr.doc));
    view.dispatch(tr);
    currentPath = entry.path;
    dirty = entry.dirty;
    updateTitle();
    renderWebDocs();
    view.focus();
  };

  // Re-render the web Documents pane from the live registry. Defined as a thin indirection so the registry
  // mutations below stay terse; the actual sidebar wiring happens in the boot IIFE (setWebDocs).
  let renderWebDocs: () => void = () => {};

  // Guarded close of one in-window doc by registry id (S5: the x, and S6: Window>Close share this ONE path). To
  // guard the RIGHT doc's unsaved work, first make it active (so `dirty`/the live view reflect it), run the shared
  // unsaved-work guard, and only on "proceed" remove it from the registry + activate the neighbour the registry
  // returns (or load a fresh empty doc when the last one closes — the window never goes doc-less). On "abort" the
  // doc stays open. The guard itself is guardUnsaved (web branch), which uses the PURE close-guard decision.
  const closeWebDoc = async (id: string): Promise<void> => {
    // Switch to the target so the guard + live editor address THAT doc. If it is already active this is a no-op.
    if (registry.activeId() !== id) {
      parkActive();
      if (registry.select(id)) activateEntry();
    }
    if (!(await guardUnsaved())) return; // user cancelled / a failed save → keep the doc open
    handles.delete(id);
    const nextId = registry.close(id);
    if (nextId === null) {
      // Closed the last doc — keep the window usable with a fresh empty doc (mirrors desktop never going blank).
      registry.add(EditorState.create({ schema, doc: newDoc() }), null);
      handles.set(registry.activeId()!, null);
    }
    activateEntry();
  };

  // New (renderer-decides reuse): Ctrl+N opens a blank doc in a NEW window UNLESS THIS window
  // is an untouched empty "Untitled" (isReusable), in which case we reuse it in place (no new window — the empty
  // window the user is already looking at becomes the new doc). When NOT reusable, ask MAIN to spawn a fresh
  // window and leave THIS window's doc untouched. No unsaved-guard here: a reuse only happens when the doc is clean
  // + empty (nothing to lose), and a spawn never touches the current doc.
  //
  // WEB: there are no separate windows, so New always adds a fresh in-window doc to the MDI registry (parking the
  // current one first) and makes it active — the prior doc stays in the Documents list (S4). No guard: the prior
  // doc is retained, not discarded.
  const doNew = async (): Promise<void> => {
    if (isWeb) {
      parkActive();
      // A fresh doc parked as a lightweight state snapshot (activateEntry reads only .state.doc, so the snapshot
      // needs no plugins — the LIVE plugin-wired view is the one editing it once activated).
      registry.add(EditorState.create({ schema, doc: newDoc() }), null);
      handles.set(registry.activeId()!, null); // a brand-new doc has no save handle yet
      activateEntry();
      return;
    }
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
    if (isWeb) {
      // Web: read + decode + validate via the browser file picker (or fallback). A cancel is silent; a corrupt /
      // newer / invalid file shows its typed error and changes nothing. A valid file becomes a NEW in-window doc in
      // the registry (parking the current one first), so Open never clobbers the doc the user is looking at (S3/S4).
      const res = await webOpenFl();
      if (!res.ok) {
        if (res.message) await webShowError(res.message);
        return;
      }
      parkActive();
      registry.add(EditorState.create({ schema, doc: res.doc }), res.name);
      handles.set(registry.activeId()!, res.handle); // remember the FSA handle for save-in-place
      activateEntry();
      return;
    }
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

  // Show an error to the user. Desktop routes to MAIN's native dialog; web (no bridge) shows an in-renderer
  // dismissible banner (defined in the boot IIFE once the DOM is up). Single seam so the file handlers below don't
  // each branch on platform. `webShowError` is a no-op until boot wires it (never called pre-boot in practice).
  let webShowError: (message: string) => void = () => {};
  // A neutral (non-error) web toast seam for transient confirmations — e.g. "Saved t.fl" after a successful web
  // save, so the user gets VISIBLE feedback that Ctrl+S worked (rather than a silent success that reads as "nothing
  // happened"). Wired in the boot isWeb block alongside webShowError; a no-op until then (never called pre-boot).
  let webNotify: (message: string) => void = () => {};
  const showError = async (message: string): Promise<void> => {
    if (isWeb) webShowError(message);
    else await window.flowline?.showError(message);
  };

  // Never PERSIST a check()-invalid doc — Open runs check() and would refuse it, so writing one means an
  // unreopenable file. A null-blockId block can still arise from a structural replace over a node-selection (a
  // pre-existing editor-core edge the paste guard now avoids on the paste path); refuse to save/export rather
  // than write a file that can't be reopened. Returns the doc JSON, or null after showing the error.
  const validDocJson = async (): Promise<unknown | null> => {
    try {
      getView().state.doc.check();
    } catch {
      await showError("This document has an invalid block and cannot be saved. Undo your last change and try again.");
      return null;
    }
    return getView().state.doc.toJSON();
  };

  // Save (Ctrl+S → save to the current path, prompting only if none) / Save As (always prompt).
  //
  // WEB: write a real `.fl` via the File System Access API (a reusable handle ⇒ plain Save overwrites in place) or
  // a Blob download fallback. The active registry entry's handle/path/dirty are updated on success (S2). A
  // cancelled picker leaves dirty set (so the close-guard correctly aborts). Byte format == desktop (envelope-frame).
  const doSave = async (forceDialog: boolean): Promise<void> => {
    if (isWeb) {
      const json = await validDocJson();
      if (json === null) return;
      const id = registry.activeId();
      const res = await webSaveFl(getView().state.doc, {
        handle: id ? handles.get(id) ?? null : null,
        forceDialog,
        suggestedName: currentPath ?? fileLabel(),
      });
      if (!res.ok) {
        if (res.message) await showError(res.message); // a cancel is silent (leaves dirty set → close aborts)
        return;
      }
      if (id) handles.set(id, res.handle);
      currentPath = res.name;
      dirty = false;
      registry.setActivePath(currentPath);
      registry.setActiveDirty(false);
      updateTitle();
      renderWebDocs();
      // Honesty: when the user DENIED the write permission on a handled save, webSaveFl wrote a NEW copy to
      // Downloads (not the original). The bytes ARE safely persisted (so dirty/path above are correct), but tell
      // the user WHERE — otherwise they'd believe they overwrote their original file. Uses the toast seam.
      if (res.downloadedFallback) await showError("Permission denied — saved a copy to Downloads instead.");
      else webNotify(`Saved ${currentPath}`); // visible confirmation that the (Ctrl+S) save succeeded
      return;
    }
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
  // PROCEED (discard the current doc / close), false to ABORT. When the doc is clean there is nothing to guard, so
  // proceed. Otherwise prompt (desktop: native dialog; web: in-renderer Save/Discard/Cancel modal — webPrompt):
  //   - cancel  → abort (return false)
  //   - save    → run doSave; proceed ONLY if the save actually cleared `dirty` (a cancelled Save-As / write
  //               error leaves `dirty` set, so we abort rather than silently lose the work)
  //   - discard → proceed (return true), dropping the unsaved edits
  // The decision (clean ⇒ no prompt; the 3-way resolution) is the PURE close-guard (close-guard.ts), shared by web
  // and tested independently — this just runs the platform prompt + the (web) doSave, then asks it to decide.
  const guardUnsaved = async (): Promise<boolean> => {
    if (isWeb) {
      if (!needsClosePrompt(dirty)) return true; // clean → no prompt (S5)
      const choice = await webPrompt();
      if (choice === "save") await doSave(false); // may itself prompt for a path; dirty clears iff it succeeded
      return resolveClose(choice, !dirty) === "close";
    }
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
  //
  // WEB: docx CAN bundle for the browser (Packer.toBlob), so Export is OFFERED on web too — it downloads a .docx
  // built from the SAME IR/Document as desktop (S7). See persistence/web-docx.ts for the bundling decision.
  const doExport = async (): Promise<void> => {
    if (isWeb) {
      const json = await validDocJson();
      if (json === null) return;
      const res = await webExportDocx(json, currentPath ?? fileLabel());
      if (!res.ok) await showError(res.message);
      return;
    }
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

  // createModal — a lightweight in-renderer modal scaffold (the web unsaved-changes prompt). Browsers have no
  // built-in app-styled confirm, so we render our own: a dim full-screen backdrop + a centered dialog with a title,
  // optional text fields, and a primary/Cancel action row. Keys are trapped ON the overlay (Enter=submit,
  // Escape=cancel, Tab/Shift-Tab cycle the dialog's own controls) and stopped from propagating so the editor's
  // ProseMirror keymaps never see them; a backdrop click dismisses. Only ONE modal opens at a time. The caller
  // supplies the field specs + an onSubmit that receives the trimmed values; submit is a no-op while any REQUIRED
  // field is empty (keeps the modal open to correct). All classes are fl-prefixed (CSS gate).
  type ModalField = { key: string; placeholder: string; required?: boolean; value?: string };
  // An extra middle button (e.g. the close-guard's "Discard") between the primary Submit and Cancel. Each runs its
  // onClick then closes the modal. onCancel fires on ANY dismissal that is NOT a submit/extra-action (Cancel
  // button, Escape, backdrop click) — used by the web close-guard so a dismiss resolves to the safe "cancel".
  type ModalAction = { label: string; onClick: () => void };
  type ModalSpec = {
    title: string;
    fields: ModalField[];
    submitLabel: string;
    onSubmit: (values: Record<string, string>) => void;
    extraActions?: ModalAction[];
    onCancel?: () => void;
  };
  // createModal routes through the SHARED overlay primitive (settings.ts `openOverlay`) so the modal and the
  // Settings overlay share ONE module-level latch and can never stack (E7-S3). openOverlay owns the backdrop, the
  // single-instance latch, the Escape/backdrop-click dismiss, and the Tab focus-trap; createModal supplies only the
  // dialog BODY (title + inputs + actions) and its Enter=submit handler.
  const createModal = (spec: ModalSpec): void => {
    openOverlay((dialog, close) => {
      dialog.classList.add("fl-modal__dialog");

      const title = document.createElement("h2");
      title.className = "fl-modal__title";
      title.textContent = spec.title;
      dialog.appendChild(title);

      // One text input per field, remembered by key so submit can read the trimmed values.
      const inputs: Record<string, HTMLInputElement> = {};
      for (const f of spec.fields) {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "fl-modal__input";
        input.placeholder = f.placeholder;
        if (f.required) input.required = true;
        if (f.value !== undefined) input.value = f.value;
        inputs[f.key] = input;
        dialog.appendChild(input);
      }

      // openOverlay's `close` takes no args and so cannot distinguish a dismiss (Escape/backdrop/Cancel) from a
      // submit/extra-action. The web close-guard NEEDS that distinction — a dismiss must resolve to "cancel" (keep
      // the doc open) via `onCancel`, and it adds a middle "Discard" button via `extraActions`. We bridge here:
      // `decided` is a one-shot latch set true ONLY by submit / an extra-action; a dismiss fires `spec.onCancel`
      // exactly once (guarded by `cancelFired`) on any close where `decided` is still false.
      let decided = false; // set by submit or an extra-action — a deliberate choice, NOT a dismiss
      let cancelFired = false; // one-shot so onCancel fires at most once across the (possibly multiple) close paths
      // Fire onCancel exactly once iff this teardown was a genuine dismiss (no submit/extra-action ran first).
      const fireCancelOnce = (): void => {
        if (decided || cancelFired) return;
        cancelFired = true;
        spec.onCancel?.();
      };

      const actions = document.createElement("div");
      actions.className = "fl-modal__actions";
      const submitBtn = document.createElement("button");
      submitBtn.type = "button";
      submitBtn.className = "fl-tool";
      submitBtn.textContent = spec.submitLabel;

      // Any extra middle actions (e.g. the close-guard's "Discard"): each marks the choice as decided (so the
      // ensuing teardown does NOT fire onCancel), runs its onClick, then closes.
      const extraBtns: HTMLButtonElement[] = (spec.extraActions ?? []).map((a) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "fl-tool";
        btn.textContent = a.label;
        btn.addEventListener("click", () => {
          decided = true;
          a.onClick();
          close();
        });
        return btn;
      });

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "fl-tool";
      cancelBtn.textContent = "Cancel";
      actions.append(submitBtn, ...extraBtns, cancelBtn);
      dialog.appendChild(actions);

      // Submit: gather trimmed values; if any required field is empty, no-op (keep the modal open so the user can
      // correct it — the required inputs also block an empty submit semantically). Submit is a deliberate choice,
      // so mark `decided` before tearing down (suppresses onCancel).
      const submit = (): void => {
        const values: Record<string, string> = {};
        for (const f of spec.fields) values[f.key] = inputs[f.key].value.trim();
        if (spec.fields.some((f) => f.required && !values[f.key])) return;
        decided = true;
        spec.onSubmit(values);
        close();
      };
      submitBtn.addEventListener("click", submit);
      // Cancel is a dismiss: fire onCancel (guarded), then close.
      cancelBtn.addEventListener("click", () => {
        fireCancelOnce();
        close();
      });
      // Enter submits. openOverlay's keytrap already stops the key from reaching the editor and handles
      // Escape/Tab; this listener only adds the modal-specific Enter=submit, then prevents the default.
      dialog.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        }
      });
      // The Escape/backdrop dismiss paths fire on the OVERLAY (openOverlay's listeners live there too and call its
      // `close`); we only need to translate those dismissals into onCancel. `dialog.parentElement` is the overlay.
      const overlayEl = dialog.parentElement;
      overlayEl?.addEventListener("keydown", (e) => {
        if (e.key === "Escape") fireCancelOnce();
      });
      overlayEl?.addEventListener("click", (e) => {
        if (e.target === overlayEl) fireCancelOnce();
      });

      // Focus order: each field, then submit, then any extra actions, then cancel (openOverlay focuses the first +
      // traps Tab within).
      const focusables: HTMLElement[] = [...spec.fields.map((f) => inputs[f.key]), submitBtn, ...extraBtns, cancelBtn];
      // Select the first field's text so the user can type/replace immediately (openOverlay focuses it).
      const first = spec.fields[0] ? inputs[spec.fields[0].key] : null;
      first?.select();
      return focusables;
    });
  };

  // Resolve the editor configuration and mount it through the view factory + dispatch seam.
  const rt = buildEditorRuntime();

  // The single tabbed sidebar (Documents | Outline). It reads the doc READ-ONLY (buildOutline) and
  // scrolls a clicked heading into view THROUGH the existing dispatch seam (no mutation, no new dispatch path).
  // A Documents click focuses that window via the bridge (absent in the bare browser preview → guarded `?.`). The
  // "+ New document" button runs the SAME guarded New as File▸New (doNew, defined above so it is in scope here).
  const sidebar = createSidebar({
    getView,
    onFocusWindow: (winId) => {
      void window.flowline?.focusWindow(winId);
    },
    onNewDoc: () => {
      void doNew().catch(() => window.flowline?.showError("Could not create a new document."));
    },
  });

  // Learn THIS window's id so the Documents pane can mark "this doc". Async; the sidebar re-marks the
  // (possibly already-rendered) list when it resolves. Guarded — absent in the bare browser preview (no bridge).
  void window.flowline?.getWinId().then((id) => sidebar.setSelfWinId(id));

  // ── BOOT (initial doc) ─────────────────────────────────────────────────────────────────────────────────
  // The whole view construction + post-view wiring runs inside an async IIFE so we can `await` the initial-doc
  // PULL from MAIN before constructing the editor. PULL this window's initial doc from MAIN: `seed` → the
  // DEV-gated stand-in intro doc (createSeedDoc, itself import.meta.env.DEV-guarded so seed.ts tree-shakes from a
  // prod bundle); `empty` → a blank newDoc; `file` → decode docJson via the existing document-validation path and
  // remember its path. A bare browser preview / the web build (no window.flowline) falls back to the seed.
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
        // Web MDI: a clean→dirty flip must surface the ● on this doc's Documents row. (Desktop reports dirty to
        // MAIN via updateTitle→reportDocState; web has no MAIN, so re-render the in-window list here.)
        if (isWeb) {
          registry.setActiveDirty(true);
          renderWebDocs();
        }
      }
    });
    viewRef.current = view;

    if (topbar) topbar.appendChild(toolbar.dom);
    // ALWAYS-PRESENT Settings gear: a ⚙ button in the topbar that opens the Settings overlay to the Appearance
    // section (theme picker). The builtin Appearance section + light/dark themes are registered once at module-init
    // above.
    if (topbar) {
      const settingsGear = document.createElement("button");
      settingsGear.type = "button";
      settingsGear.className = "fl-settings-gear";
      settingsGear.textContent = "⚙";
      settingsGear.title = "Settings";
      settingsGear.setAttribute("aria-label", "Settings");
      // Open Settings to Appearance. openSettings is single-instance via the shared latch, so a stray double
      // click is a graceful no-op.
      settingsGear.addEventListener("click", () => openSettings("appearance"));
      topbar.appendChild(settingsGear);
    }
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

    // ── File/menu wiring ─────────────────────────────────────────────────────────────────────────────────
    // Run an async menu action, surfacing a rejection through the same error path the file ops use, rather than
    // letting a rejected promise fail silently.
    const run = (p: Promise<void>): void => {
      void p.catch(() => void showError("That action could not be completed."));
    };

    // ── WEB single-user wiring (E10b) ────────────────────────────────────────────────────────────────────
    // Everything here runs ONLY in web (no preload bridge). It activates the in-window MDI registry, the web file
    // dialogs/close-guard, and a Ctrl/Cmd+S interceptor. Desktop (bridge) skips this block entirely, so its
    // behavior is byte-for-byte unchanged.
    if (isWeb) {
      // 1) Seed the registry with the boot doc so the Documents list has the initial doc as its first entry.
      registry.add(EditorState.create({ schema, doc: initialDoc }), currentPath);
      handles.set(registry.activeId()!, null);

      // 2) A lightweight in-renderer toast (no native dialog on web): a dismissible fl-prefixed banner that
      // auto-removes. One builder, two seams — `webShowError` (role=alert, persists longer) for failures, and
      // `webNotify` (role=status, brief) for transient confirmations like "Saved". Both are module-scope seams the
      // file handlers (defined before boot) route through.
      const showToast = (message: string, role: "alert" | "status", autoMs: number): void => {
        const toast = document.createElement("div");
        toast.className = role === "status" ? "fl-toast fl-toast--ok" : "fl-toast";
        toast.setAttribute("role", role);
        toast.textContent = message;
        const dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.className = "fl-toast-close";
        dismiss.textContent = "×";
        dismiss.setAttribute("aria-label", "Dismiss");
        dismiss.addEventListener("click", () => toast.remove());
        toast.appendChild(dismiss);
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), autoMs);
      };
      webShowError = (message: string): void => showToast(message, "alert", 6000);
      webNotify = (message: string): void => showToast(message, "status", 2200);

      // 3) The web unsaved-changes prompt: the SAME Save/Discard/Cancel choice as the desktop native dialog,
      // rendered with the shared modal scaffold. Resolves with the UnsavedChoice. (A backdrop-dismiss / Escape
      // resolves "cancel" — the safe default that keeps the doc open.) One prompt at a time (createModal latches).
      webPrompt = (): Promise<UnsavedChoice> =>
        new Promise<UnsavedChoice>((resolve) => {
          let answered = false;
          const settle = (choice: UnsavedChoice): void => {
            if (answered) return;
            answered = true;
            resolve(choice);
          };
          createModal({
            title: "You have unsaved changes",
            fields: [],
            submitLabel: "Save",
            onSubmit: () => settle("save"),
            extraActions: [{ label: "Discard", onClick: () => settle("discard") }],
            onCancel: () => settle("cancel"),
          });
        });

      // 4) Wire the Documents pane to the registry. renderWebDocs (the module-scope seam) re-renders from the live
      // registry; select switches the active doc; close runs the guarded close for that doc.
      renderWebDocs = (): void =>
        sidebar.setWebDocs(registry.list(), {
          onSelect: (id) => {
            if (registry.activeId() === id) return; // already active → no-op
            parkActive();
            if (registry.select(id)) activateEntry();
          },
          onClose: (id) => {
            void closeWebDoc(id);
          },
          onNew: () => {
            void doNew();
          },
        });
      sidebar.setTab("documents"); // web opens on the Documents pane so the MDI list is visible
      renderWebDocs();

      // 5) Web accelerators (no Electron native menu here, so the renderer binds them itself). Capture phase +
      // preventDefault so the browser's own action never fires. Other keys fall through to ProseMirror untouched.
      //   • Ctrl/Cmd+S → app Save (Shift = Save As) instead of the browser "save page" (S1).
      //   • Ctrl+M → New document. (Plain Ctrl+N is browser-reserved for a new window, and Ctrl+Alt+N is grabbed
      //     upstream by AltGr/assistive-tech — neither reaches the page; Ctrl+M is the reliable web New chord.
      //     See web-keys.ts isNewChord. New is also one click away via the menu + the Documents "New" button.)
      window.addEventListener(
        "keydown",
        (e) => {
          if (isSaveChord(e)) {
            e.preventDefault(); // stop the browser's "save page" (S1)
            run(isSaveAsChord(e) ? doSave(true) : doSave(false)); // Shift = Save As
          } else if (isNewChord(e)) {
            e.preventDefault();
            run(doNew()); // same guarded New as File▸New / the Documents "New" button
          }
        },
        { capture: true },
      );
    }

    // The guarded window-close flow, shared by the Window>Close menu command and MAIN's close-request. Desktop:
    // run the unsaved-work guard; only if it clears (or the guard itself throws) tell MAIN it is safe to close THIS
    // window. WEB: there is no MAIN window to close — Window>Close closes the ACTIVE in-window doc through the SAME
    // guarded path as the Documents-row x (closeWebDoc), so S5 (the x) and S6 (Window>Close) are ONE flow.
    const requestGuardedClose = async (): Promise<void> => {
      if (isWeb) {
        const id = registry.activeId();
        if (id) await closeWebDoc(id);
        return;
      }
      try {
        if (await guardUnsaved()) await window.flowline?.requestClose();
      } catch {
        await window.flowline?.requestClose(); // never trap the user if the guard itself fails
      }
    };

    // The single renderer-side menu-command handler. BOTH the native menu (relayed via the preload bridge, desktop
    // only) and the in-renderer menu bar (mounted below on web) call this — one command path, no drift.
    const dispatchMenuCommand = (cmd: MenuCommand): void => {
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
          const v = getView();
          undo(v.state, v.dispatch);
          v.focus();
          break;
        }
        case "edit:redo": {
          const v = getView();
          redo(v.state, v.dispatch);
          v.focus();
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
    };
    // Desktop (Electron): the NATIVE menu owns File/Edit/View/Window and stays visible — it relays accelerator/menu
    // clicks here. We do NOT add the in-renderer bar there: it would just duplicate the native menu and clutter the
    // topbar (user 2026-06-18: "if standalone, remove the web-styled pane, keep the original panes").
    window.flowline?.onMenuCommand(dispatchMenuCommand);
    // Web (no preload bridge): there is NO native menu, so mount the in-renderer menu bar after the brand to surface
    // the same commands via the SAME dispatchMenuCommand. File (New/Open/Save/Export) and Window>Close are wired on
    // web via the `isWeb` block above (FSA + Blob-download fallbacks).
    if (!window.flowline) {
      const menubar = createMenuBar({ dispatch: dispatchMenuCommand });
      topbar?.querySelector(".fl-brand")?.after(menubar.dom);
    }

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
