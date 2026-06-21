// renderer/doc-registry.ts — the renderer-only in-window MDI document registry (E10b-S4).
//
// On the WEB build there is no Electron multi-window shell, so "open several documents at once" is done IN ONE
// window: the renderer keeps a list of open documents and swaps which one is active. This module is that registry
// — a pure, DOM-free state container. It holds, per open doc: a stable id, the doc's last-known ProseMirror state
// SNAPSHOT (so selecting it restores exactly what the user was looking at), its file path (null = Untitled), and
// its dirty flag. New adds an entry and makes it active; selecting an entry makes it active; closing removes one.
//
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// CRITICAL INVARIANT (F2 / S-003 — the byte-for-byte equality guarantee). This registry is PERIPHERAL session state. It is
// NEVER serialized, and it NEVER enters `doc.toJSON()`. The persisted `.fl` content for a given document is a pure
// function of THAT document's own EditorState — it does not depend on how many other docs are in the registry, in
// what order, or which is active. The registry only PARKS each doc's own state; it never folds cross-doc data into
// a doc. The byte-for-byte equality test (tests/renderer/doc-registry.test.ts) proves `activeDoc().toJSON()` is identical
// with 0 vs N other docs open. Do not add anything here that a doc's toJSON could observe.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════

import type { EditorState } from "prosemirror-state";

/** One open document in the window. `state` is the doc's last-synced EditorState SNAPSHOT (parked on switch-away,
 *  restored on switch-back). `path`/`dirty` are this doc's own session/file state — never part of its toJSON. */
export interface DocEntry {
  /** A stable per-session id (NOT persisted, NOT in the doc) so the UI can address a row across re-renders. */
  readonly id: string;
  /** The doc's last-known editor state. Updated as the user edits the active doc; frozen while it is inactive. */
  state: EditorState;
  /** This doc's file path, or null for an unsaved "Untitled". Session/file state — never in doc.toJSON(). */
  path: string | null;
  /** Whether this doc has unsaved edits. Session state — never in doc.toJSON(). */
  dirty: boolean;
}

/** A read-only view of one entry for the UI (the registry owns the mutable entries). */
export interface DocView {
  readonly id: string;
  readonly path: string | null;
  readonly dirty: boolean;
  /** Display title: the file's base name, or "Untitled". Derived, never stored (no drift). */
  readonly title: string;
  /** Is this the currently active doc? */
  readonly active: boolean;
}

/** The base filename of a path (handles both `\` and `/`); "Untitled" when there is no path. */
function titleOf(path: string | null): string {
  if (!path) return "Untitled";
  return path.split(/[\\/]/).pop() || "Untitled";
}

/**
 * The MDI registry control surface. `mintId` is injected (crypto.randomUUID in production; a deterministic
 * counter in tests) so the registry carries no runtime dependency of its own and stays unit-testable.
 */
export interface DocRegistry {
  /** Add a new doc with `state` (+ optional path), make it active, and return its id. */
  add(state: EditorState, path?: string | null): string;
  /** Switch the active doc to `id`. No-op (returns false) if `id` is unknown. Returns true on a real switch. */
  select(id: string): boolean;
  /** Remove the doc `id`. Returns the id of the now-active doc (or null if the registry is empty), so the host
   *  can load that doc's parked state into the editor. Removing the active doc activates a neighbour. */
  close(id: string): string | null;
  /** Replace the ACTIVE doc's parked state (called as the user edits, so a switch-away keeps the latest edits). */
  syncActiveState(state: EditorState): void;
  /** Set the active doc's path (after a Save As) — updates its title; does NOT touch the doc content. */
  setActivePath(path: string | null): void;
  /** Set the active doc's dirty flag. */
  setActiveDirty(dirty: boolean): void;
  /** The active doc's full entry, or null if the registry is empty. */
  active(): DocEntry | null;
  /** The active doc's id, or null if empty. */
  activeId(): string | null;
  /** A read-only snapshot of every open doc, in order, for the Documents pane. */
  list(): DocView[];
  /** How many docs are open. */
  size(): number;
}

/**
 * Create an in-window document registry. Starts empty; the host seeds the first doc via `add` at boot. All state
 * here is SESSION-ONLY — never serialized, never in any doc.toJSON() (the F2/S-003 invariant above).
 */
export function createDocRegistry(mintId: () => string = () => crypto.randomUUID()): DocRegistry {
  // The open docs, in display order. `activeIdx` indexes the active one; -1 when empty.
  const entries: DocEntry[] = [];
  let activeIdx = -1;

  const indexOf = (id: string): number => entries.findIndex((e) => e.id === id);

  const add = (state: EditorState, path: string | null = null): string => {
    const id = mintId();
    entries.push({ id, state, path, dirty: false });
    activeIdx = entries.length - 1; // a new doc becomes active
    return id;
  };

  const select = (id: string): boolean => {
    const idx = indexOf(id);
    if (idx === -1 || idx === activeIdx) return false; // unknown id, or already active → no switch
    activeIdx = idx;
    return true;
  };

  const close = (id: string): string | null => {
    const idx = indexOf(id);
    if (idx === -1) return activeId(); // unknown id → no change
    entries.splice(idx, 1);
    if (entries.length === 0) {
      activeIdx = -1;
      return null;
    }
    // Re-point activeIdx. If we removed the active doc, activate the entry now at the same slot (its right
    // neighbour shifted left) clamped to the last index; if we removed a doc BEFORE the active one, the active
    // index shifts left by one to keep pointing at the SAME doc.
    if (idx === activeIdx) activeIdx = Math.min(idx, entries.length - 1);
    else if (idx < activeIdx) activeIdx -= 1;
    return entries[activeIdx].id;
  };

  const active = (): DocEntry | null => (activeIdx === -1 ? null : entries[activeIdx]);
  const activeId = (): string | null => (activeIdx === -1 ? null : entries[activeIdx].id);

  const syncActiveState = (state: EditorState): void => {
    const a = active();
    if (a) a.state = state;
  };
  const setActivePath = (path: string | null): void => {
    const a = active();
    if (a) a.path = path;
  };
  const setActiveDirty = (dirty: boolean): void => {
    const a = active();
    if (a) a.dirty = dirty;
  };

  const list = (): DocView[] =>
    entries.map((e, i) => ({
      id: e.id,
      path: e.path,
      dirty: e.dirty,
      title: titleOf(e.path),
      active: i === activeIdx,
    }));

  return {
    add,
    select,
    close,
    syncActiveState,
    setActivePath,
    setActiveDirty,
    active,
    activeId,
    list,
    size: () => entries.length,
  };
}
