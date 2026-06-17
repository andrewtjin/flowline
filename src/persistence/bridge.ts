// persistence/bridge.ts — the typed contract for the preload `window.flowline` bridge.
//
// Pure types only (no DOM, no node) so ONE source of truth is shared by the renderer (tsconfig.json) AND the
// preload/main (tsconfig.node.json). The actual `Window.flowline` global augmentation lives in vite-env.d.ts
// (DOM-only). Design split: MAIN does fs + dialogs + the byte FRAME (envelope.ts); it RETURNS results/errors as
// plain data over IPC (never raw bytes). The renderer turns docJson into a validated doc (document.ts), applies
// it through the single dispatch seam, and asks MAIN to show a native dialog on any error via `showError`.

/**
 * Menu commands the main process relays to the FOCUSED renderer via `onMenuCommand`. The File set
 * (new|open|save|saveAs|export) is the base surface; the multi-window shell adds Edit undo/redo, View
 * (sidebar toggle + tab switch), and Window:close. Clipboard (cut/copy/paste) and Window:minimize are
 * deliberately NOT here — they are native menu ROLES that act on the focused webContents directly, so they
 * never round-trip as a MenuCommand. Keep this union to exactly the commands that flow through onMenuCommand.
 */
export type MenuCommand =
  | "new"
  | "open"
  | "save"
  | "saveAs"
  | "export"
  | "edit:undo"
  | "edit:redo"
  | "view:toggleSidebar"
  | "view:tabDocuments"
  | "view:tabOutline"
  | "window:close";

/** The user's answer to the "you have unsaved changes" dialog (Save / Don't Save / Cancel). */
export type UnsavedChoice = "save" | "discard" | "cancel";

/** Result of an Open request: the decoded payload JSON + its path, a cancel, or a frame-level error message. */
export type OpenResult =
  | { readonly ok: true; readonly docJson: unknown; readonly path: string }
  | { readonly ok: false; readonly canceled?: boolean; readonly message?: string };

/** Result of a Save / Save As / Export request: the written path, a cancel, or an error message. */
export type SaveResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly canceled?: boolean; readonly message?: string };

/**
 * One entry in the live open-windows list MAIN broadcasts to every renderer's Documents tab. `winId` is the
 * BrowserWindow id (used to focus that window); `title`/`dirty` are the display mirror of what each renderer
 * reported. Display-only — the authoritative doc lives in each renderer, never serialized to MAIN.
 */
export interface OpenDocEntry {
  readonly winId: number;
  readonly title: string;
  readonly dirty: boolean;
}

/**
 * What a freshly spawned renderer PULLs from MAIN on boot (a race-free request/response) to decide its
 * starting doc. `seed` = the DEV-gated stand-in intro doc (first window only); `empty` = a blank `newDoc`;
 * `file` = an Open-spawned window that must load the decoded doc + remember its path.
 */
export type InitialDoc =
  | { readonly kind: "seed" }
  | { readonly kind: "empty" }
  | { readonly kind: "file"; readonly docJson: unknown; readonly path: string };

/**
 * The doc-state a renderer reports to MAIN whenever its title/dirty/path changes, driving the window registry
 * and the open-docs rebroadcast. Session/main-process state only — NEVER part of `doc.toJSON()`.
 */
export interface DocState {
  readonly title: string;
  readonly dirty: boolean;
  readonly path: string | null;
}

/** The API the preload exposes on `window.flowline`. */
export interface FlowlineBridge {
  readonly platform: string;
  readonly schemaSurface: string;
  /** Subscribe to File-menu commands from the main process (called once at startup). */
  onMenuCommand(cb: (cmd: MenuCommand) => void): void;
  /** Show the open dialog, read + frame-decode a .fl file. The renderer validates the returned docJson. */
  open(): Promise<OpenResult>;
  /** Encode + write the doc JSON to `path` (or prompt if absent). */
  save(docJson: unknown, path?: string): Promise<SaveResult>;
  /** Always prompt for a path, then encode + write the doc JSON. */
  saveAs(docJson: unknown): Promise<SaveResult>;
  /** Prompt for a path, then export the doc JSON as .docx. */
  exportDocx(docJson: unknown): Promise<SaveResult>;
  /** Ask the main process to show a native error dialog (used for open/validation/write failures). */
  showError(message: string): Promise<void>;
  /** Ask MAIN to show the native 3-button "you have unsaved changes" dialog; resolves with the user's choice. */
  confirmUnsaved(): Promise<UnsavedChoice>;
  /**
   * Subscribe to a window-close attempt MAIN intercepted while there may be unsaved work (called once at
   * startup). The renderer runs its dirty-guard, then calls `requestClose()` if it is safe to close.
   */
  onCloseRequest(cb: () => void): void;
  /** Tell MAIN it is now safe to close the window (the renderer has handled any unsaved work). */
  requestClose(): Promise<void>;

  // ── Multi-window shell ─────────────────────────────────────────────────────────────────────────
  /**
   * Report this window's current doc-state (title/dirty/path) to MAIN. MAIN updates the window registry and
   * rebroadcasts the full open-docs list to every window. Fire-and-forget (`ipcRenderer.send`); the renderer
   * dedupes so it only reports when the tuple actually changes.
   */
  reportDocState(state: DocState): void;
  /**
   * Subscribe to MAIN's open-docs broadcast (called once at startup). Fires with the full, live list whenever
   * any window opens / closes / renames (save) / changes dirty. Drives the Documents tab.
   */
  onOpenDocs(cb: (docs: OpenDocEntry[]) => void): void;
  /** Ask MAIN to bring the window with `winId` to the front (Documents-tab click → focus that doc's window). */
  focusWindow(winId: number): Promise<void>;
  /**
   * Resolve THIS window's own BrowserWindow id. The renderer uses it to mark its OWN row ("this doc") in the
   * Documents tab — the open-docs broadcast is the same list for every window, so a window needs its own id to
   * tell which entry is itself. Resolves -1 if the sender window can't be resolved (never expected in practice).
   */
  getWinId(): Promise<number>;
  /**
   * Ask MAIN to spawn a new BrowserWindow. With no payload → an empty New window; with `{docJson,path}` → an
   * Open-spawned window MAIN pre-loads (when the current window can't be reused per the reuse-empty rule).
   */
  requestNewWindow(payload?: { docJson: unknown; path: string }): Promise<void>;
  /**
   * PULL this window's initial doc from MAIN as the FIRST boot step, before constructing the editor (a
   * race-free request/response). `seed`/`empty`/`file` per `InitialDoc`.
   */
  getInitialDoc(): Promise<InitialDoc>;
  /**
   * Subscribe to MAIN's SEQUENTIAL quit guard (called once at startup). MAIN walks every window one
   * at a time on a real Quit gesture, sending this to each in turn and AWAITING a single reply. The renderer runs
   * its unsaved-work guard and answers via `replyQuitGuard("clear" | "cancel")` — "clear" if saved/discarded/clean,
   * "cancel" to abort the whole quit. Distinct from `onCloseRequest` (a single-window close), but it reuses the
   * same dirty-guard.
   */
  onQuitGuard(cb: () => void): void;
  /** Reply to MAIN's quit guard for THIS window: "clear" lets the quit proceed; "cancel" aborts it. */
  replyQuitGuard(result: "clear" | "cancel"): void;
}
