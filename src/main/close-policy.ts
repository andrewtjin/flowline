// main/close-policy.ts — the PURE close/quit decision policy for the multi-window shell.
//
// This is the highest-blast-radius logic in the app: a wrong-window close means the user loses the WRONG doc.
// So it is extracted here, electron-free and side-effect-free, to be exhaustively unit-tested
// (tests/close-policy.test.ts). The Electron wiring in main/index.ts is the only part that stays human-gated — it
// merely translates the pure decision below into BrowserWindow calls.
//
// The contract: when a renderer asks MAIN to proceed with a close it has already guarded ("flowline:requestClose"),
// MAIN consults `decideClose` with the SENDER window's id, the current `allowClose` Set, and the app-level
// `isQuitting` intent. A NORMAL requestClose closes the SENDER window only — it must NEVER itself call app.quit().
// App Quit is MAIN-orchestrated and sequential elsewhere (runQuitSequence); this module only reports that a
// quit is underway so the wiring can defer to that orchestration.

/**
 * The action MAIN should take for a `requestClose` from `senderWinId`.
 * - `"close"` (with `winId`): mark that window cleared and close it (the normal per-window close path).
 * - `"quit"`: a quit is in progress — defer to the app-level quit orchestration (do NOT close a single window here).
 * - `"noop"`: nothing to do (the sender is already cleared to close, so re-deciding would be redundant).
 */
export type CloseDecision =
  | { readonly action: "quit" }
  | { readonly action: "close"; readonly winId: number }
  | { readonly action: "noop" };

/**
 * Decide what a `requestClose` from `senderWinId` means.
 *
 * Truth table:
 * - isQuitting === true                        → { action: "quit" }   (the sequential quit orchestration owns it;
 *                                                                       a requestClose during quit never closes a
 *                                                                       lone window or calls app.quit() itself)
 * - already cleared (senderWinId ∈ allowClose) → { action: "noop" }   (idempotent: re-deciding an already-allowed
 *                                                                       close would be redundant)
 * - otherwise                                  → { action: "close", winId: senderWinId }  (close the SENDER window
 *                                                                       ONLY — never mainWindow, never app.quit())
 *
 * isQuitting is checked FIRST: during a quit cascade the sequential orchestration drives each window's guard, and a
 * requestClose reply must route back into that orchestration rather than independently closing or quitting.
 */
export function decideClose(
  senderWinId: number,
  allowClose: ReadonlySet<number>,
  isQuitting: boolean,
): CloseDecision {
  // A quit is underway: defer to the app-level sequential quit orchestration. Never close a lone window here and
  // never call app.quit() off the back of a single requestClose — that is the orchestration's job.
  if (isQuitting) return { action: "quit" };
  // Already cleared to close (the close handler will let it through): nothing left to decide.
  if (allowClose.has(senderWinId)) return { action: "noop" };
  // The normal path: close the SENDER window, and only that window.
  return { action: "close", winId: senderWinId };
}

/**
 * Should the `win.on("close")` handler INTERCEPT (preventDefault) the close for `winId`?
 *
 * True when `winId` is NOT yet in `allowClose` — i.e. the renderer has not been given a chance to run its
 * unsaved-work guard. The handler then cancels the close and asks the renderer to guard. Once the renderer clears
 * the window (adds it to `allowClose` via requestClose) and re-issues the close, this returns false and the close
 * proceeds. Per-window by construction: the Set is keyed by winId, so one window's clearance never affects another.
 */
export function shouldPrevent(winId: number, allowClose: ReadonlySet<number>): boolean {
  return !allowClose.has(winId);
}
