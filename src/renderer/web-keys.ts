// renderer/web-keys.ts — the PURE keyboard predicates for the web build's accelerators (E10b-S1).
//
// The web build has no Electron native-menu accelerators, so the renderer must intercept Ctrl/Cmd+S itself (and
// preventDefault so the browser's "save page" never fires). The DECISION — "is this keydown a Save / Save-As
// accelerator?" — is factored out here as a pure function on the few KeyboardEvent fields it reads, so it is unit-
// testable without a DOM and the inline handler in main.ts stays a thin wrapper (detect → preventDefault → save).

/** The fields of a keydown this predicate inspects (a structural subset of KeyboardEvent, for easy testing).
 *  `code` is the physical-key code ("KeyN") — optional so a bare test chord can omit it; the New predicate
 *  prefers it so non-US layouts (where Alt can remap the produced character) still match. */
export interface KeyChord {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly code?: string;
}

/**
 * Is this keydown the Save accelerator (Ctrl+S on Windows/Linux, ⌘+S on macOS)? Requires the Ctrl OR Meta
 * modifier, the "s"/"S" key, and NO Alt (Alt+Ctrl+S is a different chord we leave alone). Shift is allowed — it
 * distinguishes Save-As (see `isSaveAsChord`). The caller preventDefaults + runs the app save when this is true.
 */
export function isSaveChord(e: KeyChord): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "s" || e.key === "S");
}

/** Is this Save chord the Save-AS variant (adds Shift)? Only meaningful when `isSaveChord` is already true. */
export function isSaveAsChord(e: KeyChord): boolean {
  return isSaveChord(e) && e.shiftKey;
}

/**
 * Is this keydown the web New-document accelerator? **Ctrl+M** (ctrl-only, all platforms).
 *
 * WHY NOT plain Ctrl+N: browsers RESERVE Ctrl+N for "new browser window" — the keydown is not delivered cancelably
 * to a page, so `preventDefault` is ignored and a web app cannot bind it. WHY NOT Ctrl+Alt+N (the prior pick): on
 * Windows Ctrl+Alt IS AltGr, and assistive tech (e.g. NVDA) grabs Ctrl+Alt chords — so that combo is intercepted
 * UPSTREAM and never reaches the page either. Ctrl+M is unreserved, reaches the page cancelably, and collides with
 * nothing in the editor's keymap.
 *
 * It is **ctrl-ONLY, never meta**, on purpose: on macOS ⌘+M is the OS "minimize window" chord, so a meta-inclusive
 * predicate would be hijacked there (Mac users reach New via the menu / "+ New document" button). We also exclude
 * Shift (Firefox's Ctrl+Shift+M = Responsive Design Mode) and Alt (so it is unambiguously plain Ctrl+M, never an
 * AltGr press). Matches the physical KeyM code first (layout-robust), falling back to the produced key. (Desktop
 * keeps native Ctrl+N via the Electron menu — this predicate is only for the no-native-menu web build.)
 */
export function isNewChord(e: KeyChord): boolean {
  const isM = e.code === "KeyM" || e.key === "m" || e.key === "M";
  return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && isM;
}
