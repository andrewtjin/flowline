// persistence/errors.ts — the typed open-error, dependency-free.
//
// Lives apart from the frame codec (envelope.ts) ON PURPOSE: envelope.ts imports node `zlib`, so anything that
// imports it gets pulled into the node-only world. The renderer-side validator (document.ts) needs the SAME
// error type but must stay browser-bundlable — so the error class lives here, with zero node/DOM dependencies,
// and both sides import it. envelope.ts re-exports it for the main-process call sites' convenience.

/** The category of an open failure — drives the dialog message; every throw out of the open path is one of these. */
export type EnvelopeErrorKind =
  | "BadMagic" // not a Flowline file at all
  | "BadHeader" // truncated / out-of-bounds / unparseable header or unknown compression
  | "UnsupportedFormat" // envelope formatVersion newer than this build understands
  | "UnsupportedSchema" // doc schemaVersion newer (or older — no migration path yet) than this build's
  | "UnsupportedPayloadKind" // a payload kind this build cannot read (e.g. a future payload kind)
  | "BadPayload" // decompression / payload-JSON failure
  | "BadDocument"; // well-formed JSON that is not a valid Flowline doc (wrong root / fails check())

/** A typed, exhaustive open error. The caller maps `kind`/`message` to the native error dialog. */
export class EnvelopeError extends Error {
  readonly kind: EnvelopeErrorKind;
  constructor(kind: EnvelopeErrorKind, message: string) {
    super(message);
    this.name = "EnvelopeError";
    this.kind = kind;
  }
}
