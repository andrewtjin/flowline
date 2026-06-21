// renderer/main.ts — the renderer entry (browser dev preview AND the Electron renderer).
//
// Mounts the one Flowline EditorView with the mark toolbar, the keymaps, and the File machinery. The
// dispatch passed to `createFlowlineView` is the documented extension point (editor.ts): it calls the
// single real `applyTransaction` (the only `view.updateState`) and then syncs the toolbar's active state —
// there is still ONE place state is applied.
//
// This is the single-user editor: prosemirror-history undo, File/Edit/View/Window menus, the tabbed sidebar +
// live outline, the initial-doc PULL, .fl persistence, .docx export, Settings + dark mode. `buildEditorRuntime`
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
import { moveBlock } from "../commands";
import { createToolbar } from "../toolbar";
import { createSidebar } from "./sidebar";
import type { DocEntry } from "./doc-registry";
import { resolveHost } from "./host/resolve-host";
import { WebHost } from "./host/web-host";
import { needsClosePrompt, resolveClose } from "./close-guard";
import { isReusable } from "./outline";
import { schema } from "../schema";
import { structureHost } from "../structure-host";
import { docFromJson } from "../persistence/document";
import type { MenuCommand } from "../persistence/bridge";
import { SCHEMA_VERSION } from "../version";
import { buildEditorRuntime, topLevelBlockIds, blockText, firstBodyPos } from "./runtime";
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
  // localStorage — it never enters doc.toJSON() (S-003). (createSidebar lives further down; the "+ New document"
  // onNewDoc is wired into THAT call.)
  registerBuiltinSettings();
  loadPersistedTheme(settingsRegistries().themes);
  // ── File state (PERIPHERAL — lives here in session scope, NEVER in the doc) ──────────
  let currentPath: string | null = null;
  let dirty = false;

  // ── PLATFORM (EditorHost) ────────────────────────────────────────────────────────────────────────────
  // The platform axis — web FSA file I/O + the in-window MDI registry/handles vs the desktop `window.flowline`
  // bridge — is owned by the EditorHost resolved once below (resolveHost). The old `isWeb` predicate + the
  // renderer-only MDI registry/handles that lived here moved into WebHost (host/web-host.ts); the renderer now
  // depends on `host.*` for every platform primitive. The desktop-vs-web boot/window asymmetries are the inherent
  // handful of `host.platform` checks that remain.

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
    // Route through the platform host: desktop → MAIN (drives the Documents broadcast); web → the WebHost's
    // in-window Documents pane (surfaces the ● / title). (`host` is resolved further below; this arrow only runs at
    // interaction/boot time, after construction — the same forward-closure idiom as `run` / the `dispatch` thunk.)
    host.reportDocState({ title, dirty, path: currentPath });
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
  // tagged LOAD_META so the absorb normalizer ignores it (preserving save→reopen equality) and the dirty-flag
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

  // (The WEB in-window helpers that used to live here — webPrompt / parkActive / activateEntry / renderWebDocs /
  // closeWebDoc — moved into WebHost (host/web-host.ts), which now OWNS the MDI registry + handles. main.ts keeps
  // only the irreducible view residue as `loadActiveEntry` (the §R8 LOAD_META dispatch, defined in the seam zone).)

  // New (renderer-decides reuse): open a blank doc. DESKTOP reuses THIS window if it is an untouched empty
  // "Untitled" (isReusable) — load a blank doc in place (main-side, through the LOAD_META seam) — else asks the host
  // to spawn a fresh window, leaving THIS window's doc untouched. No unsaved-guard: a reuse only happens when the
  // doc is clean + empty (nothing to lose), and a spawn never touches the current doc.
  //
  // WEB has no separate windows, so it routes straight to the host's in-window MDI add (host.newDocument parks the
  // current doc, adds a fresh one, activates it — the prior doc stays in the Documents list).
  const doNew = async (): Promise<void> => {
    if (host.platform === "desktop" && isReusable(getView().state.doc, dirty, currentPath)) {
      loadDoc(newDoc());
      currentPath = null;
      dirty = false;
      updateTitle();
      getView().focus();
      return;
    }
    await host.newDocument(); // desktop → spawn a window; web → add an in-window doc
  };

  // Open: the host shows the picker + decodes/validates the .fl into an OpenResult{docJson,path}. DESKTOP: if THIS
  // window is reusable (untouched empty Untitled) load the decoded doc in place (main-side, through the LOAD_META
  // seam; a bad doc leaves the current one intact), else spawn a new window pre-loaded with it. WEB: host.open()
  // stashed the FSA handle, and host.newDocument({docJson,path}) adds the doc as a NEW in-window entry that adopts
  // that handle (save-in-place), so Open never clobbers the doc the user is looking at. A cancel / frame-error /
  // bad-doc changes nothing.
  const doOpen = async (): Promise<void> => {
    const res = await host.open();
    if (!res.ok) {
      if (res.message) await host.showError(res.message); // a frame/decode error; a plain cancel is silent
      return;
    }
    if (host.platform === "desktop" && isReusable(getView().state.doc, dirty, currentPath)) {
      // Desktop reuse in place: validate + load the decoded doc through the seam (a bad doc leaves the current one intact).
      let doc: PMNode;
      try {
        doc = docFromJson(res.docJson); // root-type assert + nodeFromJSON + check(); throws on a bad doc
      } catch (err) {
        await host.showError(err instanceof Error ? err.message : "Could not open the file.");
        return;
      }
      loadDoc(doc);
      currentPath = res.path;
      dirty = false;
      updateTitle();
      getView().focus();
      return;
    }
    // Otherwise adopt the opened doc in a fresh surface: desktop → a new window (MAIN stashes the payload for its
    // PULL); web → a new in-window doc that adopts the FSA handle host.open() just stashed (§S3 problem #1).
    await host.newDocument({ docJson: res.docJson, path: res.path });
  };

  // Never PERSIST a check()-invalid doc — Open runs check() and would refuse it, so writing one means an
  // unreopenable file. A null-blockId block can still arise from a structural replace over a node-selection (a
  // pre-existing editor-core edge the paste guard now avoids on the paste path); refuse to save/export rather
  // than write a file that can't be reopened. Returns the doc JSON, or null after surfacing the error via the host
  // (desktop native dialog / web toast). Reached only from doSave/doExport.
  const validDocJson = async (): Promise<unknown | null> => {
    try {
      getView().state.doc.check();
    } catch {
      await host.showError("This document has an invalid block and cannot be saved. Undo your last change and try again.");
      return null;
    }
    return getView().state.doc.toJSON();
  };

  // Save (Ctrl+S → save to the current path, prompting only if none) / Save As (always prompt). Routed through the
  // host: desktop → MAIN dialog + fs; web → a real `.fl` via the File System Access API (a reusable handle ⇒
  // overwrite in place) or a Blob download — WebHost updates its registry entry's handle/path/dirty + the Documents
  // pane + the "Saved …" / denied-permission toast internally, and returns a SaveResult; main.ts adopts the resulting
  // path into the session state. A cancelled picker returns {ok:false} with no message, leaving `dirty` set (so the
  // close-guard correctly aborts). Byte format == desktop (envelope-frame).
  const doSave = async (forceDialog: boolean): Promise<void> => {
    const json = await validDocJson();
    if (json === null) return;
    const res = forceDialog ? await host.saveAs(json) : await host.save(json, currentPath ?? undefined);
    if (!res.ok) {
      if (res.message) await host.showError(res.message); // a cancel is silent (leaves dirty set → close aborts)
      return;
    }
    currentPath = res.path;
    dirty = false;
    updateTitle();
  };

  // Unsaved-work guard, shared by New, Open, and the window-close attempt. Returns true if it is safe to PROCEED
  // (discard the current doc / close), false to ABORT. When the doc is clean there is nothing to guard, so proceed.
  // Otherwise prompt via the host (desktop: native dialog; web-solo: in-renderer Save/Discard/Cancel modal —
  // host.confirmUnsaved); the PURE close-guard (close-guard.ts) resolves the 3-way answer identically on both:
  //   - cancel  → abort (false)
  //   - save    → run doSave; proceed ONLY if it actually cleared `dirty` (a cancelled Save-As / write error leaves
  //               `dirty` set, so we abort rather than silently lose the work)
  //   - discard → proceed (true), dropping the unsaved edits
  const guardUnsaved = async (): Promise<boolean> => {
    if (!needsClosePrompt(dirty)) return true; // clean → no prompt
    const choice = await host.confirmUnsaved();
    if (choice === "save") await doSave(false); // may itself prompt for a path; dirty clears iff it succeeded
    return resolveClose(choice, !dirty) === "close";
  };

  // Export to Word: prompt + write a .docx; does not affect the current .fl path or the dirty flag. Routed through
  // the host: desktop → MAIN dialog + write; web → web-docx bundles a Blob download from the SAME IR/Document
  // (host.exportDocx forwards the suggested name; desktop ignores it and prompts).
  const doExport = async (): Promise<void> => {
    const json = await validDocJson();
    if (json === null) return;
    const res = await host.exportDocx(json, currentPath ?? fileLabel());
    if (!res.ok && res.message) await host.showError(res.message);
  };

  // (The MAIN-orchestrated SEQUENTIAL quit guard is registered through the desktop `shell` in the EditorHost seam
  // block below — still SYNCHRONOUSLY, before the boot IIFE's `await getInitialDoc`, preserving §R6. It moved past
  // the sidebar because it now needs the resolved `shell`, which depends on `rt` + the sidebar-backed web deps.)

  // createModal — a shared lightweight in-renderer modal scaffold (the web unsaved-changes prompt). Browsers have no
  // built-in text-input dialog, so we render our own: a dim full-screen backdrop + a centered dialog with a title,
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
  // Settings overlay share ONE module-level latch and can never stack. openOverlay owns the backdrop, the
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
      // the doc open) via `onCancel`, and it adds a middle "Discard" button via `extraActions`. We bridge the two
      // here: `decided` is a one-shot latch set true ONLY by submit / an extra-action; the listeners below fire
      // `spec.onCancel` exactly once on any close where `decided` is still false. Escape/backdrop call openOverlay's
      // `close` directly, so we also hang onCancel off the overlay teardown via the Cancel button + our own
      // Escape/backdrop listeners; to cover the openOverlay-internal Escape/backdrop paths without double-firing,
      // onCancel is guarded by `decided` and the one-shot `cancelFired`.
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
      // Escape/Tab; this listener only adds the modal-specific Enter=submit, then prevents the default. Escape and
      // backdrop dismissal go through openOverlay's own `close`; we fire onCancel for those here so the close-guard
      // sees a "cancel" on ANY dismissal (guarded by `decided`/`cancelFired` to never fire after a real choice).
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
      const focusables: HTMLElement[] = [
        ...spec.fields.map((f) => inputs[f.key]),
        submitBtn,
        ...extraBtns,
        cancelBtn,
      ];
      // Select the first field's text so the user can type/replace immediately (openOverlay focuses it).
      const first = spec.fields[0] ? inputs[spec.fields[0].key] : null;
      first?.select();
      return focusables;
    });
  };

  // Resolve the editor configuration and mount it through the view factory + dispatch seam.
  const rt = buildEditorRuntime();

  // The single tabbed sidebar (Documents | Outline). It reads the doc READ-ONLY (buildOutline) and scrolls a clicked
  // heading into view THROUGH the existing dispatch seam (no mutation, no new dispatch path). A Documents click
  // focuses that window via the host.
  const sidebar = createSidebar({
    getView,
    onFocusWindow: (winId) => {
      void host.focusDocument(winId);
    },
    // The Documents pane's "+ New document" button runs the SAME guarded New as File▸New (doNew: reuse an empty
    // window or spawn a new one on desktop; a fresh in-window doc on web). doNew is defined above, so it is in
    // scope here; the inlined catch surfaces a spawn failure through the same native error dialog the file ops use.
    onNewDoc: () => {
      void doNew().catch(() => void host.showError("Could not create a new document."));
    },
  });

  // (This window's id → sidebar.setSelfWinId, the desktop Documents-pane "this doc" marker, now fires in the
  // EditorHost seam block below — it needs the resolved `host` (host.getSelfRef), so it moved past resolveHost.)

  // ── EditorHost platform seam (EditorHost refactor §S4 boot wiring + §S5 call-site migration) ──
  // Resolve the ONE platform host now, in the SYNC boot zone (before the async IIFE). The preload bridge present →
  // DesktopHost (handed back as `shell` too); absent → WebHost (shell null). The WebHost ctor SEEDS its registry
  // synchronously (§R7) — which is exactly why this lives here and not in the IIFE — yet it only TOUCHES the live
  // view at INTERACTION time (through the lazy getView/loadActiveEntry/dispatch below), never during boot. §S5
  // migrated every File / menu / window call site + the boot initial-doc branch onto `host.*` and deleted the
  // parallel inline `isWeb` web wiring, so this host is now the SOLE platform surface (there is no second path).
  // `run` / `requestGuardedClose` / `dispatchMenuCommand` are HOISTED out of the boot IIFE to here so the sync-zone
  // WebHost ctor can close over `dispatchMenuCommand` (it only reaches the view at call time via getView, post-ctor).

  // Run an async menu/file action, surfacing a rejection through the same native error dialog the file ops use
  // (rather than letting a rejected promise fail silently).
  const run = (p: Promise<void>): void => {
    void p.catch(() => void host.showError("That action could not be completed."));
  };

  // Make a registry entry the live editor — the §R8 view residue WebHost delegates back to main.ts: replace the doc
  // through the SINGLE dispatch seam (LOAD_META so it is not counted as a user edit), adopt the entry's path/dirty,
  // retitle, refocus. This is the ONLY view.dispatch path the host drives; the registry mechanics live in WebHost.
  const loadActiveEntry = (entry: DocEntry): void => {
    const view = getView();
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, entry.state.doc.content);
    tr.setMeta(LOAD_META, true);
    tr.setMeta("addToHistory", false);
    tr.setSelection(Selection.atStart(tr.doc));
    view.dispatch(tr);
    currentPath = entry.path;
    dirty = entry.dirty;
    updateTitle();
    view.focus();
  };

  // The SINGLE read of the preload bridge: present ⇒ desktop, absent ⇒ web. Read once into a local so neither the
  // web-initial-doc gate below nor the resolveHost call re-touches the global — this is the one place main.ts looks
  // at `window.flowline`; every platform decision after this goes through `host` / `shell`.
  const bridge = window.flowline;

  // The web platform's initial doc (no bridge): the DEV seed else a blank doc — matching the web boot branch.
  // Computed ONCE here and shared by BOTH the WebHost registry seed (its §R7 ctor) AND the view the IIFE builds
  // below (problem #2: createSeedDoc/newDoc mint RANDOM blockIds, so deriving it twice would desync the
  // Documents-pane entry from the live doc). On desktop the bridge PULL supplies the real start doc, so this is an
  // unused placeholder there — guard the DEV seed compute behind the no-bridge predicate so desktop pays nothing for it.
  const webInitialDocKind: "seed" | "empty" = !bridge && import.meta.env.DEV ? "seed" : "empty";
  const webInitialDoc: PMNode = webInitialDocKind === "seed" ? createSeedDoc() : newDoc();

  // Resolve the host ONCE. `dispatch` is a lazy thunk over dispatchMenuCommand (defined just below) — the same
  // forward-ref-through-a-closure idiom main.ts already uses for getView/run, resolved only at interaction time.
  const { host, shell } = resolveHost({
    bridge,
    deps: {
      initialDoc: webInitialDoc,
      initialDocKind: webInitialDocKind,
      makeEmptyDoc: newDoc,
      getView,
      getCurrentPath: () => currentPath,
      getDirty: () => dirty,
      loadActiveEntry,
      guardUnsaved,
      dispatch: (cmd) => dispatchMenuCommand(cmd),
      sidebar,
      mountMenuBar: (dom) => {
        topbar?.querySelector(".fl-brand")?.after(dom);
      },
      createModal,
    },
  });

  // §R6 — register the SEQUENTIAL quit guard SYNCHRONOUSLY, before the boot IIFE's first await (the getInitialDoc
  // PULL). On a Quit, MAIN sends "flowline:quitGuard" one window at a time; we run the SAME unsaved-work guard as a
  // close and reply "clear" (safe to quit this window) or "cancel" (abort the whole quit), replying "clear" on a
  // guard throw so a failure never wedges the quit. `shell` is null on web (no MAIN, nothing to guard) — exactly
  // today's no-bridge no-op. guardUnsaved is safe pre-view (`dirty` is false until the first edit). Pinned by
  // tests/renderer/quit-guard-timing.test.ts (`.onQuitGuard(` must precede `getInitialDoc(`).
  if (shell) {
    const desktop = shell;
    desktop.onQuitGuard(() => {
      void (async () => {
        try {
          desktop.replyQuitGuard((await guardUnsaved()) ? "clear" : "cancel");
        } catch {
          desktop.replyQuitGuard("clear"); // never wedge the quit on a guard failure
        }
      })();
    });
  }

  // Learn THIS window's id (DESKTOP) so the Documents pane can mark "this doc"; the sidebar re-marks the (possibly
  // already-rendered) open-docs list when it resolves. Desktop-only: the web Documents pane (setWebDocs) self-marks
  // from its registry, and host.getSelfRef on web is a registry STRING (not a winId) — so this stays gated to desktop,
  // matching today's no-bridge no-op. Fire-and-forget; setSelfWinId runs once the winId resolves.
  if (host.platform === "desktop") {
    void host.getSelfRef().then((ref) => {
      if (typeof ref === "number") sidebar.setSelfWinId(ref);
    });
  }

  // The guarded window-close flow, shared by the Window>Close menu command and MAIN's close-request (desktop). Run
  // the unsaved-work guard; only if it clears (or the guard itself throws) tell MAIN it is safe to close THIS window
  // via the shell. WEB: there is no MAIN window — Window>Close closes the ACTIVE in-window doc through the SAME
  // guarded path as the Documents-row x (closeWebDoc), so the x and Window>Close are ONE flow, never two.
  const requestGuardedClose = async (): Promise<void> => {
    if (host.platform === "web") {
      // Web: Window>Close closes the ACTIVE in-window doc through the host's guarded close (the SAME path as the
      // Documents-row ×).
      await host.closeActiveDocument();
      return;
    }
    try {
      if (await guardUnsaved()) await shell?.requestClose();
    } catch {
      await shell?.requestClose(); // never trap the user if the guard itself fails
    }
  };

  // The single renderer-side menu-command handler. BOTH the desktop native menu (relayed via shell.onMenuCommand)
  // and the in-renderer menu bar (web) call this — one command path, no drift.
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
      // Edit menu: route undo/redo to PM's existing history commands through the single dispatch seam. These are the
      // SAME commands bound to Mod-Z / Shift-Mod-Z in the runtime — the menu items carry registerAccelerator:false so
      // PM's keymap stays the sole keyboard owner; the menu is a click affordance for the identical action.
      // Cut/copy/paste arrive as NATIVE roles on the focused webContents (not these commands), so they're not handled
      // here — PM's clipboard/pasteGuard handling stays intact.
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
  };

  // ── BOOT (initial doc) ──────────────────────────────────────────────────────────────────────────────────
  // The whole view construction + post-view wiring runs inside an async IIFE so the desktop boot can `await` the
  // initial-doc PULL from MAIN before constructing the editor:
  //   - DESKTOP: PULL this window's initial doc from MAIN. `seed` → the DEV-gated stand-in intro doc (createSeedDoc,
  //     itself import.meta.env.DEV-guarded so seed.ts tree-shakes from a prod bundle); `empty` → a blank newDoc;
  //     `file` → decode docJson via the existing document-validation path and remember its path.
  //   - WEB: no MAIN to PULL from — use the once-computed web initial doc. A bare browser preview keeps the seed.
  void (async () => {
    let initialDoc: PMNode;
    if (host.platform === "desktop") {
      // Desktop: PULL this window's initial doc from MAIN (through the host). This stays AFTER the
      // sync-zone shell.onQuitGuard registration (R6 timing — pinned by quit-guard-timing.test.ts).
      const init = await host.getInitialDoc();
      if (init.kind === "file") {
        try {
          initialDoc = docFromJson(init.docJson); // validated decode (root assert + check); throws on a bad doc
          currentPath = init.path;
        } catch {
          // A corrupt hand-off should never strand the window blank-but-broken: fall back to an empty New doc and
          // surface the error through the same native dialog the file ops use.
          initialDoc = newDoc();
          void host.showError("Could not open the file (it may be unreadable).");
        }
      } else if (init.kind === "empty") {
        initialDoc = newDoc();
      } else {
        // seed: DEV-only content. import.meta.env.DEV is statically false in prod so createSeedDoc tree-shakes out
        // and a prod first-window falls back to a blank doc (MAIN only ever sends "seed" in DEV anyway).
        initialDoc = import.meta.env.DEV ? createSeedDoc() : newDoc();
      }
    } else {
      // Web: no MAIN to PULL from — use the once-computed web initial doc, the SAME node the WebHost registry was
      // seeded with in the sync zone (§R7 / problem #2), so the Documents-pane entry and the live view never
      // diverge. (Value-identical to a no-bridge `{kind:"seed"}` → DEV?createSeedDoc():newDoc() branch.)
      initialDoc = webInitialDoc;
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
        // updateTitle → reportDocState → host.reportDocState surfaces the ● wherever this doc is shown: desktop →
        // MAIN's Documents broadcast; web → the WebHost in-window Documents row.
        updateTitle();
      }
    });
    viewRef.current = view;

    if (topbar) topbar.appendChild(toolbar.dom);
    // The Settings gear: a ⚙ button in the topbar that opens the Settings overlay to the Appearance section (theme
    // picker). This is the app-wide settings entry. The builtin Appearance section + light/dark themes are
    // registered once at module-init below.
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

    // ── WEB interactive chrome (installed via host.mountUI() below) ───────────────────────────────────────
    // The web in-window wiring that used to live inline here — the registry seed, the toast seams, the unsaved
    // prompt, the Documents-pane wiring, and the Ctrl+S/Ctrl+M accelerators — now lives in WebHost: the registry is
    // seeded in its ctor (§R7), and the rest installs through host.mountUI() (called once in the menu-wiring section
    // below, after the view + sidebar exist). Desktop has no counterpart — its menu is the native Electron menu,
    // relayed via shell.onMenuCommand. So this block is gone; nothing platform-specific runs here at boot anymore.

    // ── File/menu wiring (routed through the EditorHost seam — §S4) ──────────────────────────────────────
    // `run` / `requestGuardedClose` / `dispatchMenuCommand` now live in the sync-zone seam block above (hoisted so
    // the WebHost ctor can close over the dispatcher); the boot IIFE here only SUBSCRIBES the platform handlers.
    //
    // Desktop (Electron): the NATIVE menu owns File/Edit/View/Window and relays clicks via the shell. We do NOT add
    // the in-renderer bar there: it would just duplicate the native menu and clutter the topbar (user 2026-06-18:
    // "if standalone, remove the web-styled pane, keep the original panes"). `shell` is null on web → not subscribed
    // (matches today's no-bridge no-op).
    shell?.onMenuCommand(dispatchMenuCommand);
    // Web (no shell): install the WebHost interactive chrome now that the view + sidebar exist — the in-renderer
    // menubar (surfacing the same commands via dispatchMenuCommand), the Documents pane, and the Ctrl+S/Ctrl+M
    // accelerators. Desktop mounts nothing here (its native Electron menu is relayed via shell.onMenuCommand above).
    // `mountUI` is a WebHost-specific method, hence the instanceof narrow (not on EditorHost).
    if (host instanceof WebHost) host.mountUI();

    // Handle a window-close attempt (desktop): MAIN intercepts the close and emits "flowline:close-request"; we run
    // the shared guarded close flow and, only if it clears, tell MAIN it is safe to close (which re-issues the close).
    // `shell` is null on web — there is no MAIN window to close (Window>Close there closes the active in-window doc
    // through requestGuardedClose's web arm: host.closeActiveDocument), exactly today's no-bridge no-op.
    shell?.onCloseRequest(() => {
      void requestGuardedClose();
    });

    // Keep the Documents tab live: desktop = MAIN broadcasts the full open-windows list on every registry mutation
    // (a window opens / closes / renames / changes dirty) and the sidebar re-renders it; web = a no-op (the
    // WebHost-owned in-window Documents pane drives itself). Both match today's behavior (web had no bridge here).
    host.onOpenDocsChanged((docs) => sidebar.setOpenDocs(docs));

    // (The §R6 SEQUENTIAL quit guard — shell.onQuitGuard — is registered earlier, synchronously, in the sync-zone
    // seam block BEFORE this IIFE's await, so a Quit during boot is never dropped. See that registration above.)

    // Report the initial doc-state once the window is wired, so a freshly spawned window appears with its real title
    // (e.g. an Open-spawned window's filename) in every Documents tab even before the first edit. updateTitle above
    // already fired one report; this is the same de-duped call, harmless if the tuple is unchanged.
    reportDocState();

    // ── DEV-only e2e control surface ─────────────────────────────────────────────────────────────────────
    // `import.meta.env.DEV` is statically false in the production build, so this whole block is tree-shaken out
    // of the shipped bundle. ids/text/reorder/edit/caret read or drive the live view for the headless block specs.
    if (import.meta.env.DEV) {
      // The __flowlineCaret hook drives the caret THROUGH ProseMirror's dispatch (not native DOM selection) so
      // headless tests (e2e/blocks.spec.ts) get a deterministic caret with no PM adoption race. DEV-only and
      // tree-shaken from the production bundle.
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

      // The e2e surface uses the pure helpers from runtime.ts (topLevelBlockIds / blockText / firstBodyPos) so
      // edit/caret address the REAL seed's random body-paragraph ids (not the harness `${id}p1`).
      const e2e = {
        // ids: enumerate top-level blockIds directly from doc.content (DRY via the exported helper).
        ids: (): string[] => topLevelBlockIds(view.state.doc),
        // text: full textContent of a top-level block by its blockId.
        text: (id: string): string => blockText(view.state.doc, id),
        reorder: (id: string, dir: "up" | "down"): void => {
          moveBlock(id, dir)(view.state, view.dispatch);
        },
        // edit: insert text at the first inline position inside block `id`. Guards pos > 0 so a bad id no-ops.
        edit: (id: string, text: string): void => {
          const pos = firstBodyPos(view.state.doc, id);
          if (pos > 0) view.dispatch(view.state.tr.insertText(text, pos));
        },
        // caret: place a collapsed caret inside block `id`'s first textblock AND focus the editor — so a
        // subsequent REAL keypress (e.g. Mod-z) reaches the keymap deterministically, without click geometry.
        caret: (id: string): void => {
          const pos = firstBodyPos(view.state.doc, id);
          if (pos > 0) {
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
            view.focus();
          }
        },
      };

      (window as unknown as { __flowlineE2E: { e2e: typeof e2e } }).__flowlineE2E = { e2e };
    }
  })(); // end the async boot IIFE (the desktop boot awaited getInitialDoc before constructing the view)
}
