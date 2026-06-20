// web-files.test.ts — the WEB file save/open glue (web-files.ts). E10b-S2/S3.
//
// Proves: (1) decodeFlBytes round-trips a doc saved by the web encoder (the byte→doc validation path); (2)
// validateOpenedDoc maps a bad/typed payload to a user message instead of throwing; (3) an END-TO-END web Save →
// Open round-trip through the File System Access API (mocked with an in-memory handle) preserves the doc — i.e.
// S2's "must be byte-round-trippable by Open"; and (4) a cancelled picker is a silent cancel, a save-in-place
// handle overwrites without a prompt. The FSA picker is stubbed on `window`; jsdom provides Blob/File/URL.

import { describe, it, expect, vi, afterEach } from "vitest";
import { schema } from "../../src/schema";
import { createSeedDoc } from "../../src/seed";
import { encodeEnvelopeWeb } from "../../src/persistence/web-envelope";
import { decodeFlBytes, validateOpenedDoc, webSaveFl, webOpenFl, hasFileSystemAccess } from "../../src/renderer/web-files";

const id = (): string => crypto.randomUUID();

// An in-memory FileSystemFileHandle for the FSA mock: createWritable accumulates the written bytes; getFile returns
// a File over them. Lets a Save→Open round-trip run fully headless (no real picker, no disk).
class FakeHandle {
  bytes = new Uint8Array(0);
  constructor(public name: string) {}
  async createWritable() {
    const chunks: Uint8Array[] = [];
    return {
      write: async (data: Blob | BufferSource) => {
        // The web save path writes a Blob; read it back to bytes.
        const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data as ArrayBuffer);
        chunks.push(buf);
      },
      close: async () => {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          out.set(c, off);
          off += c.length;
        }
        this.bytes = out;
      },
    };
  }
  async getFile(): Promise<File> {
    return new File([new Uint8Array(this.bytes)], this.name);
  }
}

afterEach(() => {
  // Remove any picker stubs so suites stay isolated.
  delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker;
  vi.restoreAllMocks();
});

describe("decodeFlBytes — the web byte→doc validation path (S3)", () => {
  it("round-trips a web-encoded seed doc to a deep-equal doc", async () => {
    const doc = createSeedDoc();
    const bytes = await encodeEnvelopeWeb(doc.toJSON());
    const res = await decodeFlBytes(bytes);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.doc.eq(doc)).toBe(true);
  });

  it("maps a corrupt file to a message (no throw into the caller)", async () => {
    const bytes = await encodeEnvelopeWeb(createSeedDoc().toJSON());
    bytes[bytes.length - 1] ^= 0xff; // corrupt the gzip payload
    const res = await decodeFlBytes(bytes);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message.length).toBeGreaterThan(0);
  });

  it("maps a non-Flowline file (bad magic) to a message", async () => {
    const res = await decodeFlBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(res.ok).toBe(false);
  });
});

describe("validateOpenedDoc — typed-error mapping (the decode→validate cliff)", () => {
  it("accepts a valid doc JSON", () => {
    const res = validateOpenedDoc(createSeedDoc().toJSON());
    expect(res.ok).toBe(true);
  });
  it("rejects a non-doc root with a message (the docFromJson cliff)", () => {
    const res = validateOpenedDoc({ type: "paragraph", attrs: { blockId: "b1" } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message.length).toBeGreaterThan(0);
  });
  it("rejects an excludes-violating emphasis+muted run (check() catches what nodeFromJSON tolerates)", () => {
    const bad = {
      type: "doc",
      content: [
        { type: "paragraph", attrs: { blockId: "b1" }, content: [{ type: "text", text: "x", marks: [{ type: "emphasis" }, { type: "muted" }] }] },
      ],
    };
    expect(validateOpenedDoc(bad).ok).toBe(false);
  });
});

describe("web Save → Open round-trip via the (mocked) File System Access API (S2)", () => {
  it("a doc saved through showSaveFilePicker is byte-round-trippable by showOpenFilePicker", async () => {
    const doc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create({ blockId: id() }, schema.text("round trip me"))]);
    const handle = new FakeHandle("case.fl");
    (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = vi.fn(async () => handle as unknown as FileSystemFileHandle);

    const saveRes = await webSaveFl(doc, { suggestedName: "case" });
    expect(saveRes.ok).toBe(true);
    if (saveRes.ok) {
      expect(saveRes.name).toBe("case.fl");
      expect(saveRes.handle).toBe(handle as unknown);
    }
    expect(handle.bytes.length).toBeGreaterThan(0); // bytes were actually written

    // Now Open the SAME handle's bytes and assert deep equality.
    (window as { showOpenFilePicker?: unknown }).showOpenFilePicker = vi.fn(async () => [handle as unknown as FileSystemFileHandle]);
    const openRes = await webOpenFl();
    expect(openRes.ok).toBe(true);
    if (openRes.ok) {
      expect(openRes.doc.eq(doc)).toBe(true); // byte-round-trippable by Open
      expect(openRes.name).toBe("case.fl");
      expect(openRes.handle).toBe(handle as unknown);
    }
  });

  it("a known handle + plain Save overwrites in place (no picker prompt)", async () => {
    const doc = createSeedDoc();
    const handle = new FakeHandle("doc.fl");
    const picker = vi.fn();
    (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = picker;
    const res = await webSaveFl(doc, { handle: handle as unknown as FileSystemFileHandle, forceDialog: false });
    expect(res.ok).toBe(true);
    expect(picker).not.toHaveBeenCalled(); // overwrote the handle directly — no prompt
    expect(handle.bytes.length).toBeGreaterThan(0);
  });

  it("Save As (forceDialog) prompts even with a known handle", async () => {
    const doc = createSeedDoc();
    const known = new FakeHandle("old.fl");
    const chosen = new FakeHandle("new.fl");
    const picker = vi.fn(async () => chosen as unknown as FileSystemFileHandle);
    (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = picker;
    const res = await webSaveFl(doc, { handle: known as unknown as FileSystemFileHandle, forceDialog: true });
    expect(picker).toHaveBeenCalledOnce();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.name).toBe("new.fl"); // saved to the newly-picked handle
  });

  it("a cancelled save picker is a silent cancel (no error)", async () => {
    (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = vi.fn(async () => {
      throw new DOMException("user aborted", "AbortError");
    });
    const res = await webSaveFl(createSeedDoc(), { suggestedName: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.canceled).toBe(true);
      expect(res.message).toBeUndefined(); // silent — no error toast
    }
  });

  it("a cancelled open picker is a silent cancel", async () => {
    (window as { showOpenFilePicker?: unknown }).showOpenFilePicker = vi.fn(async () => {
      throw new DOMException("user aborted", "AbortError");
    });
    const res = await webOpenFl();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.canceled).toBe(true);
      expect(res.message).toBeUndefined();
    }
  });
});

// FIX 1 — durability: a write/close failure during save must surface {ok:false} and NOT report success, so the
// caller (main.ts) never clears `dirty` on a failed save (the in-memory doc is the only good copy until close
// commits). We stub the FSA writable so write() (then, separately, close()) rejects.
describe("web Save durability — a failed write/close never reports success (FIX 1, S2)", () => {
  // A handle whose createWritable yields a writable that rejects on the chosen step. `bytes` stays empty (never
  // committed), mirroring that the target file is not destroyed when close() does not resolve.
  class FailingHandle {
    bytes = new Uint8Array(0);
    constructor(public name: string, private failOn: "write" | "close") {}
    async createWritable() {
      const failOn = this.failOn;
      return {
        write: async (_data: Blob | BufferSource) => {
          if (failOn === "write") throw new Error("disk full");
        },
        close: async () => {
          if (failOn === "close") throw new Error("commit failed");
        },
      };
    }
    async getFile(): Promise<File> {
      return new File([new Uint8Array(this.bytes)], this.name);
    }
  }

  it("save-in-place: a write() rejection → {ok:false, message} (no success, dirty stays for the caller)", async () => {
    const handle = new FailingHandle("doc.fl", "write");
    const res = await webSaveFl(createSeedDoc(), { handle: handle as unknown as FileSystemFileHandle, forceDialog: false });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.canceled).toBeUndefined(); // a real error, not a silent cancel
      expect(res.message && res.message.length).toBeGreaterThan(0);
    }
  });

  it("save-in-place: a close() rejection → {ok:false, message} (close is the commit point; it must propagate)", async () => {
    const handle = new FailingHandle("doc.fl", "close");
    const res = await webSaveFl(createSeedDoc(), { handle: handle as unknown as FileSystemFileHandle, forceDialog: false });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message && res.message.length).toBeGreaterThan(0);
  });

  it("prompted save (FSA picker): a close() rejection from the picked handle → {ok:false, message}", async () => {
    const handle = new FailingHandle("picked.fl", "close");
    (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = vi.fn(async () => handle as unknown as FileSystemFileHandle);
    const res = await webSaveFl(createSeedDoc(), { suggestedName: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message && res.message.length).toBeGreaterThan(0);
  });
});

// FIX (wet-test v2) — save-in-place permission flow. Chromium's File System Access consent is the BROWSER's own
// dialog; we can't reword it, but the save-in-place path must (a) NOT re-prompt when the grant is already live,
// (b) re-request when it has lapsed, and (c) fall back to a download (never error, never report a false success)
// when the grant is denied. A handle carrying query/requestPermission stubs drives all three.
describe("web Save-in-place permission flow (wet-test v2)", () => {
  // A handle whose queryPermission returns a fixed state, and whose requestPermission returns a fixed result.
  // Records whether each was called so a test can assert "no spurious prompt".
  class PermHandle {
    bytes = new Uint8Array(0);
    queryCalls = 0;
    requestCalls = 0;
    constructor(
      public name: string,
      private queryState: FileSystemPermissionState,
      private requestResult: FileSystemPermissionState,
    ) {}
    async queryPermission(): Promise<FileSystemPermissionState> {
      this.queryCalls++;
      return this.queryState;
    }
    async requestPermission(): Promise<FileSystemPermissionState> {
      this.requestCalls++;
      return this.requestResult;
    }
    async createWritable() {
      const chunks: Uint8Array[] = [];
      return {
        write: async (data: Blob | BufferSource) => {
          const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data as ArrayBuffer);
          chunks.push(buf);
        },
        close: async () => {
          const total = chunks.reduce((n, c) => n + c.length, 0);
          const out = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) {
            out.set(c, off);
            off += c.length;
          }
          this.bytes = out;
        },
      };
    }
    async getFile(): Promise<File> {
      return new File([new Uint8Array(this.bytes)], this.name);
    }
  }
  type FileSystemPermissionState = "granted" | "denied" | "prompt";

  it("already-granted handle: saves in place WITHOUT prompting (no requestPermission, no picker)", async () => {
    const handle = new PermHandle("doc.fl", "granted", "granted");
    const picker = vi.fn();
    (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = picker;
    const res = await webSaveFl(createSeedDoc(), { handle: handle as unknown as FileSystemFileHandle, forceDialog: false });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.handle).toBe(handle as unknown); // kept the handle for the next save-in-place
    if (res.ok) expect(res.downloadedFallback).toBeUndefined(); // a real in-place overwrite is NOT a Downloads copy
    expect(handle.queryCalls).toBe(1);
    expect(handle.requestCalls).toBe(0); // already granted → never re-consents
    expect(picker).not.toHaveBeenCalled();
    expect(handle.bytes.length).toBeGreaterThan(0); // wrote in place
  });

  it("prompt→granted handle: requests permission once, then saves in place (no picker)", async () => {
    const handle = new PermHandle("doc.fl", "prompt", "granted");
    const picker = vi.fn();
    (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = picker;
    const res = await webSaveFl(createSeedDoc(), { handle: handle as unknown as FileSystemFileHandle, forceDialog: false });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.handle).toBe(handle as unknown);
    expect(handle.queryCalls).toBe(1);
    expect(handle.requestCalls).toBe(1); // grant lapsed → re-requested exactly once
    expect(picker).not.toHaveBeenCalled(); // still save-in-place, never the Save-As picker
    expect(handle.bytes.length).toBeGreaterThan(0);
  });

  it("denied handle: falls back to a download ({ok:true, handle:null}), no throw, no write in place", async () => {
    const handle = new PermHandle("doc.fl", "prompt", "denied");
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click");
    const res = await webSaveFl(createSeedDoc(), {
      handle: handle as unknown as FileSystemFileHandle,
      forceDialog: false,
      suggestedName: "doc.fl",
    });
    expect(res.ok).toBe(true); // a denied grant is NOT an error — the user still gets their bytes via download
    if (res.ok) expect(res.handle).toBeNull(); // dropped the unusable handle so the next save re-prompts honestly
    if (res.ok) expect(res.downloadedFallback).toBe(true); // flags the denied→Downloads copy so the caller is honest
    expect(handle.requestCalls).toBe(1);
    expect(handle.bytes.length).toBe(0); // nothing written in place
    expect(clickSpy).toHaveBeenCalledOnce(); // the download fired instead
  });
});

// FIX 2 — the non-FSA fallback path (Firefox/Safari): no showSaveFilePicker / showOpenFilePicker. Save must fall
// back to a Blob download (ok:true, handle:null); Open must drive a transient <input type=file> for BOTH a chosen
// file (resolves bytes) and a dismissed picker (resolves null → silent cancel). FSA is absent for these tests.
describe("non-FSA fallback (Firefox/Safari) — FSA pickers undefined (FIX 2, S2/S3)", () => {
  // Stub <input type=file> behaviour: createElement('input') returns a node whose .click() schedules either a
  // `change` (with a fabricated File) or a `cancel`/focus, per the configured mode, so the headless test drives the
  // fallback without a real file dialog. Restored by vi.restoreAllMocks in afterEach + an explicit restore here.
  let restoreCreate: (() => void) | undefined;
  afterEach(() => {
    restoreCreate?.();
    restoreCreate = undefined;
  });

  it("save fallback: no FSA → returns {ok:true, handle:null} and triggers a download", async () => {
    // FSA absent (afterEach in the outer suite deletes the stubs; assert the precondition holds).
    expect(hasFileSystemAccess()).toBe(false);
    // The anchor click is a no-op under jsdom (tests/setup.ts); spy on it to prove the download was triggered.
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click");
    const res = await webSaveFl(createSeedDoc(), { suggestedName: "fallback" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.handle).toBeNull(); // a download cannot be re-targeted → no reusable handle
      expect(res.name).toBe("fallback.fl");
    }
    expect(clickSpy).toHaveBeenCalledOnce(); // the <a download> was clicked → a download fired
  });

  // Drive pickFileViaInput by intercepting document.createElement('input') and dispatching the configured event.
  function stubFileInput(mode: { kind: "change"; file: File } | { kind: "cancel" }): void {
    const realCreate = document.createElement.bind(document);
    const spy = vi.spyOn(document, "createElement").mockImplementation((tag: string, ...rest: unknown[]) => {
      const el = realCreate(tag as "input", ...(rest as []));
      if (tag === "input") {
        const input = el as HTMLInputElement;
        // Override click(): asynchronously deliver the configured outcome (mirrors a real picker resolving later).
        input.click = (): void => {
          queueMicrotask(() => {
            if (mode.kind === "change") {
              Object.defineProperty(input, "files", { value: [mode.file], configurable: true });
              input.dispatchEvent(new Event("change"));
            } else {
              // Modern UAs dispatch a `cancel` event on a dismissed file picker.
              input.dispatchEvent(new Event("cancel"));
            }
          });
        };
      }
      return el;
    });
    restoreCreate = () => spy.mockRestore();
  }

  it("open fallback: a file chosen via <input> change → decodes + returns the doc (S3)", async () => {
    expect(hasFileSystemAccess()).toBe(false);
    const doc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create({ blockId: id() }, schema.text("from input"))]);
    const bytes = await encodeEnvelopeWeb(doc.toJSON());
    const file = new File([new Uint8Array(bytes)], "input-pick.fl");
    stubFileInput({ kind: "change", file });
    const res = await webOpenFl();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.doc.eq(doc)).toBe(true);
      expect(res.name).toBe("input-pick.fl");
      expect(res.handle).toBeNull(); // <input> path has no save-in-place handle
    }
  });

  it("open fallback: a dismissed <input> picker (cancel event) → silent cancel, no crash (FIX 3)", async () => {
    expect(hasFileSystemAccess()).toBe(false);
    stubFileInput({ kind: "cancel" });
    const res = await webOpenFl();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.canceled).toBe(true);
      expect(res.message).toBeUndefined(); // a dismissed picker is silent
    }
  });
});
