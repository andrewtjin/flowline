// renderer/close-guard.ts — the PURE web close-guard decision (E10b-S5/S6).
//
// On the WEB build there is no Electron MAIN to show a native "you have unsaved changes" dialog, and closing an
// in-window doc (the x on a Documents row, or Window > Close) must NOT silently drop unsaved edits. This module is
// the small, pure decision at the heart of that flow: given whether the doc is dirty, decide whether a prompt is
// needed at all (a clean doc closes immediately — S5's "clean closes with no prompt"), and given the user's answer
// to the prompt, decide whether to proceed with the close. Keeping it pure (no DOM, no window) makes the highest-
// blast-radius branch — "did we just lose the user's work?" — exhaustively testable, exactly like the desktop
// close-policy.ts. The DOM prompt + the actual doc-removal live in the registry/main wiring; this only decides.
//
// The web prompt offers the SAME three choices as the desktop native dialog (UnsavedChoice in persistence/bridge):
// save / discard / cancel — so S5 (the x) and S6 (Window > Close) share ONE decision, never two divergent flows.

import type { UnsavedChoice } from "../persistence/bridge";

/** Does closing this doc require the unsaved-changes prompt? Clean ⇒ no prompt (close immediately); dirty ⇒ prompt. */
export function needsClosePrompt(dirty: boolean): boolean {
  return dirty;
}

/**
 * Resolve a close attempt given the user's answer to the unsaved-changes prompt AND whether a "save" actually
 * succeeded (cleared the dirty flag). Returns:
 *   - "close"  — proceed with the close (the doc was clean/discarded, or a save succeeded);
 *   - "abort"  — leave the doc open (the user cancelled, or a "save" was itself cancelled / failed and left work).
 *
 * `choice` is undefined when no prompt was shown (a clean doc): proceed. When a prompt WAS shown:
 *   - cancel  → abort (keep the doc);
 *   - discard → close (drop the edits, as the user asked);
 *   - save    → close ONLY if `saveSucceeded` (a cancelled Save / write error must NOT silently lose the work).
 * This mirrors the desktop `guardUnsaved` semantics in renderer/main.ts so web and desktop behave identically.
 */
export function resolveClose(choice: UnsavedChoice | undefined, saveSucceeded: boolean): "close" | "abort" {
  if (choice === undefined) return "close"; // no prompt was needed (clean doc)
  if (choice === "cancel") return "abort";
  if (choice === "discard") return "close";
  // choice === "save": proceed only if the save actually cleared the dirty flag.
  return saveSucceeded ? "close" : "abort";
}
