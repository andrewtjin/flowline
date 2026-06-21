// structure-host.ts — the StructureHost predicate surface.
//
// This is THE clean-implementation boundary. Any external port or consumer binds
// to these PREDICATES — never to node-name strings. Everything here is schema-derived (no instance
// state), so it is exported as a singleton. Editor commands import it internally to mint ids; external
// consumers import the same object. Keeping consumers off node-name strings is what lets the
// schema's concrete names stay private to this package.

import { schema } from "./schema";
import { SCHEMA_VERSION } from "./version";
import type { Node as PMNode, MarkType } from "prosemirror-model";

export interface StructureHost {
  structure: {
    /** The stable unit id of a block node, or null for non-unit nodes (text, hard_break, card children). */
    unitIdOf(node: PMNode): string | null;
    /** Mint a fresh, opaque unit id. Clean-implementation: crypto.randomUUID — no external id-stamp consulted. */
    newUnitId(): string;
    /** True iff this node is a unit boundary (isolating block). */
    isUnitBoundary(node: PMNode): boolean;
  };
  marks: {
    /** True iff this mark grows at its edges (inclusive). */
    inclusive(markType: MarkType): boolean;
    /** True iff this mark anchors to a sidecar (a comment/source side-channel). False for all MVP marks. */
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
    // ACTUAL edge-growth behavior with `!== false` rather than a literal `=== true`.
    // Equivalent for all MVP marks (each sets inclusive explicitly); correct for any future mark
    // that omits it (e.g. the deferred source_anchor) instead of silently lying to consumers.
    inclusive: (markType) => markType.spec.inclusive !== false,
    // No MVP mark is sidecar-anchored; the source_anchor mark is deferred. Returning false for
    // all marks proves the predicate's SHAPE without shipping the mark.
    sidecarAnchored: () => false,
  },
  schemaVersion: SCHEMA_VERSION,
};

// Re-export the schema so an external consumer can take a single dependency on this module if it wishes.
export { schema };
