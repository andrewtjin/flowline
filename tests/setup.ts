// Vitest global setup. Ensure crypto.randomUUID exists for blockId minting under jsdom.
import { webcrypto } from "node:crypto";

if (typeof globalThis.crypto === "undefined" || typeof globalThis.crypto.randomUUID !== "function") {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

// jsdom does not implement URL.createObjectURL / revokeObjectURL, which the web download paths (web-files.ts /
// web-docx.ts) call. Provide inert stubs so those code paths run under test without throwing; the tests that care
// about the produced bytes capture the Blob directly (they don't rely on the URL value).
if (typeof URL !== "undefined") {
  if (typeof URL.createObjectURL !== "function") {
    (URL as { createObjectURL: (obj: unknown) => string }).createObjectURL = () => "blob:test";
  }
  if (typeof URL.revokeObjectURL !== "function") {
    (URL as { revokeObjectURL: (url: string) => void }).revokeObjectURL = () => {};
  }
}

// jsdom's Blob (and File) do not implement the async `arrayBuffer()` method that the web file paths use to read a
// picked file's bytes (web-files.ts readFileBytes) and that the docx test uses to read the packed Blob. Polyfill it
// via the FileReader jsdom DOES provide, so the real read path is exercised under test rather than stubbed away.
if (typeof Blob !== "undefined" && typeof Blob.prototype.arrayBuffer !== "function") {
  Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

// The web download path (web-files.ts / web-docx.ts) triggers a download with `anchor.click()`. In a real browser
// an <a download> click downloads without navigating; jsdom has no download/navigation support and logs a spurious
// "Not implemented: navigation" error that vitest then flags as an unhandled error. Stub the anchor click to a
// no-op so that browser-only side effect is inert under test — the tests verify the produced bytes, not the
// browser's download action. Production is unaffected (this only patches the jsdom prototype inside the test env).
if (typeof HTMLAnchorElement !== "undefined") {
  HTMLAnchorElement.prototype.click = function click(): void {};
}
