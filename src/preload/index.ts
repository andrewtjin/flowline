// preload/index.ts — the contextBridge between the isolated renderer and the main process.
//
// Runs with contextIsolation on. Exposes ONLY plain serialisable values + thin function wrappers — no node
// primitives leak to the page. Every privileged operation (file dialogs, fs, the application menu) is mediated
// by the main process; this bridge just forwards requests (ipcRenderer.invoke) and relays menu commands
// (ipcRenderer.on). The typed contract is `FlowlineBridge` (../persistence/bridge).

import { contextBridge, ipcRenderer } from "electron";
import type {
  DocState,
  FlowlineBridge,
  InitialDoc,
  MenuCommand,
  OpenDocEntry,
  OpenResult,
  SaveResult,
  UnsavedChoice,
} from "../persistence/bridge";

const api: FlowlineBridge = {
  platform: process.platform,
  // Marker that the renderer talks to the StructureHost predicate surface, not node-name strings.
  schemaSurface: "predicates-only",

  onMenuCommand: (cb) => {
    // One subscription for the lifetime of the renderer; main sends ("flowline:menu", cmd) on a File-menu click.
    ipcRenderer.on("flowline:menu", (_event, cmd: MenuCommand) => cb(cmd));
  },

  open: () => ipcRenderer.invoke("flowline:open") as Promise<OpenResult>,
  save: (docJson, path) => ipcRenderer.invoke("flowline:save", docJson, path ?? null) as Promise<SaveResult>,
  saveAs: (docJson) => ipcRenderer.invoke("flowline:saveAs", docJson) as Promise<SaveResult>,
  exportDocx: (docJson) => ipcRenderer.invoke("flowline:exportDocx", docJson) as Promise<SaveResult>,
  showError: (message) => ipcRenderer.invoke("flowline:showError", message) as Promise<void>,

  // Unsaved-work guard. confirmUnsaved asks MAIN to show the native Save/Don't Save/Cancel dialog. MAIN
  // intercepts a window-close attempt and emits "flowline:close-request"; the renderer runs its dirty-guard and,
  // when safe, calls requestClose so MAIN can actually close the window (one subscription for the renderer's life).
  confirmUnsaved: () => ipcRenderer.invoke("flowline:confirmUnsaved") as Promise<UnsavedChoice>,
  onCloseRequest: (cb) => {
    ipcRenderer.on("flowline:close-request", () => cb());
  },
  requestClose: () => ipcRenderer.invoke("flowline:requestClose") as Promise<void>,

  // Multi-window shell. The renderer reports its doc-state (fire-and-forget send), subscribes to MAIN's
  // live open-docs broadcast, focuses a sibling window, asks MAIN to spawn a window (empty or pre-loaded),
  // and PULLs its initial doc on boot. MAIN need not yet handle these channels for the contract to typecheck.
  reportDocState: (state: DocState) => {
    ipcRenderer.send("flowline:reportDocState", state);
  },
  onOpenDocs: (cb) => {
    // One subscription for the renderer's life; MAIN sends the full list on every registry mutation.
    ipcRenderer.on("flowline:openDocs", (_event, docs: OpenDocEntry[]) => cb(docs));
  },
  focusWindow: (winId) => ipcRenderer.invoke("flowline:focusWindow", winId) as Promise<void>,
  // This window's own BrowserWindow id, so the renderer can mark "this doc" in the Documents tab.
  getWinId: () => ipcRenderer.invoke("flowline:getWinId") as Promise<number>,
  requestNewWindow: (payload) =>
    ipcRenderer.invoke("flowline:requestNewWindow", payload ?? null) as Promise<void>,
  getInitialDoc: () => ipcRenderer.invoke("flowline:getInitialDoc") as Promise<InitialDoc>,

  // Sequential quit guard. MAIN sends "flowline:quitGuard" to one window at a time during a Quit; the
  // renderer runs its dirty-guard and answers with "flowline:quitGuardReply". One subscription for the renderer's
  // life (MAIN may guard this window once per quit attempt).
  onQuitGuard: (cb) => {
    ipcRenderer.on("flowline:quitGuard", () => cb());
  },
  replyQuitGuard: (result) => {
    ipcRenderer.send("flowline:quitGuardReply", result);
  },
};

contextBridge.exposeInMainWorld("flowline", api);
