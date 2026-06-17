// persistence/document.ts — turn a decoded payload `docJson` into a VALIDATED Flowline ProseMirror doc.
//
// This is the second half of the open path, split out from the frame codec (envelope.ts) because it needs the
// SCHEMA (and thus prosemirror-model's DOM-typed parseDOM surface) — so it must NOT be part of the no-DOM MAIN
// program. It runs in the renderer (which already has the schema and must build a PMNode anyway to dispatch the
// doc-replace through the single seam) and in tests.
//
// WHY validation is non-trivial (a critical correctness requirement): `schema.nodeFromJSON` does NOT enforce a top-level
// `doc`, and it TOLERATES an excludes-violating emphasis+muted run that `node.check()` REJECTS (schema.ts pins
// exactly this). A hand-edited or merge-derived .fl could therefore round-trip through nodeFromJSON, replace the
// live doc, and only blow up later. So this asserts the root type AND runs check(), throwing the SAME typed
// `EnvelopeError` (kind "BadDocument") the frame codec uses — so the caller catches one type, shows the dialog,
// and leaves the current doc untouched.

import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../schema";
import { EnvelopeError } from "./errors";

/** Parse + validate decoded payload JSON into a Flowline doc, or throw `EnvelopeError("BadDocument", …)`. */
export function docFromJson(docJson: unknown): PMNode {
  if (typeof docJson !== "object" || docJson === null || (docJson as { type?: unknown }).type !== "doc") {
    throw new EnvelopeError("BadDocument", "File is corrupt (not a Flowline document).");
  }
  let doc: PMNode;
  try {
    doc = schema.nodeFromJSON(docJson);
    doc.check(); // rejects malformed structure / missing required child / excludes-violating marks
  } catch (err) {
    if (err instanceof EnvelopeError) throw err;
    throw new EnvelopeError("BadDocument", "File is corrupt (invalid document structure).");
  }
  return doc;
}
