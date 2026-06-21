// resolve-host.test.ts — proves the ONE boot-time platform selection (§S4/§5).
//
// resolveHost collapses the old `isWeb` tangle to a single predicate (bridge present?) and returns the §R4
// ResolvedHost shape. The contract under test is exactly two things:
//   • bridge present  → a DesktopHost, handed out as BOTH `host` (EditorHost) and `shell` (DesktopShell) — the SAME
//     instance (so there is no second object to keep in sync), platform "desktop".
//   • bridge absent   → a WebHost, `shell: null` (web has no DesktopShell), platform "web".
// The host impls' own behavior is covered by desktop-host/web-host suites; here we only assert SELECTION + forwarding.
// Node env (no jsdom): resolveHost is pure and both ctors are headless (no DOM until interaction).

import { describe, it, expect, vi } from "vitest";
import { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../../src/schema";
import type { DocEntry } from "../../src/renderer/doc-registry";
import type { FlowlineBridge } from "../../src/persistence/bridge";
import type { WebHostDeps } from "../../src/renderer/host/web-host";
import { resolveHost } from "../../src/renderer/host/resolve-host";
import { DesktopHost } from "../../src/renderer/host/desktop-host";
import { WebHost } from "../../src/renderer/host/web-host";

/** A minimal valid doc (one empty paragraph with a blockId) — its JSON round-trips through docFromJson (newDocument). */
function mkDoc(blockId: string): PMNode {
  return schema.nodes.doc.create(null, [schema.nodes.paragraph.create({ blockId })]);
}

/** The web deps — faithful enough to construct + drive a WebHost. */
function webDeps(): WebHostDeps {
  const liveView = { state: EditorState.create({ schema, doc: mkDoc("live") }), focus: vi.fn() } as unknown as EditorView;
  let n = 0;
  return {
    initialDoc: mkDoc("seed"),
    initialDocKind: "seed",
    makeEmptyDoc: () => mkDoc("empty"),
    getView: () => liveView,
    getCurrentPath: () => null,
    getDirty: () => false,
    loadActiveEntry: vi.fn((_entry: DocEntry) => {}),
    guardUnsaved: vi.fn(async () => true),
    dispatch: vi.fn(),
    sidebar: { setWebDocs: vi.fn(), setTab: vi.fn() },
    mountMenuBar: vi.fn(),
    createModal: vi.fn(),
    mintId: () => `id${++n}`,
  };
}

/** A fake preload bridge: DesktopHost forwards to it and touches nothing at construction, so only the methods a test
 *  exercises need a stub. Returns the spy alongside so a test can assert the forward without an `any` cast. */
function fakeBridge() {
  const requestNewWindow = vi.fn(async () => {});
  const bridge = { requestNewWindow } as unknown as FlowlineBridge;
  return { bridge, requestNewWindow };
}

describe("resolveHost — platform selection (§S4/§5)", () => {
  it("bridge present → DesktopHost, handed out as BOTH host and shell (same instance)", () => {
    const { bridge } = fakeBridge();
    const { host, shell } = resolveHost({ bridge, deps: webDeps() });
    expect(host).toBeInstanceOf(DesktopHost);
    expect(host.platform).toBe("desktop");
    expect(shell).toBe(host); // the lone DesktopHost satisfies EditorHost AND DesktopShell — no second object
  });

  it("bridge ABSENT → WebHost, shell is null (web has no DesktopShell)", () => {
    const { host, shell } = resolveHost({ bridge: undefined, deps: webDeps() });
    expect(host).toBeInstanceOf(WebHost);
    expect(host.platform).toBe("web");
    expect(shell).toBeNull();
  });

  it("desktop windowing: newDocument forwards to MAIN's File▸New", async () => {
    const desktop = fakeBridge();
    await resolveHost({ bridge: desktop.bridge, deps: webDeps() }).host.newDocument({
      docJson: mkDoc("x").toJSON(),
      path: "x.fl",
    });
    expect(desktop.requestNewWindow).toHaveBeenCalledTimes(1); // spawns a MAIN window
  });

  it("web host MDI: newDocument adds a fresh active doc", async () => {
    const web = resolveHost({ bridge: undefined, deps: webDeps() });
    const first = await web.host.getSelfRef(); // the ctor seed (id1)
    await web.host.newDocument({ docJson: mkDoc("y").toJSON(), path: "y.fl" });
    expect(await web.host.getSelfRef()).not.toBe(first); // a fresh active doc (id2)
  });
});
