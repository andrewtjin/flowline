// Vitest global setup. Ensure crypto.randomUUID exists for blockId minting under jsdom.
import { webcrypto } from "node:crypto";

if (typeof globalThis.crypto === "undefined" || typeof globalThis.crypto.randomUUID !== "function") {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}
