// version.ts — schema/app version stamps.
//
// SCHEMA_VERSION is the hand-bumped integer stamped into every saved Flowline document
// (and exposed via the StructureHost surface). Bump it whenever the node/mark VOCABULARY or
// ATTRS change. The CI schema-hash guard (`npm run check:schema-hash`) fingerprints the schema
// spec and fails the build if the fingerprint changed but this constant did not bump — so a
// silent, unversioned schema change cannot ship. This cannot be retrofitted onto docs already
// saved without a version field, which is why it exists from commit 1.
//
// v1 → v2: added the `underline` mark (read-aloud "read this" marker, Verbatim's "Style Underline").
// v2 → v3: added the `strong` mark (plain bold weight, the Word/Ctrl+B "B" affordance).
// v3 → v4: card `body` content changed `inline*` → `paragraph+` (multi-paragraph evidence); `paragraph`
//          gained an explicit `blockId` default (null) so it is generatable in body's required `+`
//          position (teeth preserved via a requiredBlockId validator). See the paragraph/body notes in src/schema.ts.
export const SCHEMA_VERSION = 4;

// Informational app version carried in the native file-envelope header.
export const APP_VERSION = "0.0.0";
