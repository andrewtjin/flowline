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
// (magic / header / version gates / decompression / JSON.parse), up-migrates an older-schema payload to the
// CURRENT schema (a pure JSON transform — see migrations.ts), and returns the `docJson`; turning that JSON
// into a VALIDATED ProseMirror doc (nodeFromJSON + a top-level-`doc` assert + node.check(), which catches an
// excludes-violating emphasis+muted run that nodeFromJSON tolerates but check() rejects) lives in the
// schema-aware, renderer/test-side `document.ts` (`docFromJson`). Both throw the SAME typed `EnvelopeError`, so
// the open path's "show a dialog, leave the live doc UNCHANGED" guarantee stays exhaustive.

import { gzipSync, gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { SCHEMA_VERSION, APP_VERSION } from "../version";
import { EnvelopeError } from "./errors";
import { migrateDocJson } from "./migrations";
import { buildHeader, frameEnvelope, parseFrame } from "./envelope-frame";
import type { EnvelopeHeader } from "./envelope-frame";

// Re-export the typed error (+ kind) so main-process call sites keep importing from this module. The class
// itself lives in ./errors (zlib-free) so the renderer-side validator can share it without pulling in node:zlib.
export { EnvelopeError };
export type { EnvelopeErrorKind } from "./errors";
// Re-export the header type from its new home (the shared frame module) so existing importers are unaffected.
export type { EnvelopeHeader } from "./envelope-frame";

// Decompression cap: the codec runs in the privileged MAIN process on UNTRUSTED file bytes and decompresses
// BEFORE it can validate the payload, so a gzip-bomb .fl could otherwise OOM/freeze the app. 64 MB is far beyond
// any real debate document; exceeding it makes gunzip throw → a typed BadPayload (caught below). Exported for tests.
export const MAX_DOC_BYTES = 64 * 1024 * 1024;

/**
 * Encode a Flowline document JSON (`doc.toJSON()`) into the native envelope bytes. `docJson` is the plain
 * serialisable object the renderer sends over IPC — encode does not need the schema. Returns a `Uint8Array`
 * (the MAIN process writes it straight to disk with `fs.writeFile`, which accepts a Uint8Array).
 *
 * Framing is shared with the web codec (envelope-frame.ts) so both emit the SAME layout; only the gzip primitive
 * differs — here node `gzipSync`. NOTE: the bytes are deterministic WITHIN one OS but not across OSes (gzip stamps
 * a platform OS byte), so tests assert the decode CONTRACT (deep-equal), never a golden-byte fixture.
 */
export function encodeEnvelope(docJson: unknown): Uint8Array {
  const header: EnvelopeHeader = buildHeader(SCHEMA_VERSION, APP_VERSION);
  const payloadJson = new TextEncoder().encode(JSON.stringify(docJson));
  const payload = gzipSync(payloadJson); // Buffer (a Uint8Array) — passed to frameEnvelope via the Uint8Array surface
  return frameEnvelope(header, payload);
}

/**
 * Decode native envelope bytes into the header + the raw payload `docJson`. Throws an `EnvelopeError` (and ONLY
 * an EnvelopeError) on any FRAME failure (magic / header / version / decompression / JSON), so the open path can
 * catch one type, show the dialog, and leave the live doc untouched. Turning `docJson` into a validated PM doc is
 * `docFromJson` (document.ts). Accepts any `Uint8Array` (incl. a Node `Buffer` or an IPC-cloned, byte-offset view).
 *
 * The FRAME parse (magic/header/version gates) is the shared `parseFrame`; only the gunzip + JSON.parse + migrate
 * tail lives here (synchronous, node zlib) so the MAIN process keeps a synchronous decode API.
 */
export function decodeEnvelope(bytes: Uint8Array): { header: EnvelopeHeader; docJson: unknown } {
  const { header, rawPayload } = parseFrame(bytes, SCHEMA_VERSION);
  // Payload → JSON (node sync zlib). A gunzip overrun (size cap), corrupt stream, bad UTF-8, or invalid JSON all
  // collapse to a single typed BadPayload — mirroring the web codec's decompress tail.
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
  // Up-migrate an older-schema payload to the CURRENT schema before handing it back (e.g. v4→v5 folds each
  // card's removed `cite` node into a cite-marked leading body line). document.ts then nodeFromJSON + check()s it.
  if (header.schemaVersion < SCHEMA_VERSION) {
    docJson = migrateDocJson(docJson, header.schemaVersion, { newId: () => randomUUID() });
  }
  return { header, docJson };
}
