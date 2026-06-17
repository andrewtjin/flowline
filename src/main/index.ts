// main/index.ts — Electron MAIN process (node context, NO DOM).
//
// Creates the single BrowserWindow that hosts the renderer (the editor), builds the File menu, and mediates
// every privileged operation: native file dialogs, reading/writing files, the native envelope codec, and .docx
// export. Kept DOM-free on purpose — `tsconfig.node.json` compiles this without the DOM lib, so a stray
// `document`/`window` reference here fails typecheck instead of crashing at runtime. (That no-DOM rule is also
// why the schema-aware doc validation lives renderer-side in persistence/document.ts, not here.)

import { app, BrowserWindow, Menu, dialog, ipcMain } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { encodeEnvelope, decodeEnvelope, EnvelopeError } from "../persistence/envelope";
import { exportDocx } from "../persistence/docx";
import type { DocState, InitialDoc, MenuCommand, OpenDocEntry, OpenResult, SaveResult } from "../persistence/bridge";
import { decideClose, shouldPrevent } from "./close-policy";

const moduleDir = dirname(fileURLToPath(import.meta.url));

// Window registry. The multi-window shell keeps a DISPLAY-ONLY mirror of each open window keyed by its
// BrowserWindow.id: the title shown in other windows' Documents tab, its dirty marker, and its file path. The
// AUTHORITATIVE doc lives in each renderer and is never serialized to MAIN; this map is fed by each
// renderer's `reportDocState` and consumed by the open-docs broadcast. Added on
// createWindow, removed on the window's "closed".
interface WinState {
  title: string;
  dirty: boolean;
  path: string | null;
}
const windows = new Map<number, WinState>();

// Initial-doc PULL stash. When MAIN spawns a window it stashes that window's starting
// payload here keyed by BrowserWindow.id; the freshly booted renderer PULLs it via the "flowline:getInitialDoc"
// invoke as its FIRST step (request/response → race-free; a `did-finish-load` PUSH could fire before the renderer
// subscribed and drop the doc). Read-once: the entry is deleted on first read and on the window's "closed".
const pendingInitial = new Map<number, InitialDoc>();

// Tracks whether ANY window has been created yet. The FIRST-ever window boots the seed (the DEV-gated stand-in
// intro doc) — but ONLY in DEV so the prod bundle stays seed-free; every spawned window after it is
// blank/empty (or a file when Open-spawned). Once flipped it never resets — there is exactly one "first" window
// per app run.
let firstWindowCreated = false;

// `mainWindow` is retained ONLY as a window-less fallback for dialogs/menu relay (e.g. before any window exists or
// after the focused one is gone). Per-window logic must NOT depend on it — it points at the LAST-created window, so
// using it for close/save routing would leak to the wrong window. It tracks the most recent window
// and is cleared when that exact window closes.
let mainWindow: BrowserWindow | null = null;

// Unsaved-work close guard, PER-WINDOW. A window-close attempt is intercepted (preventDefault)
// so the renderer can run its dirty-guard first. When the renderer decides it is safe to close it calls
// "flowline:requestClose", which adds the SENDER window's id to this Set and re-issues that window's close(); the
// close handler then sees the id present and lets the close proceed (no loop). A Set keyed by winId — never a
// module boolean — so one window's clearance never affects another. Cleared on the window's "closed".
const allowClose = new Set<number>();

// Quit intent. A real quit (Cmd-Q / File>Quit / app.quit()) sets this via "before-quit"; the requestClose IPC
// then quits the APP instead of merely closing the window, so the quit gesture actually exits rather than being
// downgraded to a window.close() that leaves the app (and its menu) alive. Cleared implicitly — once a quit is
// underway the process is exiting.
let isQuitting = false;

// Re-entrancy latch for the SEQUENTIAL quit orchestration. A real quit gesture fires
// `before-quit`; we preventDefault it, set this latch, and walk every window's unsaved-guard ONE AT A TIME. The
// latch stops a second before-quit (which `app.quit()` itself fires at the end of the sequence) from re-entering
// the walk. On a CANCELLED quit it is reset (along with isQuitting) so a later lone window-close is a close, not
// a quit.
let quitInProgress = false;

// Whether the application menu has been built at least once (set by buildMenu via app.whenReady). The open-docs
// broadcast rebuilds the menu to keep the Window menu's window list live, but must NOT do so before the first
// buildMenu (the very first createWindow broadcasts during whenReady, before buildMenu runs).
let menuBuilt = false;

// broadcastOpenDocs — push the full live open-windows list to EVERY window's Documents tab.
// Built from the display-only registry; `winId` lets a clicked entry focus that window. Called on
// every registry mutation: a window create, a window "closed", and a renderer's reportDocState. Sending to every
// window (not just the focused one) keeps every Documents tab consistent without the renderer polling.
function broadcastOpenDocs(): void {
  const list: OpenDocEntry[] = [];
  for (const [winId, state] of windows) {
    list.push({ winId, title: state.title, dirty: state.dirty });
  }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("flowline:openDocs", list);
  }
  // Keep the Window menu's dynamic open-windows list coherent: it is built from the same registry, so rebuild
  // the application menu on every registry mutation (create / closed / reportDocState). buildMenu only re-runs after
  // the menu exists at startup — guard so the very first broadcast (during the first createWindow, before
  // buildMenu) doesn't double-build; app.whenReady calls buildMenu explicitly right after.
  if (menuBuilt) buildMenu();
}

// createWindow — build a BrowserWindow and stash its initial-doc payload for the PULL contract. `opts.kind`:
//   - "seed"  → the renderer boots createSeedDoc() (DEV-gated). Only the FIRST window in DEV.
//   - "empty" → the renderer boots a blank newDoc(). New-spawned windows + the first window in prod.
//   - "file"  → an Open-spawned window: the renderer decodes docJson + remembers path.
// When called with no opts MAIN picks seed-vs-empty for the first/subsequent window (the app-start + New paths);
// an explicit kind is used when Open hands a decoded doc to a freshly spawned window.
function createWindow(opts?: {
  kind: "seed" | "empty" | "file";
  docJson?: unknown;
  path?: string;
}): void {
  const win = new BrowserWindow({
    width: 1180,
    height: 860,
    show: false,
    backgroundColor: "#f6f7f9",
    webPreferences: {
      preload: join(moduleDir, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow = win;

  // Resolve this window's initial-doc payload and STASH it for the PULL contract. The
  // renderer reads it exactly once via "flowline:getInitialDoc" as its first boot step. If no explicit kind was
  // passed (the app-start / New paths), the FIRST-ever window is the seed (DEV only — the prod bundle stays
  // seed-free) and every later window is blank.
  let payload: InitialDoc;
  if (opts?.kind === "file") {
    payload = { kind: "file", docJson: opts.docJson, path: opts.path ?? "" };
  } else if (opts?.kind === "empty") {
    payload = { kind: "empty" };
  } else if (!firstWindowCreated && import.meta.env.DEV) {
    payload = { kind: "seed" };
  } else {
    payload = { kind: "empty" };
  }
  firstWindowCreated = true;
  pendingInitial.set(win.id, payload);

  // Register this window in the display-only registry. Seeded with placeholder state; the renderer overwrites
  // it via `reportDocState` once it knows its real title/dirty/path. The open-docs broadcast fires here so a
  // newly-created window appears in every window's Documents list immediately (before its first report).
  windows.set(win.id, { title: "Untitled", dirty: false, path: null });
  broadcastOpenDocs();

  // Unsaved-work guard, PER-WINDOW: intercept the FIRST close attempt so the renderer can
  // prompt about unsaved work. Unless THIS window has already been cleared (its id is in allowClose, set by
  // "flowline:requestClose"), cancel the close and ask the renderer to handle it. The renderer runs its dirty-guard,
  // then calls requestClose → allowClose.add(win.id) → win.close() → this handler sees the id and lets the window
  // close. No close loop. shouldPrevent encapsulates the per-window predicate so it is the same logic the unit tests
  // prove.
  win.on("close", (e) => {
    if (shouldPrevent(win.id, allowClose)) {
      e.preventDefault();
      win.webContents.send("flowline:close-request");
    }
  });

  win.on("closed", () => {
    // Drop this window from the registry, its per-window close clearance, and any unread initial-doc stash, then
    // rebroadcast the open-docs list so every remaining window's Documents tab drops the closed entry.
    windows.delete(win.id);
    allowClose.delete(win.id);
    pendingInitial.delete(win.id);
    if (mainWindow === win) mainWindow = null;
    broadcastOpenDocs();
  });

  // Avoid a white flash: show only once the renderer has painted.
  win.once("ready-to-show", () => win.show());

  // electron-vite injects ELECTRON_RENDERER_URL in dev (the Vite renderer server); in a packaged
  // build there is no server, so load the built HTML from `out/renderer`.
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(moduleDir, "../renderer/index.html"));
}

// ── File menu ────────────────────────────────────────────────────────────────────────────────────
// Menu accelerators are app-global, so they fire even while the editor has focus; none collide with the
// editor's own binds (Mod-h/u/b/8, Mod-Enter, Alt-Arrows, Enter, Backspace, F4–F12). Each click just relays a
// command to the renderer, which gathers/sets the doc and calls back through the preload bridge. NO Edit menu:
// undo/redo are owned by the editor's ProseMirror history keymap, and a menu role would shadow those accelerators.
function sendMenu(cmd: MenuCommand): void {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  win?.webContents.send("flowline:menu", cmd);
}

// Per-platform redo accelerator(s). PM's history keymap binds BOTH Shift-Mod-Z and Mod-Y to redo; on Windows/Linux
// the conventional redo is Ctrl+Y, so the Edit menu exposes a SECOND redo item there. macOS uses only Shift-Cmd-Z.
const isMac = process.platform === "darwin";

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        { label: "New", accelerator: "CmdOrCtrl+N", click: () => sendMenu("new") },
        { label: "Open…", accelerator: "CmdOrCtrl+O", click: () => sendMenu("open") },
        { type: "separator" },
        { label: "Save", accelerator: "CmdOrCtrl+S", click: () => sendMenu("save") },
        { label: "Save As…", accelerator: "CmdOrCtrl+Shift+S", click: () => sendMenu("saveAs") },
        { type: "separator" },
        { label: "Export to Word…", accelerator: "CmdOrCtrl+Shift+E", click: () => sendMenu("export") },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      // Edit menu. Undo/Redo are CLICK affordances only: `registerAccelerator:false` means the menu
      // displays the shortcut but does NOT register it, so the editor's ProseMirror history keymap stays the SINGLE
      // keyboard owner of undo/redo (zero double-fire, no shadowing of PM's bespoke history commands). The click
      // relays edit:undo / edit:redo to the FOCUSED renderer (sendMenu), which runs undo/redo against its own view.
      // Cut/Copy/Paste are NATIVE roles: these DO register Cmd+X/C/V, which is fine — they fire DOM clipboard events
      // the existing pasteGuard already handles. "PM is the single keyboard owner" is scoped to undo/redo only.
      label: "Edit",
      submenu: [
        {
          label: "Undo",
          accelerator: "CmdOrCtrl+Z",
          registerAccelerator: false,
          click: () => sendMenu("edit:undo"),
        },
        {
          label: "Redo",
          accelerator: "Shift+CmdOrCtrl+Z",
          registerAccelerator: false,
          click: () => sendMenu("edit:redo"),
        },
        // Win/Linux conventional redo (Ctrl+Y) — a second redo affordance; macOS omits it. Also a display-only item.
        ...(isMac
          ? []
          : [
              {
                label: "Redo",
                accelerator: "CmdOrCtrl+Y",
                registerAccelerator: false,
                click: () => sendMenu("edit:redo"),
              } as MenuItemConstructorOptions,
            ]),
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
      ],
    },
    {
      // View menu: toggle the sidebar and switch its active tab. Each relays to the focused renderer, which drives
      // the sidebar component (toggle / setTab + setVisible). No accelerators — these don't collide with PM's binds.
      label: "View",
      submenu: [
        { label: "Toggle Sidebar", click: () => sendMenu("view:toggleSidebar") },
        { type: "separator" },
        { label: "Documents", click: () => sendMenu("view:tabDocuments") },
        { label: "Outline", click: () => sendMenu("view:tabOutline") },
      ],
    },
    {
      // Window menu: Minimize (native role), Close (routes to the SENDER window's guarded close via the renderer →
      // requestClose), then a live list of the open windows. Each window entry focuses that window on click — built
      // from the display-only registry so the labels match the Documents tab. Built fresh on every buildMenu call;
      // the registry mutates as windows open/close, and rebuildMenu re-runs this on each registry change.
      label: "Window",
      submenu: [
        { role: "minimize" },
        // Close routes to the SENDER window's guarded close (renderer → requestGuardedClose → requestClose). Unlike
        // Edit's undo/redo, Close REGISTERS its accelerator: ProseMirror binds nothing to Mod-W, so there is no key to
        // shadow, and a debater expects Ctrl/Cmd+W to actually close the window — the same guarded path as the click.
        { label: "Close", accelerator: "CmdOrCtrl+W", click: () => sendMenu("window:close") },
        { type: "separator" },
        ...[...windows.entries()].map(
          ([winId, state]): MenuItemConstructorOptions => ({
            label: state.title,
            click: () => {
              const win = BrowserWindow.fromId(winId);
              win?.show();
              win?.focus();
            },
          }),
        ),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  menuBuilt = true;
}

// ── IPC handlers (the privileged operations) ───────────────────────────────────────────────────────
const FL_FILTER = [{ name: "Flowline Document", extensions: ["fl"] }];
const DOCX_FILTER = [{ name: "Word Document", extensions: ["docx"] }];

// Sender-resolution invariant. EVERY renderer-originated privileged op resolves its acting window
// from the IPC SENDER's webContents — captured ONCE at gesture start and carried through the whole async op — NOT
// from BrowserWindow.getFocusedWindow(), which re-samples focus mid-async and leaks dialogs to the wrong window.
// mainWindow is only a window-less fallback. getFocusedWindow() survives ONLY in sendMenu (menu relay).
function senderWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
}

/** Encode + write `docJson` to `path` (or prompt when `path` is null), parenting the dialog to the acting window. */
async function doSave(
  event: Electron.IpcMainInvokeEvent,
  docJson: unknown,
  path: string | null,
): Promise<SaveResult> {
  let target = path;
  if (!target) {
    const win = senderWindow(event);
    if (!win) return { ok: false, message: "No active window." };
    const res = await dialog.showSaveDialog(win, { defaultPath: "speech.fl", filters: FL_FILTER });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    target = res.filePath;
  }
  try {
    await writeFile(target, encodeEnvelope(docJson));
    return { ok: true, path: target };
  } catch {
    return { ok: false, message: "Could not save the file." };
  }
}

function registerIpc(): void {
  // Open: show the dialog, read + FRAME-decode the file. The renderer validates the returned docJson as a doc
  // (document.ts) and replaces the live doc through the seam; on any error it asks us to show the dialog and
  // leaves its current doc untouched. We return data only — never raw bytes — across IPC.
  ipcMain.handle("flowline:open", async (event): Promise<OpenResult> => {
    const win = senderWindow(event);
    if (!win) return { ok: false, message: "No active window." };
    const res = await dialog.showOpenDialog(win, { filters: FL_FILTER, properties: ["openFile"] });
    if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true };
    const path = res.filePaths[0];
    try {
      const bytes = await readFile(path); // Buffer (a Uint8Array) — decode is Buffer-agnostic regardless
      const { docJson } = decodeEnvelope(bytes);
      return { ok: true, docJson, path };
    } catch (err) {
      const message = err instanceof EnvelopeError ? err.message : "Could not open the file (it may be unreadable).";
      return { ok: false, message };
    }
  });

  ipcMain.handle("flowline:save", (event, docJson: unknown, path: unknown): Promise<SaveResult> =>
    doSave(event, docJson, typeof path === "string" ? path : null),
  );
  ipcMain.handle("flowline:saveAs", (event, docJson: unknown): Promise<SaveResult> => doSave(event, docJson, null));

  // Export to Word: prompt for a .docx path, build the buffer (await the async Packer), write it.
  ipcMain.handle("flowline:exportDocx", async (event, docJson: unknown): Promise<SaveResult> => {
    const win = senderWindow(event);
    if (!win) return { ok: false, message: "No active window." };
    const res = await dialog.showSaveDialog(win, { defaultPath: "speech.docx", filters: DOCX_FILTER });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try {
      const buffer = await exportDocx(docJson);
      await writeFile(res.filePath, buffer);
      return { ok: true, path: res.filePath };
    } catch {
      return { ok: false, message: "Could not export to Word." };
    }
  });

  // Show a native error dialog on the renderer's behalf (open/validation/save/export failures).
  ipcMain.handle("flowline:showError", async (event, message: unknown): Promise<void> => {
    const text = typeof message === "string" ? message : "An error occurred.";
    const win = senderWindow(event);
    if (win) await dialog.showMessageBox(win, { type: "error", title: "Flowline", message: text });
    else dialog.showErrorBox("Flowline", text); // window-less fallback
  });

  // Unsaved-work dialog. The renderer calls this from its dirty-guard (before New / Open / a close attempt)
  // and acts on the choice: "save" → save then continue, "discard" → continue, "cancel" → abort. Buttons are
  // explicit (no role links) and the indices are fixed: 0=Save, 1=Don't Save, 2=Cancel (also Esc / window-X).
  ipcMain.handle("flowline:confirmUnsaved", async (event): Promise<"save" | "discard" | "cancel"> => {
    const win = senderWindow(event);
    const opts = {
      type: "warning" as const,
      title: "Flowline",
      message: "You have unsaved changes.",
      detail: "Do you want to save your changes before continuing?",
      buttons: ["Save", "Don't Save", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    };
    const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    return res.response === 0 ? "save" : res.response === 1 ? "discard" : "cancel";
  });

  // The renderer has handled any unsaved work for ITS window and it is safe to close. Route the decision
  // through the PURE close-policy using the SENDER window's id (the acting
  // window is the IPC sender, never a re-sampled focused/mainWindow):
  //   - "close": mark THAT window cleared and close THAT window (per-window close handler then lets it through).
  //   - "quit": a quit is underway — defer to the app-level sequential quit orchestration. A normal
  //             requestClose NEVER calls app.quit() itself; only decideClose returning "quit" routes here, and that
  //             only happens once isQuitting is set by the quit gesture.
  //   - "noop": the sender was already cleared; nothing to do.
  ipcMain.handle("flowline:requestClose", (event) => {
    const senderWin = senderWindow(event);
    if (!senderWin) return;
    const d = decideClose(senderWin.id, allowClose, isQuitting);
    if (d.action === "close") {
      allowClose.add(d.winId);
      BrowserWindow.fromId(d.winId)?.close();
    } else if (d.action === "quit") {
      app.quit();
    }
  });

  // ── Multi-window shell ─────────────────────────────────────────────────────────────────────────────
  // Initial-doc PULL. The freshly booted renderer invokes this as its FIRST step to learn
  // its starting doc. Read-once: delete the stash so a reload (which would re-run boot) falls back to "empty"
  // rather than re-seeding/re-loading the same file. A window with no stash (should not happen) defaults to empty.
  ipcMain.handle("flowline:getInitialDoc", (event): InitialDoc => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { kind: "empty" };
    const payload = pendingInitial.get(win.id) ?? { kind: "empty" };
    pendingInitial.delete(win.id);
    return payload;
  });

  // Spawn a new window on the renderer's request (renderer-decides reuse). With a payload → an
  // Open-spawned window MAIN pre-loads the decoded doc + path into; with no payload → a blank New window. The
  // renderer only calls this when its OWN window is NOT reusable (so MAIN never has to test doc-emptiness).
  ipcMain.handle("flowline:requestNewWindow", (_event, payload: { docJson: unknown; path: string } | null) => {
    if (payload) createWindow({ kind: "file", docJson: payload.docJson, path: payload.path });
    else createWindow({ kind: "empty" });
  });

  // A renderer reports its current doc-state (title/dirty/path) — fire-and-forget `send`, deduped renderer-side so
  // it only fires on a real tuple change. Update the display-only registry mirror and rebroadcast the open-docs
  // list so every Documents tab reflects the new title/dirty. The authoritative doc stays in the renderer.
  ipcMain.on("flowline:reportDocState", (event, state: DocState) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    windows.set(win.id, {
      title: state.title,
      dirty: state.dirty,
      path: state.path,
    });
    broadcastOpenDocs();
  });

  // Bring a sibling window to the front (Documents-tab click → focus that doc's window). show() un-minimizes and
  // surfaces it; focus() gives it keyboard focus. No-op if the id is stale (the window closed between broadcast
  // and click).
  ipcMain.handle("flowline:focusWindow", (_event, winId: number) => {
    const win = BrowserWindow.fromId(winId);
    win?.show();
    win?.focus();
  });

  // Resolve the SENDER window's own BrowserWindow id. The renderer marks the matching Documents-tab row as
  // "this doc"; the open-docs broadcast is identical for every window, so a window needs its own id to find itself.
  ipcMain.handle("flowline:getWinId", (event): number => BrowserWindow.fromWebContents(event.sender)?.id ?? -1);
}

// runQuitSequence — the MAIN-orchestrated SEQUENTIAL multi-window quit. On a real quit
// gesture `before-quit` preventDefaults and calls this. We walk the registry ONE WINDOW AT A TIME: show+focus the
// window, send it "flowline:quitGuard", and AWAIT a single round-trip reply ("clear" | "cancel") on
// ipcMain.once("flowline:quitGuardReply"). A "cancel" ABORTS the whole quit and RESETS the latches so a later
// lone window-close is a close, not a quit. When EVERY window replies "clear", mark them all allowClose and
// app.quit() (this time before-quit is latched, so it does not re-enter). Sequential — not parallel — so the user
// faces one native dialog at a time, never N racing modals.
async function runQuitSequence(): Promise<void> {
  // Snapshot the window ids up front; the registry may mutate as windows close, but we guard each id's liveness.
  const ids = [...windows.keys()];
  for (const id of ids) {
    const win = BrowserWindow.fromId(id);
    if (!win || win.isDestroyed()) continue; // closed between snapshot and now → nothing to guard
    const wc = win.webContents;
    // Readiness guard against a quit-during-boot wedge. A window whose renderer has NOT finished loading (still
    // mid-boot) or has crashed cannot reply to quitGuard — and a still-booting window provably has no unsaved user
    // edits (dirty is only set on an edit, which needs the built view), while a crashed renderer could not save
    // them anyway. Treat both as "clear" instead of AWAITING a reply that will never arrive — that await has no
    // timeout, and before-quit is already preventDefaulted + latched, so a missing reply would wedge the app with
    // force-kill the only escape. The renderer registers its quitGuard listener SYNCHRONOUSLY, before its boot
    // await, so a loaded-and-not-crashed renderer is guaranteed to be listening and will reply.
    if (wc.isCrashed() || wc.isLoading()) continue;
    // Show+focus ONLY a window we believe holds unsaved work, so its native dialog is surfaced on the right
    // window. Clean windows reply "clear" instantly with no dialog, so focusing them would only make focus jump
    // across every window on quit. `dirty` is the display-only mirror; the renderer stays the authoritative arbiter
    // (it still receives quitGuard and will prompt if it is in fact dirty — its dialog is parented to its window).
    if (windows.get(id)?.dirty) {
      win.show();
      win.focus();
    }
    // Await exactly one reply for THIS window before moving on (sequential). The renderer runs its unsaved-guard
    // and replies "clear" (saved/discarded/clean) or "cancel" (the user backed out).
    const reply = await new Promise<"clear" | "cancel">((resolve) => {
      ipcMain.once("flowline:quitGuardReply", (_event, value: "clear" | "cancel") => resolve(value));
      wc.send("flowline:quitGuard");
    });
    if (reply === "cancel") {
      // The user cancelled this window's guard → abort the quit and reset the latches so the app stays alive and a
      // subsequent single window-close is treated as a close (not a quit).
      quitInProgress = false;
      isQuitting = false;
      return;
    }
  }
  // Every window cleared: allow each to close without re-prompting, then quit. (before-quit is latched by
  // quitInProgress so app.quit() does not re-run this sequence.)
  for (const id of windows.keys()) allowClose.add(id);
  app.quit();
}

app.whenReady().then(() => {
  registerIpc();
  buildMenu();
  createWindow();
  // macOS: re-create a window when the dock icon is clicked and none are open.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// A real quit gesture (Cmd-Q, File>Quit, app.quit()) fires before-quit FIRST. We INTERCEPT it (preventDefault)
// and run the SEQUENTIAL unsaved-guard across every window rather than letting N
// renderers race N modal dialogs. The quitInProgress latch lets runQuitSequence's own final app.quit() pass
// through (it re-enters before-quit, but the latch returns early so the sequence isn't re-run). On a cancelled
// quit runQuitSequence resets both latches so the app stays alive and a later lone close is a close, not a quit.
app.on("before-quit", (e) => {
  if (quitInProgress) return; // the post-sequence app.quit() — let it proceed (every window already cleared)
  e.preventDefault();
  quitInProgress = true;
  isQuitting = true;
  void runQuitSequence();
});

// Quit when all windows are closed, except on macOS where apps stay alive until Cmd-Q. This is coherent with the
// sequential quit: when the LAST window closes there are no windows left to guard, so app.quit() → before-quit →
// runQuitSequence walks an empty registry and quits immediately (no spurious dialog).
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
