// @vitest-environment jsdom
// web-host.test.ts — proves WebHost faithfully encapsulates the inline web bodies it MOVED out of main.ts (§S3).
//
// Unlike DesktopHost (a 1:1 bridge adapter), WebHost OWNS state (the MDI registry + per-doc FSA handles) and drives
// DOM (toast / modal / Documents pane / accelerators). So the test surface is the BEHAVIOR of each capability:
//   • FileHost IO — open (+ the open→newDocument FSA-handle stash, observed through a follow-up save), save in-place
//     (FSA handle) vs the denied-permission Downloads fallback vs cancel, saveAs forces the dialog, export.
//   • Feedback — showError/notify render the right toast; confirmUnsaved drives the injected modal to each choice.
//   • WindowHost MDI — newDocument parks+adds+activates; focusDocument parks+switches; the guarded close removes +
//     activates the neighbour (and re-seeds a fresh doc when the last one closes).
//   • R7 — the registry is seeded in the ctor (a save before any New still has the seeded active doc).
//   • UI surface — mountUI sets the tab, paints the pane, mounts the menubar; the accelerators route Ctrl+S/Shift/M
//     through `dispatch`.
// The file IO (web-files/web-docx) is INJECTED and faked, so these tests assert WebHost's wiring without stubbing FSA
// globals; the real byte paths are covered by web-files/web-docx's own suites.

import { describe, it, expect, vi, afterEach } from "vitest";
import { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../../src/schema";
import type { DocEntry } from "../../src/renderer/doc-registry";
import type { WebOpenResult, WebSaveResult } from "../../src/renderer/web-files";
import type { WebExportResult } from "../../src/persistence/web-docx";
import { WebHost } from "../../src/renderer/host/web-host";
import type { WebHostDeps, ModalSpec } from "../../src/renderer/host/web-host";

/** A minimal valid doc (one empty paragraph with a blockId — the shape `newDoc()` produces, so docFromJson accepts
 *  its JSON). `blockId` distinguishes docs by reference in park/switch assertions. */
function mkDoc(blockId: string): PMNode {
  return schema.nodes.doc.create(null, [schema.nodes.paragraph.create({ blockId })]);
}
function mkState(doc: PMNode): EditorState {
  return EditorState.create({ schema, doc });
}
/** A deterministic registry id minter (id1, id2, …) so tests can predict/assert the active id. */
function counter(): () => string {
  let n = 0;
  return () => `id${++n}`;
}
/** A throwaway FSA handle stand-in (WebHost only stores/forwards it; it never calls handle methods directly). */
function fakeHandle(name: string): FileSystemFileHandle {
  return { name } as unknown as FileSystemFileHandle;
}
/** The opts shape webSaveFl receives — inlined so the faked impl is assignable to `typeof webSaveFl`. */
type SaveOpts = { handle?: FileSystemFileHandle | null; forceDialog?: boolean; suggestedName?: string };

/**
 * Build a WebHost over fully-faked deps. `session` mirrors main.ts's `currentPath`/`dirty`; `loadActiveEntry` adopts
 * the activated entry's path/dirty into it (as main.ts does) so a subsequent parkActive reads coherent values. The
 * injected `io` (open/save/exportDocx) returns benign successes a test can override.
 */
function makeHost(overrides: Partial<WebHostDeps> = {}) {
  const session = { currentPath: null as string | null, dirty: false };
  // The live editor view: parkActive READS `.state`; `.focus` stands in for the focus main.ts's loadActiveEntry does.
  const liveView = { state: mkState(mkDoc("live")), focus: vi.fn() } as unknown as EditorView;
  const sidebar = { setWebDocs: vi.fn(), setTab: vi.fn() };
  const io = {
    open: vi.fn(
      (): Promise<WebOpenResult> =>
        Promise.resolve({ ok: true, doc: mkDoc("opened"), name: "opened.fl", handle: fakeHandle("opened.fl") }),
    ),
    save: vi.fn(
      (_doc: PMNode, _opts: SaveOpts): Promise<WebSaveResult> =>
        Promise.resolve({ ok: true, name: "saved.fl", handle: fakeHandle("saved.fl") }),
    ),
    exportDocx: vi.fn((_docJson: unknown, _name?: string): Promise<WebExportResult> => Promise.resolve({ ok: true, name: "out.docx" })),
  };
  const deps: WebHostDeps = {
    initialDoc: mkDoc("seed"),
    initialDocKind: "seed",
    makeEmptyDoc: () => mkDoc("empty"),
    getView: () => liveView,
    getCurrentPath: () => session.currentPath,
    getDirty: () => session.dirty,
    loadActiveEntry: vi.fn((entry: DocEntry) => {
      // Faithful to main.ts's loadActiveEntry (§R8): adopt the entry's path/dirty into the session and focus the view.
      session.currentPath = entry.path;
      session.dirty = entry.dirty;
      liveView.focus();
    }),
    guardUnsaved: vi.fn(async () => true),
    dispatch: vi.fn(),
    sidebar,
    mountMenuBar: vi.fn(),
    createModal: vi.fn(),
    io: io as WebHostDeps["io"],
    mintId: counter(),
    ...overrides,
  };
  return { deps, session, liveView, sidebar, io, host: new WebHost(deps) };
}

afterEach(() => {
  document.body.innerHTML = ""; // drop any toasts/menubar DOM so a later test starts clean
  vi.restoreAllMocks();
});

describe("WebHost — platform tag + boot", () => {
  it("reports the web platform", () => {
    expect(makeHost().host.platform).toBe("web");
  });

  it("getInitialDoc() returns the injected descriptor kind (no MAIN pull)", async () => {
    expect(await makeHost().host.getInitialDoc()).toEqual({ kind: "seed" });
    expect(await makeHost({ initialDocKind: "empty" }).host.getInitialDoc()).toEqual({ kind: "empty" });
  });

  it("§R7: the registry is SEEDED in the ctor — getSelfRef resolves the seeded active id before any New", async () => {
    expect(await makeHost().host.getSelfRef()).toBe("id1"); // the ctor seed is the first (and active) entry
  });

  it("§R7: the seeded active doc has no FSA handle yet — the first save passes handle:null", async () => {
    const { host, io } = makeHost();
    await host.save(mkDoc("x").toJSON());
    expect(io.save).toHaveBeenCalledTimes(1);
    expect(io.save.mock.calls[0][1]).toMatchObject({ handle: null, forceDialog: false });
  });
});

describe("WebHost — FileHost.open", () => {
  it("ok → OpenResult{docJson,path} from the decoded file", async () => {
    const res = await makeHost().host.open();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.path).toBe("opened.fl");
  });

  it("a dismissed picker is a silent cancel (no message)", async () => {
    const { host, io } = makeHost();
    io.open.mockResolvedValueOnce({ ok: false, canceled: true });
    expect(await host.open()).toEqual({ ok: false, canceled: true });
  });

  it("a corrupt/invalid file surfaces its message (main.ts shows it)", async () => {
    const { host, io } = makeHost();
    io.open.mockResolvedValueOnce({ ok: false, message: "Could not open the file." });
    expect(await host.open()).toEqual({ ok: false, message: "Could not open the file." });
  });

  it("§S3 problem #1: open() stashes the FSA handle for the ensuing newDocument — a later save writes in place to it", async () => {
    const { host, io } = makeHost();
    const opened = fakeHandle("opened.fl");
    io.open.mockResolvedValueOnce({ ok: true, doc: mkDoc("opened"), name: "opened.fl", handle: opened });
    const res = await host.open();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await host.newDocument({ docJson: res.docJson, path: res.path }); // adopts the stashed handle
    await host.save(mkDoc("opened").toJSON()); // the active (opened) doc saves in place to the opened handle
    expect(io.save.mock.calls.at(-1)?.[1]).toMatchObject({ handle: opened });
  });
});

describe("WebHost — FileHost.save / saveAs / export", () => {
  it("save() forwards the active handle + name; on success updates the handle and notifies 'Saved <name>'", async () => {
    const { host, io, sidebar } = makeHost();
    const res = await host.save(mkDoc("x").toJSON());
    expect(res).toEqual({ ok: true, path: "saved.fl" });
    expect(io.save.mock.calls[0][1]).toMatchObject({ handle: null, forceDialog: false, suggestedName: "Untitled" });
    expect(sidebar.setWebDocs).toHaveBeenCalled(); // pane re-rendered with the new path
    expect(document.querySelector(".fl-toast.fl-toast--ok")?.textContent).toContain("Saved saved.fl");
  });

  it("a second save reuses the handle the first save returned (save-in-place, no re-prompt)", async () => {
    const { host, io } = makeHost();
    await host.save(mkDoc("x").toJSON()); // first save → handles.set(active, saved.fl handle)
    await host.save(mkDoc("x").toJSON()); // second save passes that handle back
    expect(io.save.mock.calls[1][1]).toMatchObject({ handle: { name: "saved.fl" } });
  });

  it("denied-permission Downloads fallback warns instead of 'Saved' (mutually exclusive)", async () => {
    const { host, io } = makeHost();
    io.save.mockResolvedValueOnce({ ok: true, name: "Untitled.fl", handle: null, downloadedFallback: true });
    const res = await host.save(mkDoc("x").toJSON());
    expect(res).toEqual({ ok: true, path: "Untitled.fl" });
    expect(document.querySelector(".fl-toast.fl-toast--ok")).toBeNull(); // NO "Saved" toast
    expect(document.querySelector('.fl-toast[role="alert"]')?.textContent).toContain("Downloads");
  });

  it("a cancelled save returns ok:false with no message (dirty left set; pane NOT re-rendered)", async () => {
    const { host, io, sidebar } = makeHost();
    sidebar.setWebDocs.mockClear();
    io.save.mockResolvedValueOnce({ ok: false, canceled: true });
    expect(await host.save(mkDoc("x").toJSON())).toEqual({ ok: false, canceled: true });
    expect(sidebar.setWebDocs).not.toHaveBeenCalled();
    expect(document.querySelector(".fl-toast")).toBeNull();
  });

  it("saveAs() forces the dialog", async () => {
    const { host, io } = makeHost();
    await host.saveAs(mkDoc("x").toJSON());
    expect(io.save.mock.calls[0][1]).toMatchObject({ forceDialog: true });
  });

  it("save() honours an explicit suggestedPath over the active label", async () => {
    const { host, io } = makeHost();
    await host.save(mkDoc("x").toJSON(), "Report.fl");
    expect(io.save.mock.calls[0][1]).toMatchObject({ suggestedName: "Report.fl" });
  });

  it("exportDocx() maps ok → {path} and forwards the suggested name", async () => {
    const { host, io } = makeHost();
    expect(await host.exportDocx(mkDoc("x").toJSON(), "Report.fl")).toEqual({ ok: true, path: "out.docx" });
    expect(io.exportDocx).toHaveBeenCalledWith(expect.anything(), "Report.fl");
  });

  it("exportDocx() maps a pack failure → {ok:false, message}", async () => {
    const { host, io } = makeHost();
    io.exportDocx.mockResolvedValueOnce({ ok: false, message: "Could not export to Word." });
    expect(await host.exportDocx(mkDoc("x").toJSON())).toEqual({ ok: false, message: "Could not export to Word." });
  });

  it("a malformed docJson is converted to {ok:false, message} (never thrown into the caller; the writer is not reached)", async () => {
    const { host, io } = makeHost();
    const res = await host.save({ not: "a doc" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toBeTruthy();
    expect(io.save).not.toHaveBeenCalled();
  });
});

describe("WebHost — FileHost feedback (toast + modal)", () => {
  it("showError renders a persistent alert toast", async () => {
    await makeHost().host.showError("boom");
    const toast = document.querySelector(".fl-toast");
    expect(toast?.getAttribute("role")).toBe("alert");
    expect(toast?.textContent).toContain("boom");
  });

  it("notify renders a brief status toast", () => {
    makeHost().host.notify("hi");
    expect(document.querySelector(".fl-toast.fl-toast--ok")?.getAttribute("role")).toBe("status");
  });

  it("confirmUnsaved resolves 'save' / 'discard' / 'cancel' from the injected modal", async () => {
    let spec!: ModalSpec;
    const { host } = makeHost({ createModal: (s) => (spec = s) });

    const p = host.confirmUnsaved();
    spec.onSubmit({});
    expect(await p).toBe("save");

    const p2 = host.confirmUnsaved();
    spec.extraActions![0].onClick(); // "Discard"
    expect(await p2).toBe("discard");

    const p3 = host.confirmUnsaved();
    spec.onCancel!(); // backdrop/Escape → safe default
    expect(await p3).toBe("cancel");
  });

  it("confirmUnsaved latches the FIRST answer (a later dismiss can't override a submit)", async () => {
    let spec!: ModalSpec;
    const { host } = makeHost({ createModal: (s) => (spec = s) });
    const p = host.confirmUnsaved();
    spec.onSubmit({});
    spec.onCancel!(); // ignored — already answered
    expect(await p).toBe("save");
  });
});

describe("WebHost — WindowHost MDI (new / focus / close)", () => {
  it("newDocument() parks the current doc, adds a blank one, and activates it", async () => {
    const { host, liveView, deps } = makeHost();
    await host.newDocument();
    expect(await host.getSelfRef()).toBe("id2"); // new doc active
    expect(deps.loadActiveEntry).toHaveBeenCalled(); // activated through main.ts's injected LOAD_META seam
    // Parking synced the live view's state into the (previous) seed entry: switching back yields that exact state.
    await host.focusDocument("id1");
    const arg = vi.mocked(deps.loadActiveEntry).mock.calls.at(-1)?.[0] as DocEntry;
    expect(arg.id).toBe("id1");
    expect(arg.state).toBe(liveView.state);
  });

  it("focusDocument() is a no-op when the ref is already active", async () => {
    const { host, deps } = makeHost();
    await host.focusDocument("id1"); // id1 is the active seed
    expect(deps.loadActiveEntry).not.toHaveBeenCalled();
  });

  it("closeActiveDocument() on the LAST doc re-seeds a fresh empty doc (the window never goes blank)", async () => {
    const { host, deps } = makeHost();
    await host.closeActiveDocument();
    expect(deps.guardUnsaved).toHaveBeenCalledTimes(1);
    expect(await host.getSelfRef()).toBe("id2"); // a fresh empty doc replaced the closed one
    expect(deps.loadActiveEntry).toHaveBeenCalled();
  });

  it("closeActiveDocument() activates the NEIGHBOUR when other docs remain", async () => {
    const { host } = makeHost();
    await host.newDocument(); // id2 active; id1 remains
    await host.closeActiveDocument(); // close id2 → neighbour id1 activates
    expect(await host.getSelfRef()).toBe("id1");
  });

  it("an aborted guard keeps the doc open (no close, no re-activate)", async () => {
    const { host, deps } = makeHost();
    vi.mocked(deps.guardUnsaved).mockResolvedValueOnce(false);
    await host.closeActiveDocument();
    expect(await host.getSelfRef()).toBe("id1"); // unchanged
    expect(deps.loadActiveEntry).not.toHaveBeenCalled();
  });

  it("the Documents-pane onClose closes a NON-active doc: parks the active, switches to+guards the target, then activates the close-neighbour", async () => {
    const { host, deps, sidebar } = makeHost();
    await host.newDocument(); // id2 active
    await host.newDocument(); // id3 active; id1, id2 remain
    const handlers = sidebar.setWebDocs.mock.calls.at(-1)?.[1] as { onClose: (id: string) => void };
    vi.mocked(deps.guardUnsaved).mockClear();
    handlers.onClose("id1"); // close a NON-active row (id3 is active) — fire-and-forget
    await new Promise((r) => setTimeout(r, 0)); // let the async closeDoc settle
    expect(deps.guardUnsaved).toHaveBeenCalledTimes(1); // the target's unsaved work was guarded
    expect(await host.getSelfRef()).toBe("id2"); // close(id1) returns its neighbour id2, which becomes active
  });

  it("parkActive syncs the session path AND dirty into the active entry (not just the EditorState)", async () => {
    const { host, session, deps } = makeHost();
    session.currentPath = "/work.fl";
    session.dirty = true;
    await host.newDocument(); // parks the seed (id1) with the current session path/dirty, activates id2
    await host.focusDocument("id1"); // switch back → loadActiveEntry receives id1's parked entry
    const arg = vi.mocked(deps.loadActiveEntry).mock.calls.at(-1)?.[0] as DocEntry;
    expect(arg.id).toBe("id1");
    expect(arg.path).toBe("/work.fl");
    expect(arg.dirty).toBe(true);
  });

  it("newDocument with a malformed open-spawned docJson surfaces an error and leaves the registry + handle untouched", async () => {
    const { host, deps } = makeHost();
    await host.newDocument({ docJson: { not: "a doc" }, path: "/x.fl" });
    expect(await host.getSelfRef()).toBe("id1"); // no new entry added
    expect(deps.loadActiveEntry).not.toHaveBeenCalled(); // nothing activated
    expect(document.querySelector('.fl-toast[role="alert"]')).not.toBeNull(); // the failure was surfaced
  });

  it("reportDocState mirrors path/dirty into the active entry and re-renders the pane", () => {
    const { host, sidebar } = makeHost();
    sidebar.setWebDocs.mockClear();
    host.reportDocState({ title: "Report", dirty: true, path: "/Report.fl" });
    const docs = sidebar.setWebDocs.mock.calls.at(-1)?.[0] as Array<{ active: boolean; path: string | null; dirty: boolean }>;
    const active = docs.find((d) => d.active)!;
    expect(active.path).toBe("/Report.fl");
    expect(active.dirty).toBe(true);
  });

  it("onOpenDocsChanged is an inert no-op on web (the pane is host-driven, not a MAIN broadcast)", () => {
    expect(() => makeHost().host.onOpenDocsChanged(() => {})).not.toThrow();
  });
});

describe("WebHost — UI surface (mountUI + accelerators)", () => {
  it("mountUI opens the Documents tab, paints the pane, and mounts the menubar", () => {
    const { host, sidebar, deps } = makeHost();
    host.mountUI();
    expect(sidebar.setTab).toHaveBeenCalledWith("documents");
    expect(sidebar.setWebDocs).toHaveBeenCalled();
    expect(deps.mountMenuBar).toHaveBeenCalledTimes(1);
  });

  it("the Documents '+ New' handler routes through dispatch('new')", () => {
    const { host, sidebar, deps } = makeHost();
    host.mountUI();
    const handlers = sidebar.setWebDocs.mock.calls.at(-1)?.[1] as { onNew: () => void };
    handlers.onNew();
    expect(deps.dispatch).toHaveBeenCalledWith("new");
  });

  it("Ctrl+S → dispatch('save'); Ctrl+Shift+S → dispatch('saveAs'); Ctrl+M → dispatch('new'); each preventDefault", () => {
    const { host, deps } = makeHost();
    host.mountUI();
    const press = (init: KeyboardEventInit): boolean => {
      const e = new KeyboardEvent("keydown", { ...init, cancelable: true, bubbles: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(press({ key: "s", ctrlKey: true })).toBe(true);
    expect(press({ key: "s", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(press({ key: "m", ctrlKey: true, code: "KeyM" })).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith("save");
    expect(deps.dispatch).toHaveBeenCalledWith("saveAs");
    expect(deps.dispatch).toHaveBeenCalledWith("new");
  });

  it("a non-accelerator key falls through untouched (no dispatch, not prevented)", () => {
    const { host, deps } = makeHost();
    host.mountUI();
    const e = new KeyboardEvent("keydown", { key: "a", cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });
});
