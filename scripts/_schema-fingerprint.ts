// _schema-fingerprint.ts — deterministic structural fingerprint of the schema's vocabulary + attrs.
// Used by the schema-hash gate (and a unit test) to detect un-versioned schema changes. node:crypto
// lives here (a build/test-only module), never in src/, so it is never bundled into the renderer.
import { createHash } from "node:crypto";
import type { Schema } from "prosemirror-model";

interface AttrSig {
  name: string;
  hasDefault: boolean;
  default: unknown;
}
interface NodeSig {
  name: string;
  content: string | null;
  group: string | null;
  inline: boolean;
  isolating: boolean;
  marks: string | null;
  attrs: AttrSig[] | null;
}
interface MarkSig {
  name: string;
  inclusive: boolean | null;
  excludes: string | null;
  attrs: AttrSig[] | null;
}

function attrSig(attrs: Record<string, { default?: unknown }> | undefined): AttrSig[] | null {
  if (!attrs) return null;
  return Object.keys(attrs)
    .sort()
    .map((name) => ({
      name,
      hasDefault: Object.prototype.hasOwnProperty.call(attrs[name], "default"),
      default: attrs[name].default ?? null,
    }));
}

// Internal to this module (only `fingerprint` is the public surface). Builds the deterministic, sorted
// structural string that gets hashed; not exported because no consumer needs the raw spec, only its hash.
function canonicalSchemaSpec(schema: Schema): string {
  const nodes: NodeSig[] = [];
  schema.spec.nodes.forEach((name, spec) => {
    nodes.push({
      name,
      content: spec.content ?? null,
      group: spec.group ?? null,
      inline: spec.inline ?? false,
      isolating: spec.isolating ?? false,
      marks: spec.marks ?? null,
      attrs: attrSig(spec.attrs as Record<string, { default?: unknown }> | undefined),
    });
  });
  const marks: MarkSig[] = [];
  schema.spec.marks.forEach((name, spec) => {
    marks.push({
      name,
      inclusive: spec.inclusive ?? null,
      excludes: spec.excludes ?? null,
      attrs: attrSig(spec.attrs as Record<string, { default?: unknown }> | undefined),
    });
  });
  return JSON.stringify({ nodes, marks });
}

export function fingerprint(schema: Schema): string {
  return createHash("sha256").update(canonicalSchemaSpec(schema)).digest("hex");
}
