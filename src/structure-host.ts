// structure-host.ts — the StructureHost predicate surface.
//
// A schema-derived set of PREDICATES the editor binds to instead of node-name strings: mint/identify unit
// ids, test mark behaviour, read the schema version. Everything here is derived from the schema (no instance
// state), so it is exported as a singleton. Editor commands import it to mint ids without hard-coding the
// schema's concrete node/mark names — keeping those names in one place (the schema) rather than scattered.

import { schema } from "./schema";
import { SCHEMA_VERSION } from "./version";
import type { Node as PMNode, MarkType } from "prosemirror-model";

export interface StructureHost {
  structure: {
    /** The stable unit id of a block node, or null for non-unit nodes (text, hard_break, card children). */
    unitIdOf(node: PMNode): string | null;
    /** Mint a fresh, opaque unit id (crypto.randomUUID). */
    newUnitId(): string;
    /** True iff this node is a unit boundary (isolating block). */
    isUnitBoundary(node: PMNode): boolean;
  };
  marks: {
    /** True iff this mark grows at its edges (inclusive). */
    inclusive(markType: MarkType): boolean;
    /** True iff this mark anchors to a sidecar (a comment/source side-channel). False for all current marks. */
    sidecarAnchored(markType: MarkType): boolean;
  };
  /** Integer, bumped iff node/mark vocabulary or attrs change (CI hash-guard enforces). */
  schemaVersion: number;
}

export const structureHost: StructureHost = {
  structure: {
    unitIdOf: (node) => (typeof node.attrs.blockId === "string" ? node.attrs.blockId : null),
    newUnitId: () => crypto.randomUUID(),
    isUnitBoundary: (node) => node.type.spec.isolating === true,
  },
  marks: {
    // PM treats an unspecified `inclusive` as TRUE (marks grow at edges by default), so reflect the
    // ACTUAL edge-growth behavior with `!== false` rather than a literal `=== true`. Equivalent for all
    // current marks (each sets inclusive explicitly); correct for any future mark that omits it.
    inclusive: (markType) => markType.spec.inclusive !== false,
    // No current mark is sidecar-anchored; returning false for all marks proves the predicate's SHAPE.
    sidecarAnchored: () => false,
  },
  schemaVersion: SCHEMA_VERSION,
};

// Re-export the schema so a consumer can take a single dependency on this module if it wishes.
export { schema };
