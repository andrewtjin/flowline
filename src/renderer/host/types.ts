// renderer/host/types.ts — the EditorHost platform-capability contract (EditorHost refactor §S1).
//
// THE REFRAME (CONTEXT-MAP): the old `const isWeb = !window.flowline` predicate conflated platform detection with
// the file/dialog/windowing wiring. This module owns the platform axis explicitly: the host is resolved once at
// boot; the renderer (main.ts) then depends on `host.*` for every platform primitive, and platform branches
// collapse to two implementations: DesktopHost (window.flowline bridge) and WebHost (FSA/Blob + in-window MDI).
//
// The host names platform CAPABILITIES only; it stays free of any non-platform coupling (enforced by
// scripts/check-host-imports.ts), which keeps this editor-only tree derivable.
//
// ISP SPLIT (§R4): one large "god host" would force web to stub desktop-only lifecycle methods. Instead:
//   • FileHost      — file I/O + user feedback + boot initial-doc.            BOTH platforms.
//   • WindowHost    — the multi-document surface (MDI).                       BOTH platforms.
//   • DesktopShell  — Electron menu relay, close interception, quit guard.    DESKTOP-ONLY (web never stubs it).
// resolveHost returns `FileHost & WindowHost` always, plus a `DesktopShell` only on desktop; main.ts wires the
// shell behind ONE `if (shell)` — the lone honest platform conditional that survives the refactor.
//
// VIEW BOUNDARY (§R8 — bidirectional DI): main.ts OWNS the command handlers (doNew/doOpen/doSave/doSaveAs/
// doExport/loadDoc) — they alone touch the EditorView, LOAD_META, and dirty state. The host provides (a) the
// platform I/O primitives those handlers call (e.g. `host.save(json)`), and (b) the platform UI surface (web
// menubar / desktop menu relay / Documents-pane clicks) that INVOKES those handlers via callbacks injected at
// construction. Hence `focusDocument` mutates registry/window state ONLY; the actual `view.dispatch(LOAD_META)`
// stays on main.ts's side of the seam (preserving invariant #5: LOAD_META on every doc load).

// Reuse the bridge result/contract types verbatim — ONE source of truth, shared with the Electron MAIN process.
// verbatimModuleSyntax requires the literal `import type` form for these (they are types, never runtime values).
import type {
  OpenResult,
  SaveResult,
  UnsavedChoice,
  MenuCommand,
  OpenDocEntry,
  InitialDoc,
  DocState,
} from "../../persistence/bridge";

/**
 * Opaque handle to ONE open document surface. Desktop: a BrowserWindow id (number, via the bridge). Web: a
 * doc-registry id (string). Kept as a union (NOT normalized to string) so neither the desktop bridge wire types
 * nor the web registry need churning — callers treat it as opaque and never inspect the underlying kind (§Q3).
 */
export type DocumentRef = string | number;

/**
 * FileHost — file I/O, user feedback, and the boot initial-doc. Available on BOTH platforms. Every method resolves
 * to the SAME bridge result type on both platforms, so the WebHost adapts its FSA/Blob results into these shapes.
 */
export interface FileHost {
  /** Which platform this host is. Lets a handler self-describe; NOT a substitute for the `if (shell)` seam. */
  readonly platform: "desktop" | "web";

  // ── File I/O (both platforms) ──
  /** Open dialog → decode a .fl file. Desktop: MAIN dialog+frame; web: FSA picker → web-envelope decode. */
  open(): Promise<OpenResult>;
  /** Save the doc JSON (to `suggestedPath` if known, else prompt). Desktop: MAIN; web: FSA handle / Blob fallback. */
  save(docJson: unknown, suggestedPath?: string): Promise<SaveResult>;
  /** Always prompt for a destination, then write. Desktop: MAIN dialog; web: FSA "save as" / download. */
  saveAs(docJson: unknown): Promise<SaveResult>;
  /** Export the doc JSON as .docx. Desktop: MAIN; web: web-docx → Blob download. */
  exportDocx(docJson: unknown, suggestedName?: string): Promise<SaveResult>;

  // ── User feedback ──
  /** Surface an error. Desktop: native dialog (awaited); web: a persistent toast banner (role=alert). */
  showError(message: string): Promise<void>;
  /** Transient confirmation (e.g. "Saved …"). Desktop: no-op (the native title bar suffices); web: brief toast. */
  notify(message: string): void;
  /** Ask the user about unsaved work. Desktop: native 3-button dialog; web: in-DOM Save/Discard/Cancel modal. */
  confirmUnsaved(): Promise<UnsavedChoice>;

  // ── Boot ──
  /** This window's initial doc. Desktop: PULL from MAIN (seed|empty|file); web: {seed|empty} (no MAIN). */
  getInitialDoc(): Promise<InitialDoc>;
}

/**
 * WindowHost — the multi-document (MDI) surface, on BOTH platforms. Desktop: each doc is a BrowserWindow spawned
 * via MAIN. Web: docs live in an in-window registry (doc-registry.ts) the WebHost owns.
 */
export interface WindowHost {
  /** Open a new document surface. No payload → blank New; `{docJson,path}` → an Open-spawned surface. */
  newDocument(opts?: { docJson: unknown; path: string }): Promise<void>;
  /** Close the active document surface. Desktop: close the window (after main.ts's dirty guard); web: drop the registry entry. */
  closeActiveDocument(): Promise<void>;
  /** Bring the surface identified by `ref` to the front (Documents-tab click). Mutates registry/window focus ONLY — main.ts's injected loadDoc does the view dispatch (§R8). */
  focusDocument(ref: DocumentRef): Promise<void>;
  /** This surface's OWN ref (to mark "this doc" in the Documents tab). Desktop: getWinId; web: registry active id. null if unresolved. */
  getSelfRef(): Promise<DocumentRef | null>;
  /** Report this surface's title/dirty/path. Desktop: → MAIN (drives the window registry rebroadcast); web: → local registry re-render. */
  reportDocState(state: DocState): void;
  /** Subscribe to the live open-docs list (drives the Documents tab). Desktop: MAIN broadcast; web: local registry. */
  onOpenDocsChanged(cb: (docs: OpenDocEntry[]) => void): void;
}

/**
 * DesktopShell — desktop-ONLY lifecycle wiring: the Electron menu relay, single-window close interception, and the
 * SEQUENTIAL quit guard. Web NEVER stubs these (resolveHost returns a DesktopShell only on desktop); main.ts wires
 * them behind ONE `if (shell)` block. The WebHost installs its OWN DOM menubar + Ctrl+S/M accelerators internally
 * at construction, so there is no web counterpart to onMenuCommand here.
 */
export interface DesktopShell {
  /** Subscribe to File/Edit/View/Window menu commands relayed from MAIN to the focused renderer. */
  onMenuCommand(cb: (cmd: MenuCommand) => void): void;
  /** Subscribe to a single-window close attempt MAIN intercepted; main.ts runs its dirty guard then calls requestClose(). */
  onCloseRequest(cb: () => void): void;
  /**
   * Subscribe to MAIN's SEQUENTIAL quit guard. MUST be called in the boot's SYNC zone, BEFORE the first await
   * (the getInitialDoc PULL) — a Quit fired mid-boot would otherwise hit a not-yet-subscribed renderer and hang
   * MAIN's reply-await (ipcRenderer.on has no buffering). Pinned by tests/renderer/quit-guard-timing.test.ts (§R6).
   */
  onQuitGuard(cb: () => void): void;
  /** Reply to MAIN's quit guard for THIS window: "clear" lets the quit proceed; "cancel" aborts the whole quit. */
  replyQuitGuard(result: "clear" | "cancel"): void;
  /** Tell MAIN it is now safe to close this window (the renderer has handled any unsaved work). */
  requestClose(): Promise<void>;
}

/** The always-present platform host: file I/O + the multi-document surface, on every platform. */
export type EditorHost = FileHost & WindowHost;

/**
 * What resolveHost(...) returns: the always-present `host`, plus `shell` ONLY on desktop (null on web). main.ts
 * wires shell handlers behind a single `if (shell)` — the one honest platform conditional that replaces the whole
 * tri-modal `isWeb` tangle.
 */
export interface ResolvedHost {
  readonly host: EditorHost;
  readonly shell: DesktopShell | null;
}
