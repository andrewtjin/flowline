// renderer/host/desktop-host.ts — the DESKTOP platform binding for the EditorHost seam (EditorHost refactor §S2).
//
// On desktop the preload already exposes `window.flowline` (FlowlineBridge, persistence/bridge.ts), which IS this
// capability set one-to-one — MAIN owns fs + native dialogs + windowing, and the bridge hands back plain-data
// results over IPC. So DesktopHost is a THIN adapter: ~every method forwards to the matching bridge call. The few
// places it does more than forward are the deliberate, documented seams:
//   • naming: bridge uses window-centric verbs (requestNewWindow / requestClose / focusWindow / getWinId /
//     onOpenDocs); the host names the platform-neutral CAPABILITY (newDocument / …) so the web impl can satisfy
//     the same contract with an in-window registry instead of BrowserWindows.
//   • getSelfRef maps the bridge's "unresolved" sentinel (-1) to the host contract's `null`.
//
// ONE CLASS, THREE INTERFACES. The §R4 ISP split (FileHost / WindowHost / DesktopShell) exists so the WEB host
// never has to stub desktop-only lifecycle methods — it is a split of the *interfaces*, not a mandate for two
// desktop classes. On desktop all three are backed by the same single `window.flowline` object, so collapsing them
// into one adapter is the DRY choice: `resolveHost` (S4) constructs ONE DesktopHost and hands it out under two
// interface views — `host: EditorHost` and `shell: DesktopShell` (web returns `shell: null`).
//
// This file imports only persistence/bridge types + ./types, keeping the platform layer dependency-clean
// (enforced by scripts/check-host-imports.ts).

import type {
  OpenResult,
  SaveResult,
  UnsavedChoice,
  MenuCommand,
  OpenDocEntry,
  InitialDoc,
  DocState,
  FlowlineBridge,
} from "../../persistence/bridge";
import type { EditorHost, DesktopShell, DocumentRef } from "./types";

/**
 * The desktop platform host: forwards every EditorHost + DesktopShell capability to `window.flowline`. Constructed
 * only when the bridge exists (i.e. under Electron); selection is by whether the bridge exists in `resolveHost` (§5), the same
 * predicate desktop already uses — so wrapping the bridge introduces no behavior shift (the pure-refactor non-goal).
 */
export class DesktopHost implements EditorHost, DesktopShell {
  /** FileHost.platform tag. Always "desktop" — a handler can self-describe; NOT a substitute for the `if (shell)` seam. */
  readonly platform = "desktop" as const;

  /**
   * @param bridge  the preload `window.flowline` surface — already this capability set, 1:1.
   */
  constructor(private readonly bridge: FlowlineBridge) {}

  // ─────────────────────────────────────────── FileHost: file I/O ───────────────────────────────────────────
  // Desktop routes all of these through MAIN (native dialog + fs + the byte FRAME); the bridge returns plain data.

  open(): Promise<OpenResult> {
    return this.bridge.open();
  }

  save(docJson: unknown, suggestedPath?: string): Promise<SaveResult> {
    return this.bridge.save(docJson, suggestedPath);
  }

  saveAs(docJson: unknown): Promise<SaveResult> {
    return this.bridge.saveAs(docJson);
  }

  exportDocx(docJson: unknown, _suggestedName?: string): Promise<SaveResult> {
    // Desktop ALWAYS prompts for the destination via the MAIN save dialog, so the web-only `suggestedName` (used to
    // pre-fill a browser download name) has no role here and is intentionally ignored.
    return this.bridge.exportDocx(docJson);
  }

  // ───────────────────────────────────────── FileHost: user feedback ────────────────────────────────────────

  showError(message: string): Promise<void> {
    return this.bridge.showError(message);
  }

  notify(): void {
    // Desktop no-op: the native window title bar (title + unsaved indicator) already reflects save state, so a
    // transient "Saved…" toast would be redundant chrome. (The param is dropped — nothing to surface.)
  }

  confirmUnsaved(): Promise<UnsavedChoice> {
    return this.bridge.confirmUnsaved();
  }

  // ──────────────────────────────────────────── FileHost: boot ──────────────────────────────────────────────

  getInitialDoc(): Promise<InitialDoc> {
    return this.bridge.getInitialDoc();
  }

  // ───────────────────────────────────── WindowHost: the multi-document surface ──────────────────────────────
  // Desktop MDI = one BrowserWindow per doc, spawned/closed/focused via MAIN.

  newDocument(opts?: { docJson: unknown; path: string }): Promise<void> {
    // MAIN's app-global File▸New spawns a window; forward straight through.
    return this.bridge.requestNewWindow(opts);
  }

  closeActiveDocument(): Promise<void> {
    // On desktop the active doc IS the window, so closing it = ask MAIN to close (main.ts ran its dirty guard
    // first, §R8).
    return this.bridge.requestClose();
  }

  focusDocument(ref: DocumentRef): Promise<void> {
    // The Documents pane lists ALL windows and clicking focuses any of them. Desktop refs are BrowserWindow ids
    // (numbers — minted by getSelfRef→getWinId, carried in OpenDocEntry.winId); the opaque-handle contract (§Q3)
    // guarantees a desktop ref is never a web registry string, so the cast is safe.
    return this.bridge.focusWindow(ref as number);
  }

  async getSelfRef(): Promise<DocumentRef | null> {
    // Bridge resolves -1 when MAIN can't resolve the sender window (never expected in practice); the host contract
    // says "null if unresolved", so translate the sentinel rather than leaking -1 into ref comparisons.
    const winId = await this.bridge.getWinId();
    return winId < 0 ? null : winId;
  }

  reportDocState(state: DocState): void {
    this.bridge.reportDocState(state);
  }

  onOpenDocsChanged(cb: (docs: OpenDocEntry[]) => void): void {
    this.bridge.onOpenDocs(cb);
  }

  // ──────────────────────────── DesktopShell: desktop-only lifecycle (menus / close / quit) ──────────────────
  // These have NO web counterpart (web installs its own DOM menubar + accelerators); resolveHost exposes them only
  // on desktop, so main.ts wires them behind a single `if (shell)`.

  onMenuCommand(cb: (cmd: MenuCommand) => void): void {
    this.bridge.onMenuCommand(cb);
  }

  onCloseRequest(cb: () => void): void {
    this.bridge.onCloseRequest(cb);
  }

  onQuitGuard(cb: () => void): void {
    // The adapter only forwards; the §R6 sync-timing invariant (register BEFORE the boot IIFE's first await) is
    // main.ts's responsibility and is pinned by tests/renderer/quit-guard-timing.test.ts.
    this.bridge.onQuitGuard(cb);
  }

  replyQuitGuard(result: "clear" | "cancel"): void {
    this.bridge.replyQuitGuard(result);
  }

  requestClose(): Promise<void> {
    // Lifecycle "it is now safe to close this window" (after main.ts's guard).
    return this.bridge.requestClose();
  }
}
