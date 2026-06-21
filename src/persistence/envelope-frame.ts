// persistence/envelope-frame.ts — the PURE, gzip-free, DOM-free framing of the native "FLOW\x01" envelope.
//
// WHY THIS MODULE EXISTS (DRY across two runtimes). The native `.fl` byte format is decoded in TWO places now:
//   - the Electron MAIN process (envelope.ts), which has node `zlib` (gzipSync/gunzipSync), and
//   - the WEB build's renderer (web-envelope.ts), which has the browser `CompressionStream` instead.
// The ONLY thing that differs between them is the gzip primitive; everything else — the magic, the uint32-LE
// header-length framing, the header-JSON shape, the version/kind gates, the schema up-migration — is identical.
// Duplicating all of that in two codecs is a correctness hazard (a gate fixed in one and not the other lets a
// bad file through on one platform). So the whole frame, MINUS the (de)compression step, lives here as two pure
// functions parameterised by an INJECTED compress/decompress function. envelope.ts injects node zlib; web-
// envelope.ts injects the streams API. Same bytes out of both, by construction.
//
// Buffer-AGNOSTIC, byte-offset safe (the same robustness contract envelope.ts had): the decoder touches ONLY the
// Uint8Array surface (DataView honouring byteOffset; TextEncoder/TextDecoder; byte-by-byte magic) so a Node
// Buffer, an IPC-cloned plain Uint8Array sitting at a non-zero offset, and a browser File's bytes all decode the
// same way. It never calls a Buffer-only method.
//
// Errors: every framing failure throws an `EnvelopeError` (and ONLY that), so a caller catches one type, shows a
// dialog, and leaves the live doc untouched — the exhaustiveness the open path depends on.

import { EnvelopeError } from "./errors";
import { migrateDocJson } from "./migrations";

// "FLOW\x01" — 'F' 'L' 'O' 'W' then a 0x01 container-version byte. Identical to envelope.ts (was private there).
const MAGIC = new Uint8Array([0x46, 0x4c, 0x4f, 0x57, 0x01]);
const FORMAT_VERSION = 1;
const PAYLOAD_KIND = "pm-json";

// Decompression cap, single source of truth for BOTH codecs (node gunzip `maxOutputLength`, web stream bound). The
// codec inflates UNTRUSTED file bytes BEFORE it can validate them, so a gzip-bomb `.fl` could OOM the app; 64 MB is
// far beyond any real document, and exceeding it makes decompression throw → a typed BadPayload. Lives here (the
// shared frame) so the two codecs cannot drift; envelope.ts re-exports it for tests that pin the cap.
export const MAX_DOC_BYTES = 64 * 1024 * 1024;

/** The decoded envelope header (re-exported from envelope.ts for back-compat). */
export interface EnvelopeHeader {
  readonly formatVersion: number;
  readonly schemaVersion: number;
  readonly payloadKind: string;
  readonly compression: "gzip" | "none";
  readonly appVersion: string;
}

/** Compress a payload (gzip). Injected per-runtime: node `gzipSync` (sync) or the streams API (async). */
type Compress = (input: Uint8Array) => Uint8Array | Promise<Uint8Array>;
/** Decompress a gzip payload, throwing on a size-cap overrun / corrupt stream. Injected per-runtime. */
type Decompress = (input: Uint8Array) => Uint8Array | Promise<Uint8Array>;

/**
 * Assemble the envelope bytes from a header + an ALREADY-compressed payload. Pure framing (no gzip here — the
 * caller compressed). Header byte-length is written little-endian as a uint32 BEFORE the header so the payload
 * offset is unambiguous even with a multibyte header field.
 */
export function frameEnvelope(header: EnvelopeHeader, compressedPayload: Uint8Array): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(MAGIC.length + 4 + headerBytes.length + compressedPayload.length);
  out.set(MAGIC, 0);
  // headerLen = the BYTE length of the UTF-8 header, written LE (a string length would desync a multibyte header).
  new DataView(out.buffer).setUint32(MAGIC.length, headerBytes.length, true);
  out.set(headerBytes, MAGIC.length + 4);
  out.set(compressedPayload, MAGIC.length + 4 + headerBytes.length);
  return out;
}

/** Build the standard header for the CURRENT format/payload kind. `schemaVersion`/`appVersion` come from the
 *  caller (version.ts), which both runtimes already import — keeping THIS module free of any version coupling. */
export function buildHeader(schemaVersion: number, appVersion: string): EnvelopeHeader {
  return { formatVersion: FORMAT_VERSION, schemaVersion, payloadKind: PAYLOAD_KIND, compression: "gzip", appVersion };
}

/** True iff the first MAGIC.length bytes equal the magic, compared without any Buffer method. */
function magicMatches(bytes: Uint8Array): boolean {
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false;
  return true;
}

/** The framed parts: the parsed header + the raw (still-compressed) payload slice. */
export interface FrameParts {
  readonly header: EnvelopeHeader;
  readonly rawPayload: Uint8Array;
}

/**
 * Parse + validate the FRAME of `bytes` (magic, header length, header JSON, version/kind/compression gates) and
 * return the header + the still-compressed payload slice. Throws an `EnvelopeError` on any frame failure. SYNC and
 * gzip-free: the caller decompresses `rawPayload` with its injected primitive (node sync zlib stays synchronous;
 * the web codec awaits a stream). Exported so the node codec (envelope.ts) can frame synchronously.
 */
export function parseFrame(bytes: Uint8Array, currentSchemaVersion: number): FrameParts {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // 1) Frame bounds: need magic(5) + headerLen(4) before reading either.
  if (bytes.byteLength < MAGIC.length + 4) {
    throw new EnvelopeError("BadHeader", "File is too short to be a Flowline document.");
  }
  // 2) Magic.
  if (!magicMatches(bytes)) {
    throw new EnvelopeError("BadMagic", "This file is not a Flowline document.");
  }
  // 3) Header length, then bounds-check the header fits before slicing.
  const headerLen = dv.getUint32(MAGIC.length, true);
  const headerStart = MAGIC.length + 4;
  const payloadStart = headerStart + headerLen;
  if (payloadStart > bytes.byteLength) {
    throw new EnvelopeError("BadHeader", "File is corrupt (header length exceeds file size).");
  }
  // 4) Header JSON (reject a null/primitive/array header as a TYPED error so the gates below never hit a raw
  // TypeError on member access).
  let header: EnvelopeHeader;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(headerStart, payloadStart));
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new EnvelopeError("BadHeader", "File is corrupt (unreadable header).");
    }
    header = parsed as EnvelopeHeader;
  } catch (err) {
    if (err instanceof EnvelopeError) throw err;
    throw new EnvelopeError("BadHeader", "File is corrupt (unreadable header).");
  }
  // 5) Version & kind gates — distinct typed errors so the dialog can be specific.
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
  if (header.schemaVersion > currentSchemaVersion) {
    throw new EnvelopeError("UnsupportedSchema", "This file was saved by a newer version of Flowline.");
  }
  // An OLDER schema is migrated up AFTER the payload is parsed (the caller does that step); a newer one above
  // stays unopenable (its shape is unknown).
  return { header, rawPayload: bytes.subarray(payloadStart) };
}

/**
 * The PRE-compression head, shared by both codecs: a document JSON → the UTF-8 bytes to be gzipped. SYNC (no
 * compression here — the caller applies its own sync/async gzip primitive). Centralised so the `JSON.stringify` +
 * `TextEncoder` step cannot drift between node and web.
 */
export function encodePayloadBytes(docJson: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(docJson));
}

/**
 * The POST-decompression tail, shared by both codecs: ALREADY-decompressed payload bytes → the validated, up-
 * migrated `docJson`. SYNC (the caller did its own sync/async decompression first, then hands the bytes here), so
 * the node codec keeps a synchronous decode API and the web codec just awaits before calling this.
 *
 * Error contract (identical to what both codecs had inline): a bad UTF-8 decode OR invalid JSON collapses to a
 * single typed `BadPayload` ("File is corrupt (unreadable content)."). NOTE: a DECOMPRESSION failure (gzip-bomb cap
 * overrun / corrupt stream) is the CALLER's responsibility to map to the same `BadPayload` — it happens before this
 * tail. An older-schema payload is up-migrated to the current schema (a pure JSON transform; `newId` mints fresh
 * blockIds — node `randomUUID`, web `crypto.randomUUID`). `document.ts` then validates the returned JSON.
 */
export function decodePayloadJson(
  decompressed: Uint8Array,
  headerSchemaVersion: number,
  currentSchemaVersion: number,
  newId: () => string,
): unknown {
  let payloadJson: string;
  try {
    payloadJson = new TextDecoder("utf-8", { fatal: true }).decode(decompressed);
  } catch {
    throw new EnvelopeError("BadPayload", "File is corrupt (unreadable content).");
  }
  let docJson: unknown;
  try {
    docJson = JSON.parse(payloadJson);
  } catch {
    throw new EnvelopeError("BadPayload", "File is corrupt (unreadable content).");
  }
  // Up-migrate an older-schema payload to the CURRENT schema (a pure JSON transform; document.ts then validates).
  if (headerSchemaVersion < currentSchemaVersion) {
    docJson = migrateDocJson(docJson, headerSchemaVersion, { newId });
  }
  return docJson;
}

/**
 * Encode a document JSON into envelope bytes. Pure framing + an INJECTED `compress`. Mirrors envelope.ts's encode
 * exactly except the gzip primitive is supplied by the caller, so node and web produce the same byte layout (the
 * gzip OS-stamp byte still differs across implementations, but decode is the contract — see envelope.ts).
 */
export async function encodeEnvelopeWith(
  docJson: unknown,
  schemaVersion: number,
  appVersion: string,
  compress: Compress,
): Promise<Uint8Array> {
  const header = buildHeader(schemaVersion, appVersion);
  const compressed = await compress(encodePayloadBytes(docJson));
  return frameEnvelope(header, compressed);
}

/**
 * Decode envelope bytes into the header + raw payload `docJson`. Pure framing + an INJECTED `decompress` +
 * the shared schema up-migration. Throws an `EnvelopeError` (and only that) on any frame/payload failure.
 * `newId` mints fresh blockIds for a migration (node `randomUUID`, web `crypto.randomUUID`).
 */
export async function decodeEnvelopeWith(
  bytes: Uint8Array,
  currentSchemaVersion: number,
  decompress: Decompress,
  newId: () => string,
): Promise<{ header: EnvelopeHeader; docJson: unknown }> {
  const { header, rawPayload } = parseFrame(bytes, currentSchemaVersion);

  // Decompress with the injected primitive. A gunzip overrun (size cap) or a corrupt stream rejects → map it to the
  // same typed BadPayload the shared tail uses, so the caller never sees an untyped throw (this is the caller-owned
  // half of decodePayloadJson's error contract). The decoded-bytes → validated JSON tail is the shared helper.
  let decompressed: Uint8Array;
  try {
    decompressed = header.compression === "gzip" ? await decompress(rawPayload) : rawPayload;
  } catch {
    throw new EnvelopeError("BadPayload", "File is corrupt (unreadable content).");
  }
  const docJson = decodePayloadJson(decompressed, header.schemaVersion, currentSchemaVersion, newId);
  return { header, docJson };
}
