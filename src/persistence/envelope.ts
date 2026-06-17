// persistence/envelope.ts — the native Flowline file format (the "FLOW\x01" envelope).
//
// LAYOUT (one spec, currently one payload kind):
//   [ magic    : 5 bytes  = "FLOW\x01" ]
//   [ headerLen: uint32 LE = BYTE length of the UTF-8 header JSON (NOT its string length) ]
//   [ header   : UTF-8 JSON { formatVersion, schemaVersion, payloadKind, compression, appVersion } ]
//   [ payload  : compression(UTF-8 JSON.stringify(doc.toJSON())) ]
// The current payloadKind is "pm-json" (a lossless dead snapshot); the same envelope can later carry
// a future binary payloadKind — the version fields are locked now so that addition is non-breaking.
//
// WHY Buffer-AGNOSTIC (a critical robustness requirement). The decoder runs in the Electron MAIN process on a Node
// `Buffer` read from disk, but a Buffer that ever crossed an IPC structured-clone boundary arrives as a
// plain `Uint8Array` (Buffer-only methods like readUInt32LE/.equals/.toString then throw). So this codec
// touches ONLY the Uint8Array surface: framing via `DataView` (respecting byteOffset — a cloned view can
// sit at a non-zero offset of a larger ArrayBuffer), text via `TextEncoder`/`TextDecoder`, magic compared
// byte-by-byte. It never calls a Buffer method. (Raw bytes stay in MAIN; IPC only ever carries doc JSON +
// typed errors, never raw bytes — but the codec is hardened regardless.)
//
// WHY THIS CODEC IS FRAME-ONLY (no schema). It runs in the Electron MAIN process (it needs node `zlib`), and
// MAIN compiles WITHOUT the DOM lib (tsconfig.node.json). Importing the schema here would drag schema.ts's
// `HTMLElement` parseDOM types into the no-DOM program and fail typecheck. So this module decodes the BYTE FRAME
// (magic / header / version gates / decompression / JSON.parse) and returns the raw `docJson`; turning that JSON
// into a VALIDATED ProseMirror doc (nodeFromJSON + a top-level-`doc` assert + node.check(), which catches an
// excludes-violating emphasis+muted run that nodeFromJSON tolerates but check() rejects) lives in the
// schema-aware, renderer/test-side `document.ts` (`docFromJson`). Both throw the SAME typed `EnvelopeError`, so
// the open path's "show a dialog, leave the live doc UNCHANGED" guarantee stays exhaustive.

import { gzipSync, gunzipSync } from "node:zlib";
import { SCHEMA_VERSION, APP_VERSION } from "../version";
import { EnvelopeError } from "./errors";

// Re-export the typed error (+ kind) so main-process call sites keep importing from this module. The class
// itself lives in ./errors (zlib-free) so the renderer-side validator can share it without pulling in node:zlib.
export { EnvelopeError };
export type { EnvelopeErrorKind } from "./errors";

// "FLOW\x01" — 'F' 'L' 'O' 'W' then a 0x01 version-of-the-container byte.
const MAGIC = new Uint8Array([0x46, 0x4c, 0x4f, 0x57, 0x01]);
const FORMAT_VERSION = 1;
const PAYLOAD_KIND = "pm-json";
// Decompression cap: the codec runs in the privileged MAIN process on UNTRUSTED file bytes and decompresses
// BEFORE it can validate the payload, so a gzip-bomb .fl could otherwise OOM/freeze the app. 64 MB is far beyond
// any real debate document; exceeding it makes gunzip throw → a typed BadPayload (caught below). Exported for tests.
export const MAX_DOC_BYTES = 64 * 1024 * 1024;

/** The decoded envelope header. */
export interface EnvelopeHeader {
  readonly formatVersion: number;
  readonly schemaVersion: number;
  readonly payloadKind: string;
  readonly compression: "gzip" | "none";
  readonly appVersion: string;
}

/**
 * Encode a Flowline document JSON (`doc.toJSON()`) into the native envelope bytes. `docJson` is the plain
 * serialisable object the renderer sends over IPC — encode does not need the schema. Returns a `Uint8Array`
 * (the MAIN process writes it straight to disk with `fs.writeFile`, which accepts a Uint8Array).
 *
 * NOTE: the bytes are deterministic WITHIN one OS but not across OSes (gzip stamps a platform OS byte), so
 * tests assert the decode CONTRACT (deep-equal), never a golden-byte fixture.
 */
export function encodeEnvelope(docJson: unknown): Uint8Array {
  const header: EnvelopeHeader = {
    formatVersion: FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    payloadKind: PAYLOAD_KIND,
    compression: "gzip",
    appVersion: APP_VERSION,
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const payloadJson = new TextEncoder().encode(JSON.stringify(docJson));
  const payload = gzipSync(payloadJson); // Buffer (a Uint8Array) — used only via the Uint8Array surface below

  const out = new Uint8Array(MAGIC.length + 4 + headerBytes.length + payload.length);
  out.set(MAGIC, 0);
  // headerLen = the BYTE length of the UTF-8 header, written LE. (Using a string length here would desync the
  // payload offset for any multibyte header field.)
  new DataView(out.buffer).setUint32(MAGIC.length, headerBytes.length, true);
  out.set(headerBytes, MAGIC.length + 4);
  out.set(payload, MAGIC.length + 4 + headerBytes.length);
  return out;
}

/** True iff the first MAGIC.length bytes of `bytes` equal the magic, compared without any Buffer method. */
function magicMatches(bytes: Uint8Array): boolean {
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false;
  return true;
}

/**
 * Decode native envelope bytes into the header + the raw payload `docJson`. Throws an `EnvelopeError` (and ONLY
 * an EnvelopeError) on any FRAME failure (magic / header / version / decompression / JSON), so the open path can
 * catch one type, show the dialog, and leave the live doc untouched. Turning `docJson` into a validated PM doc is
 * `docFromJson` (document.ts). Accepts any `Uint8Array` (incl. a Node `Buffer` or an IPC-cloned, byte-offset view).
 */
export function decodeEnvelope(bytes: Uint8Array): { header: EnvelopeHeader; docJson: unknown } {
  // A DataView bound to THIS view's window of its ArrayBuffer (honours a non-zero byteOffset).
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // 1) Frame bounds: need at least magic(5) + headerLen(4) before we can read either.
  if (bytes.byteLength < MAGIC.length + 4) {
    throw new EnvelopeError("BadHeader", "File is too short to be a Flowline document.");
  }
  // 2) Magic.
  if (!magicMatches(bytes)) {
    throw new EnvelopeError("BadMagic", "This file is not a Flowline document.");
  }
  // 3) Header length, then bounds-check that the header fits before slicing.
  const headerLen = dv.getUint32(MAGIC.length, true);
  const headerStart = MAGIC.length + 4;
  const payloadStart = headerStart + headerLen;
  if (payloadStart > bytes.byteLength) {
    throw new EnvelopeError("BadHeader", "File is corrupt (header length exceeds file size).");
  }
  // 4) Header JSON.
  let header: EnvelopeHeader;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(headerStart, payloadStart));
    const parsed: unknown = JSON.parse(text);
    // JSON.parse("null") SUCCEEDS and returns null (no throw); a primitive/array header is invalid too. Reject
    // here so the version gates below can never hit an UNtyped TypeError on member access — every failure stays
    // a typed EnvelopeError.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new EnvelopeError("BadHeader", "File is corrupt (unreadable header).");
    }
    header = parsed as EnvelopeHeader;
  } catch (err) {
    if (err instanceof EnvelopeError) throw err;
    throw new EnvelopeError("BadHeader", "File is corrupt (unreadable header).");
  }
  // 5) Version & kind gates — distinct typed errors so the dialog can be specific (not generic "corrupt").
  if (typeof header.formatVersion !== "number") {
    throw new EnvelopeError("BadHeader", "File is corrupt (missing format version).");
  }
  if (header.formatVersion > FORMAT_VERSION) {
    throw new EnvelopeError("UnsupportedFormat", "This file was saved by a newer version of Flowline.");
  }
  if (header.payloadKind !== PAYLOAD_KIND) {
    throw new EnvelopeError(
      "UnsupportedPayloadKind",
      "This file uses a payload type this version of Flowline cannot open.",
    );
  }
  if (header.compression !== "gzip" && header.compression !== "none") {
    throw new EnvelopeError("BadHeader", "File is corrupt (unknown compression).");
  }
  if (typeof header.schemaVersion !== "number") {
    throw new EnvelopeError("BadHeader", "File is corrupt (missing schema version).");
  }
  if (header.schemaVersion > SCHEMA_VERSION) {
    throw new EnvelopeError("UnsupportedSchema", "This file was saved by a newer version of Flowline.");
  }
  if (header.schemaVersion < SCHEMA_VERSION) {
    // No migration path yet — reject cleanly rather than mislabel an older save as generic corruption.
    throw new EnvelopeError(
      "UnsupportedSchema",
      "This file was saved by an older version of Flowline and cannot be opened.",
    );
  }
  // 6) Payload → JSON.
  const rawPayload = bytes.subarray(payloadStart);
  let payloadJson: string;
  try {
    const bytesOut = header.compression === "gzip" ? gunzipSync(rawPayload, { maxOutputLength: MAX_DOC_BYTES }) : rawPayload;
    payloadJson = new TextDecoder("utf-8", { fatal: true }).decode(bytesOut);
  } catch {
    throw new EnvelopeError("BadPayload", "File is corrupt (unreadable content).");
  }
  let docJson: unknown;
  try {
    docJson = JSON.parse(payloadJson);
  } catch {
    throw new EnvelopeError("BadPayload", "File is corrupt (unreadable content).");
  }
  return { header, docJson };
}
