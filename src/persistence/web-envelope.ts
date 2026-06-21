// persistence/web-envelope.ts — the WEB (browser) native `.fl` codec.
//
// The desktop app encodes/decodes `.fl` bytes in the Electron MAIN process (envelope.ts, node `zlib`). The WEB
// build has no MAIN process, so the renderer must do it itself — but it CANNOT import envelope.ts (that pulls in
// `node:zlib`/`node:crypto`, which do not bundle for the browser). This module is the browser-native counterpart:
// it reuses the SHARED, gzip-free framing (envelope-frame.ts) and injects the browser gzip primitive
// (`CompressionStream`/`DecompressionStream`) + `crypto.randomUUID` for migrations. The result is the SAME byte
// FORMAT as the node codec, so a `.fl` saved on web opens on desktop and vice-versa (the round-trip contract the
// envelope tests pin — gzip's OS-stamp byte may differ, but decode is the contract, never golden bytes).
//
// WEB-ONLY: this is reached only when `!window.flowline` (no preload bridge). The desktop save/open path is
// byte-for-byte unchanged (it still calls envelope.ts in MAIN). See renderer/web-files.ts for the file-picker glue.

import { SCHEMA_VERSION, APP_VERSION } from "../version";
import { EnvelopeError } from "./errors";
import { encodeEnvelopeWith, decodeEnvelopeWith, MAX_DOC_BYTES } from "./envelope-frame";
import type { EnvelopeHeader } from "./envelope-frame";

export { EnvelopeError };
export type { EnvelopeHeader } from "./envelope-frame";

// 64 MB decompression cap, shared from envelope-frame.ts with the node codec so the two cannot drift: we inflate
// UNTRUSTED file bytes before we can validate them, so a gzip-bomb `.fl` could OOM the tab. We bound the inflated
// size while reading the stream and throw past the cap → a typed BadPayload (the decompress wrapper maps it).

/** Concatenate a list of chunks into one Uint8Array (the streams API yields chunks; we need a flat buffer). */
function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Pump `input` through a gzip transform stream and collect the output bytes. Used for both directions; the
 *  optional `cap` bounds the OUTPUT size (decompression only) so a gzip bomb cannot exhaust memory. */
async function pumpThrough(input: Uint8Array, transform: GenericTransformStream, cap?: number): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  // Write + close concurrently with reading so the stream's internal buffer never deadlocks on a large payload. On
  // CORRUPT input the stream errors and BOTH this write/close chain AND reader.read() below reject. We swallow the
  // write side's rejection (`.catch`) so it is never an UNHANDLED rejection — the read side surfaces the failure to
  // the caller (which maps it to a typed BadPayload). Without the catch, a corrupt `.fl` would log an unhandled
  // rejection even though decode correctly throws.
  void writer
    .write(input)
    .then(() => writer.close())
    .catch(() => {});
  const reader = transform.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read(); // rejects on a corrupt stream → propagates to decode's try/catch
    if (done) break;
    total += value.length;
    // Bound the inflated size for decompression (the gzip-bomb defense). Throwing here surfaces as BadPayload.
    if (cap !== undefined && total > cap) throw new Error("payload exceeds size cap");
    chunks.push(value);
  }
  return concat(chunks, total);
}

/** Browser gzip compress via CompressionStream. */
const compress = (input: Uint8Array): Promise<Uint8Array> => pumpThrough(input, new CompressionStream("gzip"));
/** Browser gzip decompress via DecompressionStream, bounded by the size cap. */
const decompress = (input: Uint8Array): Promise<Uint8Array> => pumpThrough(input, new DecompressionStream("gzip"), MAX_DOC_BYTES);

/**
 * Encode a Flowline document JSON (`doc.toJSON()`) into native `.fl` envelope bytes in the BROWSER. Async (the
 * streams API is async). Byte-format-identical to envelope.ts's `encodeEnvelope`; only the gzip engine differs.
 */
export function encodeEnvelopeWeb(docJson: unknown): Promise<Uint8Array> {
  return encodeEnvelopeWith(docJson, SCHEMA_VERSION, APP_VERSION, compress);
}

/**
 * Decode native `.fl` envelope bytes into the header + raw payload `docJson` in the BROWSER. Async. Throws an
 * `EnvelopeError` (and ONLY that) on any frame/payload failure — the same typed-error contract as the node codec,
 * so the web open path catches one type, shows an error, and leaves the live doc untouched. The caller turns
 * `docJson` into a validated PM doc with `docFromJson` (document.ts).
 */
export function decodeEnvelopeWeb(bytes: Uint8Array): Promise<{ header: EnvelopeHeader; docJson: unknown }> {
  // crypto.randomUUID mints fresh blockIds for a schema up-migration (the browser counterpart to node randomUUID).
  return decodeEnvelopeWith(bytes, SCHEMA_VERSION, decompress, () => crypto.randomUUID());
}
