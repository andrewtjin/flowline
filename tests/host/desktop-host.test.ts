// desktop-host.test.ts — proves DesktopHost is a faithful 1:1 adapter over window.flowline (EditorHost refactor §S2).
//
// DesktopHost has no logic of its own beyond forwarding to the bridge, so the test surface is exactly: "does each
// host method call the right bridge method with the right args, and return what the bridge returned?" plus the two
// documented seams that are MORE than a pass-through:
//   1. exportDocx drops the web-only `suggestedName` (desktop prompts via MAIN).
//   2. getSelfRef maps the bridge's -1 "unresolved" sentinel to the host contract's null.
// The bridge is a full vi.fn() mock — no Electron, no DOM — so this is a pure, fast unit test of the wiring.

import { describe, it, expect, vi } from "vitest";
import { DesktopHost } from "../../src/renderer/host/desktop-host";
import type { FlowlineBridge, DocState, OpenDocEntry, MenuCommand } from "../../src/persistence/bridge";

/**
 * A complete FlowlineBridge of vi.fn() spies with benign default resolutions. `overrides` lets a single test swap one
 * method's behavior (e.g. getWinId → -1) without rebuilding the whole surface.
 */
function makeBridge(overrides: Partial<FlowlineBridge> = {}): FlowlineBridge {
  return {
    platform: "win32",
    schemaSurface: "flowline",
    onMenuCommand: vi.fn(),
    open: vi.fn(async () => ({ ok: true, docJson: { d: 1 }, path: "/opened.fl" })),
    save: vi.fn(async () => ({ ok: true, path: "/saved.fl" })),
    saveAs: vi.fn(async () => ({ ok: true, path: "/saved-as.fl" })),
    exportDocx: vi.fn(async () => ({ ok: true, path: "/out.docx" })),
    showError: vi.fn(async () => {}),
    confirmUnsaved: vi.fn(async () => "discard" as const),
    onCloseRequest: vi.fn(),
    requestClose: vi.fn(async () => {}),
    reportDocState: vi.fn(),
    onOpenDocs: vi.fn(),
    focusWindow: vi.fn(async () => {}),
    getWinId: vi.fn(async () => 7),
    requestNewWindow: vi.fn(async () => {}),
    getInitialDoc: vi.fn(async () => ({ kind: "empty" }) as const),
    onQuitGuard: vi.fn(),
    replyQuitGuard: vi.fn(),
    ...overrides,
  };
}

/** Default host: desktop, multi-window MDI. */
function makeHost(overrides: Partial<FlowlineBridge> = {}) {
  const bridge = makeBridge(overrides);
  return { bridge, host: new DesktopHost(bridge) };
}

describe("DesktopHost — platform tag", () => {
  it("reports the desktop platform", () => {
    const { host } = makeHost();
    expect(host.platform).toBe("desktop");
  });
});

describe("DesktopHost — FileHost forwards to the bridge", () => {
  it("open() → bridge.open(), returning its result verbatim", async () => {
    const { bridge, host } = makeHost();
    const result = await host.open();
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, docJson: { d: 1 }, path: "/opened.fl" });
  });

  it("save(json, path) → bridge.save(json, path)", async () => {
    const { bridge, host } = makeHost();
    const doc = { a: 1 };
    await host.save(doc, "/here.fl");
    expect(bridge.save).toHaveBeenCalledWith(doc, "/here.fl");
  });

  it("save(json) with no path → bridge.save(json, undefined) (MAIN will prompt)", async () => {
    const { bridge, host } = makeHost();
    const doc = { a: 1 };
    await host.save(doc);
    expect(bridge.save).toHaveBeenCalledWith(doc, undefined);
  });

  it("saveAs(json) → bridge.saveAs(json)", async () => {
    const { bridge, host } = makeHost();
    const doc = { a: 2 };
    await host.saveAs(doc);
    expect(bridge.saveAs).toHaveBeenCalledWith(doc);
  });

  it("exportDocx(json, name) → bridge.exportDocx(json) — the web-only suggestedName is dropped (desktop prompts)", async () => {
    const { bridge, host } = makeHost();
    const doc = { a: 3 };
    await host.exportDocx(doc, "Ignored Name.docx");
    expect(bridge.exportDocx).toHaveBeenCalledTimes(1);
    expect(bridge.exportDocx).toHaveBeenCalledWith(doc); // exactly one arg — the suggested name never reaches the bridge
  });

  it("showError(msg) → bridge.showError(msg)", async () => {
    const { bridge, host } = makeHost();
    await host.showError("boom");
    expect(bridge.showError).toHaveBeenCalledWith("boom");
  });

  it("notify() is a silent no-op (desktop relies on the native title bar)", () => {
    const { bridge, host } = makeHost();
    expect(host.notify()).toBeUndefined();
    // It touches no bridge method — nothing on the bridge is a "notify" surface.
    expect(bridge.showError).not.toHaveBeenCalled();
  });

  it("confirmUnsaved() → bridge.confirmUnsaved(), returning the user's choice", async () => {
    const { bridge, host } = makeHost();
    const choice = await host.confirmUnsaved();
    expect(bridge.confirmUnsaved).toHaveBeenCalledTimes(1);
    expect(choice).toBe("discard");
  });

  it("getInitialDoc() → bridge.getInitialDoc(), returning the pulled InitialDoc", async () => {
    const { bridge, host } = makeHost();
    const initial = await host.getInitialDoc();
    expect(bridge.getInitialDoc).toHaveBeenCalledTimes(1);
    expect(initial).toEqual({ kind: "empty" });
  });
});

describe("DesktopHost — WindowHost (MDI on, single-user) forwards to the bridge", () => {
  it("newDocument({docJson,path}) → bridge.requestNewWindow({docJson,path})", async () => {
    const { bridge, host } = makeHost();
    const payload = { docJson: { x: 1 }, path: "/p.fl" };
    await host.newDocument(payload);
    expect(bridge.requestNewWindow).toHaveBeenCalledWith(payload);
  });

  it("newDocument() with no payload → bridge.requestNewWindow(undefined) (a blank New window)", async () => {
    const { bridge, host } = makeHost();
    await host.newDocument();
    expect(bridge.requestNewWindow).toHaveBeenCalledWith(undefined);
  });

  it("closeActiveDocument() → bridge.requestClose()", async () => {
    const { bridge, host } = makeHost();
    await host.closeActiveDocument();
    expect(bridge.requestClose).toHaveBeenCalledTimes(1);
  });

  it("focusDocument(winId) → bridge.focusWindow(winId)", async () => {
    const { bridge, host } = makeHost();
    await host.focusDocument(42);
    expect(bridge.focusWindow).toHaveBeenCalledWith(42);
  });

  it("getSelfRef() → bridge.getWinId(), returning the window id", async () => {
    const { bridge, host } = makeHost();
    const ref = await host.getSelfRef();
    expect(bridge.getWinId).toHaveBeenCalledTimes(1);
    expect(ref).toBe(7);
  });

  it("getSelfRef() maps the bridge's -1 'unresolved' sentinel to null (host contract)", async () => {
    const { host } = makeHost({ getWinId: vi.fn(async () => -1) });
    expect(await host.getSelfRef()).toBeNull();
  });

  it("reportDocState(state) → bridge.reportDocState(state)", () => {
    const { bridge, host } = makeHost();
    const state: DocState = { title: "Doc", dirty: true, path: "/p.fl" };
    host.reportDocState(state);
    expect(bridge.reportDocState).toHaveBeenCalledWith(state);
  });

  it("onOpenDocsChanged(cb) → bridge.onOpenDocs(cb) (same callback registered)", () => {
    const { bridge, host } = makeHost();
    const cb = (_docs: OpenDocEntry[]): void => {};
    host.onOpenDocsChanged(cb);
    expect(bridge.onOpenDocs).toHaveBeenCalledWith(cb);
  });
});

describe("DesktopShell lifecycle forwards to the bridge", () => {
  it("onMenuCommand(cb) → bridge.onMenuCommand(cb)", () => {
    const { bridge, host } = makeHost();
    const cb = (_cmd: MenuCommand): void => {};
    host.onMenuCommand(cb);
    expect(bridge.onMenuCommand).toHaveBeenCalledWith(cb);
  });

  it("onCloseRequest(cb) → bridge.onCloseRequest(cb)", () => {
    const { bridge, host } = makeHost();
    const cb = (): void => {};
    host.onCloseRequest(cb);
    expect(bridge.onCloseRequest).toHaveBeenCalledWith(cb);
  });

  it("onQuitGuard(cb) → bridge.onQuitGuard(cb) (timing is main.ts's job; the adapter only forwards)", () => {
    const { bridge, host } = makeHost();
    const cb = (): void => {};
    host.onQuitGuard(cb);
    expect(bridge.onQuitGuard).toHaveBeenCalledWith(cb);
  });

  it("replyQuitGuard(result) → bridge.replyQuitGuard(result)", () => {
    const { bridge, host } = makeHost();
    host.replyQuitGuard("clear");
    expect(bridge.replyQuitGuard).toHaveBeenCalledWith("clear");
  });
});
