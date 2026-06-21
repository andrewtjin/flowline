// renderer/host/web-host.ts — the WEB platform binding for the EditorHost seam (EditorHost refactor §S3).
//
// Desktop has a single capability object handed in by the preload (`window.flowline`); the web build has NO such
// object — its "platform" was, until this refactor, a pile of `if (isWeb)` branches inlined in main.ts. WebHost IS
// that pile, gathered behind the EditorHost contract: it OWNS the in-window MDI registry (doc-registry.ts) + the
// per-doc File System Access handles, and it WRAPS the web platform IO (web-files / web-docx), the toast/modal DOM,
// and the Ctrl+S / Ctrl+M accelerators (web-keys predicates). One class satisfies `FileHost & WindowHost`
// (= EditorHost); web has no `DesktopShell` (resolveHost returns `shell: null` on web).
//
// THE VIEW BOUNDARY (§R8 — bidirectional DI). main.ts KEEPS every handler that touches the EditorView, LOAD_META,
// or the session `dirty`/`currentPath` state (doNew/doOpen/doSave/doSaveAs/doExport/loadDoc/guardUnsaved). WebHost
// provides (a) the platform IO PRIMITIVES those handlers call (`host.save(json)` → a `.fl` write), and (b) the web
// UI SURFACE (toast / modal / Documents pane / accelerators / menubar) that INVOKES those handlers back through
// `deps.dispatch` (the one MenuCommand handler) and a few injected view callbacks. The only view-touching residue
// WebHost reaches is through `deps.getView()` (a READ, for parking the active doc's state) and
// `deps.loadActiveEntry(entry)` (main-side: the LOAD_META dispatch + path/dirty adoption + title/focus) — so EVERY
// `view.dispatch` stays on main.ts's side of the seam, preserving invariant #5 (LOAD_META on every doc load).
//
// REFINEMENT discovered during impl (S1 anticipated this): the CHECKPOINT listed `parkActive`/`activateEntry` as
// "main KEEPS", but they straddle the registry (now WebHost-owned) and the view. The clean cut moves their REGISTRY
// mechanics here and keeps ONLY their irreducible view residue main-side as `deps.loadActiveEntry` — so the registry
// has exactly one owner and no view.dispatch crosses into the host.
//
// SEED IN THE CTOR (§R7). The registry is seeded SYNCHRONOUSLY in the constructor, killing today's click-before-boot
// window (the sidebar "+ New" button went live before the async IIFE seeded the registry → `parkActive()` on an
// empty registry). The seed node is INJECTED (`deps.initialDoc`), computed ONCE by the boot and shared with the view
// it builds — because `createSeedDoc()`/`newDoc()` mint RANDOM blockIds, deriving the seed twice (once here, once for
// the view) would desync the Documents-pane entry from the live doc (§S3 problem #2).
//
// This file imports only editor/persistence modules + ./types, keeping the platform layer dependency-clean
// (enforced by scripts/check-host-imports.ts).

import type { OpenResult, SaveResult, UnsavedChoice, InitialDoc, DocState, MenuCommand, OpenDocEntry } from "../../persistence/bridge";
import type { EditorHost, DocumentRef } from "./types";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { EditorState } from "prosemirror-state";
import { schema } from "../../schema";
import { docFromJson } from "../../persistence/document";
import { createDocRegistry } from "../doc-registry";
import type { DocRegistry, DocEntry } from "../doc-registry";
import { webOpenFl, webSaveFl } from "../web-files";
import { webExportDocx } from "../../persistence/web-docx";
import { isSaveChord, isSaveAsChord, isNewChord } from "../web-keys";
import { createMenuBar } from "../menubar";
import type { Sidebar, WebDocHandlers } from "../sidebar";

/** One text field in the shared modal scaffold (the subset confirmUnsaved needs — empty for the unsaved prompt). */
export interface ModalField {
  readonly key: string;
  readonly placeholder: string;
  readonly required?: boolean;
  readonly value?: string;
}
/** An extra middle button (the unsaved prompt's "Discard") between the primary action and Cancel. */
export interface ModalAction {
  readonly label: string;
  readonly onClick: () => void;
}
/** The shared in-renderer modal spec. main.ts owns the scaffold; WebHost only drives it for `confirmUnsaved`, so the
 *  builder is injected (`deps.createModal`) rather than imported. */
export interface ModalSpec {
  readonly title: string;
  readonly fields: ModalField[];
  readonly submitLabel: string;
  readonly onSubmit: (values: Record<string, string>) => void;
  readonly extraActions?: ModalAction[];
  readonly onCancel?: () => void;
}

/**
 * Everything WebHost needs that lives on main.ts's side of the §R8 seam, plus the test seams. Grouped by role.
 */
export interface WebHostDeps {
  // ── Initial doc (computed ONCE by the boot; shared between this ctor's registry seed and the view, §R7/problem #2) ──
  /** The boot-computed initial doc node. Seeds the registry in the ctor; the boot builds the view from the SAME node. */
  readonly initialDoc: PMNode;
  /** What `getInitialDoc()` reports (DEV → seed, else empty). The node above is authoritative for the web view. */
  readonly initialDocKind: "seed" | "empty";
  /** A fresh blank doc (File▸New / last-doc-close replacement). = main.ts's `newDoc()`. */
  readonly makeEmptyDoc: () => PMNode;

  // ── §R8 view-side seam — invoked at INTERACTION time only; never a stored live view (problem #3) ──
  /** Read the live view (for parking the active doc's state into the registry). A READ; never dispatched here. */
  readonly getView: () => EditorView;
  /** main.ts's session path (parked into the active registry entry on switch-away). */
  readonly getCurrentPath: () => string | null;
  /** main.ts's session dirty flag (parked into the active registry entry on switch-away). */
  readonly getDirty: () => boolean;
  /** main.ts-side: dispatch `entry.state.doc` through the LOAD_META seam, adopt entry.path/dirty, update title, focus. */
  readonly loadActiveEntry: (entry: DocEntry) => void;
  /** main.ts's unsaved-work guard (the PURE close-guard + a web Save). Run before dropping a doc; true ⇒ proceed. */
  readonly guardUnsaved: () => Promise<boolean>;

  // ── Command routing + UI surface ──
  /** main.ts's single MenuCommand handler. Accelerators, the menubar, and "+ New" all route through it (§R8). */
  readonly dispatch: (cmd: MenuCommand) => void;
  /** The sidebar control surface WebHost drives (the web Documents pane + opening on that tab). */
  readonly sidebar: Pick<Sidebar, "setWebDocs" | "setTab">;
  /** Mount the web menubar DOM (main.ts places it after the brand). WebHost builds the bar; main only mounts it. */
  readonly mountMenuBar: (dom: HTMLElement) => void;
  /** The shared modal scaffold (used for the unsaved-changes prompt). Injected — main.ts owns it (Join shares it). */
  readonly createModal: (spec: ModalSpec) => void;

  // ── Test seams (optional; default to the real web platform IO + crypto id) ──
  /** Override the file IO functions (so a unit test fakes them without stubbing FSA globals). */
  readonly io?: {
    readonly open?: typeof webOpenFl;
    readonly save?: typeof webSaveFl;
    readonly exportDocx?: typeof webExportDocx;
  };
  /** Override the registry id minter (a deterministic counter in tests; crypto.randomUUID in production). */
  readonly mintId?: () => string;
}

/** The base filename of a path (handles `\` and `/`); "Untitled" when there is no path. Mirrors doc-registry titleOf. */
function titleOf(path: string | null): string {
  if (!path) return "Untitled";
  return path.split(/[\\/]/).pop() || "Untitled";
}

/**
 * The web platform host: an in-window MDI editor with FSA/Blob file IO and DOM chrome. Implements EditorHost
 * (FileHost & WindowHost); resolveHost (§S4) constructs it only when `window.flowline` is absent and hands it out as
 * `{ host, shell: null }` (web has no DesktopShell).
 */
export class WebHost implements EditorHost {
  /** FileHost.platform tag. Always "web"; a handler can self-describe (NOT a substitute for the `if (shell)` seam). */
  readonly platform = "web" as const;

  /** The in-window MDI registry (owned here): open docs + their parked EditorStates + paths + dirty flags. */
  private readonly registry: DocRegistry;
  /** Per-doc File System Access handle, keyed by registry id, so a plain Save overwrites in place with no re-prompt.
   *  Kept OUT of the registry (typed for doc/path/dirty) — session state, never in any doc.toJSON() (F2/S-003). */
  private readonly handles = new Map<string, FileSystemFileHandle | null>();
  /** The just-opened FSA handle, stashed by `open()` for the immediately-following `newDocument({docJson,path})` to
   *  adopt (the only way to thread the picker's save-in-place handle through the docJson-shaped FileHost contract,
   *  §S3 problem #1). Consume-or-discard on every `newDocument`, so it can never leak across operations. */
  private pendingOpenHandle: FileSystemFileHandle | null = null;

  // The injected web platform IO (real by default; faked in tests).
  private readonly openFl: typeof webOpenFl;
  private readonly saveFl: typeof webSaveFl;
  private readonly exportDocxFl: typeof webExportDocx;

  /**
   * @param deps  the §R8 main-side seam + UI surface + (optional) test seams. The constructor SEEDS the registry
   *              synchronously with `deps.initialDoc` (§R7), so the Documents pane has the boot doc as its first
   *              entry the instant the host exists — before any "+ New" click can fire.
   */
  constructor(private readonly deps: WebHostDeps) {
    this.openFl = deps.io?.open ?? webOpenFl;
    this.saveFl = deps.io?.save ?? webSaveFl;
    this.exportDocxFl = deps.io?.exportDocx ?? webExportDocx;
    this.registry = createDocRegistry(deps.mintId);
    // §R7: seed the registry in the ctor (sync zone) with the boot's initial doc — the SAME node the boot builds the
    // view from (deps.initialDoc), so the parked entry and the live view never diverge (problem #2). A brand-new
    // seed has no save handle yet.
    this.registry.add(this.makeState(deps.initialDoc), this.deps.getCurrentPath());
    this.handles.set(this.registry.activeId()!, null);
  }

  /** Build a detached registry EditorState snapshot for `doc` (no plugins — the live plugin-wired view edits it once
   *  activated; the registry only PARKS the doc's state). */
  private makeState(doc: PMNode): EditorState {
    return EditorState.create({ schema, doc });
  }

  // ═══════════════════════════════════════════════ FileHost: file IO ═══════════════════════════════════════════════

  /**
   * Open a `.fl` via the browser file picker (FSA, or an `<input type=file>` fallback), decode + validate it, and
   * surface it as an `OpenResult`. The picker's FSA handle (save-in-place) is stashed in `pendingOpenHandle` for the
   * ensuing `newDocument({docJson,path})` to adopt (§S3 problem #1). A user-dismissed picker is a silent
   * `{ok:false, canceled:true}`; a corrupt/newer/invalid file is `{ok:false, message}`. main.ts shows any message
   * (symmetric with desktop), then registers the doc via `newDocument`.
   */
  async open(): Promise<OpenResult> {
    const res = await this.openFl();
    if (!res.ok) return res.message ? { ok: false, message: res.message } : { ok: false, canceled: true };
    // toJSON()→(later)docFromJson round-trips through the docJson-shaped contract; blockIds live in the JSON so the
    // reconstructed node is identical. The handle can't ride the wire type, so it is stashed instead.
    this.pendingOpenHandle = res.handle;
    return { ok: true, docJson: res.doc.toJSON(), path: res.name };
  }

  /** Save to the active doc's known FSA handle in place (no prompt) if there is one, else prompt (FSA picker / Blob). */
  save(docJson: unknown, suggestedPath?: string): Promise<SaveResult> {
    return this.writeFl(docJson, false, suggestedPath);
  }

  /** Always prompt for a destination, then write (Save As). */
  saveAs(docJson: unknown): Promise<SaveResult> {
    return this.writeFl(docJson, true, undefined);
  }

  /**
   * The shared web write path for Save / Save As. Rebuilds the PMNode from `docJson` (main.ts already validated it via
   * validDocJson), writes a `.fl` through web-files, updates this doc's handle + the registry's path/dirty + the
   * Documents pane, and surfaces the WEB-INTERNAL post-save feedback that the contract `SaveResult` can't carry:
   *   - `downloadedFallback` (the write permission was denied → bytes went to a NEW Downloads copy) → an honest warning;
   *   - otherwise → a transient "Saved <name>" toast.
   * The choice between them depends on `downloadedFallback` (web-only knowledge), so it lives here; the error MESSAGE
   * rides the SaveResult so main.ts shows it (symmetric with desktop). A cancel returns `{ok:false}` with no message,
   * leaving `dirty` set (main.ts only clears it on ok), so a later close-guard correctly aborts.
   */
  private async writeFl(docJson: unknown, forceDialog: boolean, suggestedPath?: string): Promise<SaveResult> {
    // The FileHost contract is docJson-shaped (desktop parity), but webSaveFl needs a PMNode, so rebuild + validate
    // here. A malformed payload must NOT throw into the caller's click handler — convert a validation failure into a
    // SaveResult the caller surfaces, leaving the registry/handles untouched. (main.ts pre-validates via
    // validDocJson, so in practice this never fires; it is defense-in-depth for the `docJson: unknown` seam.)
    let doc: PMNode;
    try {
      doc = docFromJson(docJson);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Could not save the file." };
    }
    const id = this.registry.activeId();
    const res = await this.saveFl(doc, {
      handle: id ? this.handles.get(id) ?? null : null,
      forceDialog,
      suggestedName: suggestedPath ?? this.activeLabel(),
    });
    if (!res.ok) return res.message ? { ok: false, message: res.message } : { ok: false, canceled: true };

    if (id) this.handles.set(id, res.handle); // remember (or drop, on a denied-permission fallback) the handle
    this.registry.setActivePath(res.name);
    this.registry.setActiveDirty(false);
    this.renderWebDocs();
    if (res.downloadedFallback) void this.showError("Permission denied — saved a copy to Downloads instead.");
    else this.notify(`Saved ${res.name}`);
    return { ok: true, path: res.name };
  }

  /**
   * Export the doc JSON to a `.docx` and download it (web bundles via Packer.toBlob; same IR/Document as desktop).
   * Returns a SaveResult; main.ts shows any error message (symmetric with desktop). Does not touch the `.fl` path.
   */
  async exportDocx(docJson: unknown, suggestedName?: string): Promise<SaveResult> {
    const res = await this.exportDocxFl(docJson, suggestedName ?? this.activeLabel());
    return res.ok ? { ok: true, path: res.name } : { ok: false, message: res.message };
  }

  // ═════════════════════════════════════════════ FileHost: user feedback ═══════════════════════════════════════════

  /** Surface an error as a dismissible alert toast (web has no native dialog). Resolves once shown (the contract is
   *  Promise<void> because desktop awaits a native dialog; web has nothing to await). */
  showError(message: string): Promise<void> {
    this.showToast(message, "alert", 6000);
    return Promise.resolve();
  }

  /** A transient confirmation toast (e.g. "Saved …"). Brief, role=status. */
  notify(message: string): void {
    this.showToast(message, "status", 2200);
  }

  /**
   * Ask the user about unsaved work via the shared modal scaffold: the SAME Save / Discard / Cancel choice as the
   * desktop native dialog. A backdrop/Escape dismissal resolves "cancel" (the safe default — keep the doc open). One
   * prompt at a time (the scaffold latches).
   */
  confirmUnsaved(): Promise<UnsavedChoice> {
    return new Promise<UnsavedChoice>((resolve) => {
      let answered = false;
      const settle = (choice: UnsavedChoice): void => {
        if (answered) return;
        answered = true;
        resolve(choice);
      };
      this.deps.createModal({
        title: "You have unsaved changes",
        fields: [],
        submitLabel: "Save",
        onSubmit: () => settle("save"),
        extraActions: [{ label: "Discard", onClick: () => settle("discard") }],
        onCancel: () => settle("cancel"),
      });
    });
  }

  // ═══════════════════════════════════════════════ FileHost: boot ══════════════════════════════════════════════════

  /** This window's initial-doc DESCRIPTOR. The web view's authoritative initial doc is the node injected at
   *  construction (also seeded into the registry); this reports the kind for EditorHost conformance. No MAIN pull. */
  getInitialDoc(): Promise<InitialDoc> {
    return Promise.resolve({ kind: this.deps.initialDocKind });
  }

  // ═════════════════════════════════════════ WindowHost: the MDI surface ═══════════════════════════════════════════

  /**
   * Open a new in-window document surface. No payload → a blank New; `{docJson,path}` → an Open-spawned surface that
   * adopts the FSA handle `open()` just stashed. Parks the current doc first (so switching back restores it), then
   * adds + activates the new one.
   */
  async newDocument(opts?: { docJson: unknown; path: string }): Promise<void> {
    // Build + VALIDATE the new doc BEFORE mutating any state, so a malformed open-spawned docJson can neither
    // half-apply (an entry added with no doc) nor strand the stashed open handle (the original bug: resetting
    // pendingOpenHandle before a docFromJson that then throws). The docJson came from open() (already validated), so
    // this normally can't throw — it is defense-in-depth for the `docJson: unknown` seam; a failure leaves the
    // registry + pendingOpenHandle untouched and surfaces an error.
    let state: EditorState;
    try {
      state = this.makeState(opts ? docFromJson(opts.docJson) : this.deps.makeEmptyDoc());
    } catch {
      void this.showError("Could not open the file (it may be unreadable).");
      return;
    }
    this.parkActive();
    // Consume-or-discard the open handle so a stray one can never leak onto a later doc (only an open-spawned add
    // adopts it; a blank New always starts handle-less).
    const openedHandle = this.pendingOpenHandle;
    this.pendingOpenHandle = null;
    this.registry.add(state, opts ? opts.path : null);
    this.handles.set(this.registry.activeId()!, opts ? openedHandle : null);
    this.activateEntry();
  }

  /** Close the ACTIVE in-window doc (Window▸Close on web). Routes through the SAME guarded close as the Documents-row ×. */
  async closeActiveDocument(): Promise<void> {
    const id = this.registry.activeId();
    if (id) await this.closeDoc(id);
  }

  /** Bring the doc identified by `ref` (a registry id) to the front: park the current, switch, activate. No-op when
   *  `ref` is already active. main.ts's injected `loadActiveEntry` does the actual view dispatch (§R8). */
  async focusDocument(ref: DocumentRef): Promise<void> {
    if (this.registry.activeId() === ref) return; // already active → no switch
    this.parkActive();
    if (this.registry.select(ref as string)) this.activateEntry();
  }

  /** This surface's OWN ref (to mark "this doc" in the Documents tab) = the active registry id, or null if empty. */
  getSelfRef(): Promise<DocumentRef | null> {
    return Promise.resolve(this.registry.activeId());
  }

  /** Report this surface's title/dirty/path. On web there is no MAIN: mirror the state into the active registry entry
   *  and re-render the Documents pane so its row (● dirty marker, title) stays live. */
  reportDocState(state: DocState): void {
    this.registry.setActivePath(state.path);
    this.registry.setActiveDirty(state.dirty);
    this.renderWebDocs();
  }

  /** Subscribe to the live open-docs list. No-op on web: the in-window Documents pane is driven by WebHost itself
   *  (renderWebDocs → sidebar.setWebDocs), not by a MAIN broadcast — there is nothing external to subscribe to. */
  onOpenDocsChanged(_cb: (docs: OpenDocEntry[]) => void): void {
    // intentional no-op (web owns its Documents pane locally)
  }

  // ═════════════════════════════════════ UI surface install (§R4 — not an interface method) ════════════════════════

  /**
   * Install the web interactive chrome. Called ONCE by the boot AFTER the view is built (the accelerators' targets —
   * doSave/doNew via `dispatch` — read the live view, which must exist when a key actually fires; the boot is
   * synchronous on web, so no keypress can land before this returns). Separate from the ctor because the registry
   * seed (§R7) must happen in the sync zone while the interactive surface belongs after the view.
   *
   * It mounts the in-renderer MENUBAR (which replaces the absent Electron native menu), opens the in-window MDI
   * Documents pane, and binds the Ctrl+S/Ctrl+M file accelerators.
   */
  mountUI(): void {
    const menubar = createMenuBar({ dispatch: this.deps.dispatch });
    this.deps.mountMenuBar(menubar.dom);
    this.deps.sidebar.setTab("documents"); // open on the Documents pane so the MDI list is visible
    this.renderWebDocs();
    this.installAccelerators();
  }

  // ═══════════════════════════════════════════════ internals ═══════════════════════════════════════════════════════

  /** Display label for the active doc (the active entry's filename, or "Untitled") — seeds the save picker/download. */
  private activeLabel(): string {
    return titleOf(this.registry.active()?.path ?? null);
  }

  /** Sync the live editor + session path/dirty INTO the active registry entry, so a switch-away parks the latest
   *  edits and a switch-back restores them exactly. The view read is the lone live-view touch on the host side (§R8). */
  private parkActive(): void {
    this.registry.syncActiveState(this.deps.getView().state);
    this.registry.setActivePath(this.deps.getCurrentPath());
    this.registry.setActiveDirty(this.deps.getDirty());
  }

  /** Make the registry's active entry the live editor: main.ts's injected `loadActiveEntry` does the LOAD_META
   *  dispatch + path/dirty adoption + title/focus (§R8); WebHost only re-renders the Documents pane after it. */
  private activateEntry(): void {
    const entry = this.registry.active();
    if (!entry) return;
    this.deps.loadActiveEntry(entry);
    this.renderWebDocs();
  }

  /**
   * Guarded close of ONE in-window doc by registry id (the Documents-row × AND Window▸Close share this path). Make
   * the target active first (so the guard + live view address THAT doc), run main.ts's unsaved-work guard, and only
   * on "proceed" drop it + activate the neighbour the registry returns — or, when the last doc closes, add a fresh
   * empty doc so the window never goes doc-less (mirrors desktop never going blank). On "abort" the doc stays open.
   */
  private async closeDoc(id: string): Promise<void> {
    if (this.registry.activeId() !== id) {
      this.parkActive();
      if (this.registry.select(id)) this.activateEntry();
    }
    if (!(await this.deps.guardUnsaved())) return; // cancelled / a failed save → keep the doc open
    this.handles.delete(id);
    const nextId = this.registry.close(id);
    if (nextId === null) {
      this.registry.add(this.makeState(this.deps.makeEmptyDoc()), null);
      this.handles.set(this.registry.activeId()!, null);
    }
    this.activateEntry();
  }

  /** Re-render the web Documents pane from the live registry. Select switches the active doc; close runs the guarded
   *  close; "+ New" routes through the single MenuCommand handler (§R8). Re-passed on every registry mutation. */
  private renderWebDocs(): void {
    const handlers: WebDocHandlers = {
      onSelect: (id) => void this.focusDocument(id),
      onClose: (id) => void this.closeDoc(id),
      onNew: () => this.deps.dispatch("new"),
    };
    this.deps.sidebar.setWebDocs(this.registry.list(), handlers);
  }

  /** A lightweight dismissible toast banner (no native dialog on web). `alert` (role=alert, persists) for errors,
   *  `status` (role=status, brief) for confirmations. fl-prefixed classes (CSS-vocabulary gate). */
  private showToast(message: string, role: "alert" | "status", autoMs: number): void {
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
  }

  /**
   * Bind the web accelerators (no Electron native menu here). Capture phase + preventDefault so the browser's own
   * action never fires; other keys fall through to ProseMirror untouched. Each chord routes through the single
   * MenuCommand handler (§R8): Ctrl/Cmd+S → save (Shift = saveAs), Ctrl+M → new. (web-keys predicates own the
   * "which chord" decision; see web-keys.ts for why Ctrl+M, not Ctrl+N/Ctrl+Alt+N.)
   */
  private installAccelerators(): void {
    window.addEventListener(
      "keydown",
      (e) => {
        if (isSaveChord(e)) {
          e.preventDefault();
          this.deps.dispatch(isSaveAsChord(e) ? "saveAs" : "save");
        } else if (isNewChord(e)) {
          e.preventDefault();
          this.deps.dispatch("new");
        }
      },
      { capture: true },
    );
  }
}
