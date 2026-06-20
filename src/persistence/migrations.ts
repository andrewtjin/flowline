// persistence/migrations.ts — PURE, schema-free, DOM-free migrations of a decoded `doc.toJSON()` tree
// between SCHEMA_VERSIONs.
//
// A migration takes the raw document JSON decoded from an older `.fl` file and rewrites it so it validates
// against the CURRENT schema (nodeFromJSON + node.check(), run in document.ts). Migrations are pure tree
// transforms with NO schema / DOM / node imports, so they run in EITHER process (the MAIN-side envelope codec
// or a future web decoder) and are unit-testable in isolation. blockId minting is INJECTED (`newId`) so the
// transform is deterministic under test and carries no crypto/runtime dependency of its own.
//
// v4 → v5 (cite node → cite mark): schema v5 removed the structural `cite` card child (a card became
// `tag body`) and added an inline `cite` MARK. An old card is `{type:"card", content:[tag, cite, body]}`. This
// rewrites it to `{type:"card", content:[tag, body']}`, where body' has the cite's inline content folded in as
// a LEADING body paragraph whose runs carry the `cite` mark (any marks they already had are preserved). An
// EMPTY cite is dropped (no empty leading paragraph). Every other node passes through untouched, and the pass
// is idempotent (a v5 card — already `[tag, body]` — is left alone).

/** Minimal `doc.toJSON()` node shape (mirrors the persistence/docx-ir JSON view). */
interface JsonMark {
  type: string;
  attrs?: Record<string, unknown>;
}
interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
  marks?: JsonMark[];
}

/** Options threaded through a migration. `newId` mints a fresh blockId for any node the migration synthesises. */
export interface MigrationOptions {
  readonly newId: () => string;
}

/** Add the `cite` mark to a text run, preserving its existing marks (idempotent — never doubles the mark). */
function withCiteMark(run: JsonNode): JsonNode {
  if (run.type !== "text") return run; // a cite holds inline* — only text / hard_break; a break carries no mark
  const marks = run.marks ?? [];
  if (marks.some((m) => m.type === "cite")) return run;
  return { ...run, marks: [...marks, { type: "cite" }] };
}

/**
 * Migrate ONE card node from the v4 `[tag, cite, body]` shape to the v5 `[tag, body]` shape. A card that is not
 * exactly `[tag, cite, body]` (already v5, or any unexpected shape) is returned unchanged, which keeps the pass
 * idempotent and safe to run on a mixed/already-migrated tree.
 */
function migrateCardV4ToV5(card: JsonNode, opts: MigrationOptions): JsonNode {
  const children = card.content ?? [];
  if (children.length !== 3 || children[1]?.type !== "cite") return card;
  const [tag, cite, body] = children;
  const bodyParas = body?.content ? [...body.content] : [];
  const citeContent = cite.content ?? [];
  if (citeContent.length > 0) {
    // Fold the cite's inline content into a LEADING body paragraph, cite-marking its runs so the source still
    // reads as a bold citation line — now an inline mark on a body paragraph rather than a dedicated child.
    bodyParas.unshift({
      type: "paragraph",
      attrs: { blockId: opts.newId() },
      content: citeContent.map(withCiteMark),
    });
  }
  const newBody: JsonNode = { ...body, type: "body", content: bodyParas };
  return { ...card, content: [tag, newBody] };
}

/** Recursively migrate cards anywhere in the tree (cards are top-level today, but recurse for safety). */
function migrateNodeV4ToV5(node: JsonNode, opts: MigrationOptions): JsonNode {
  let next = node;
  if (next.type === "card") next = migrateCardV4ToV5(next, opts);
  if (next.content) next = { ...next, content: next.content.map((c) => migrateNodeV4ToV5(c, opts)) };
  return next;
}

/**
 * Migrate a decoded `doc.toJSON()` tree saved at `fromVersion` up to the current schema. Today only the v4→v5
 * cite-node→mark transform exists; any `fromVersion < 5` runs it. An unknown/older shape that the transform
 * cannot fix simply passes through and is rejected downstream by document.ts's node.check() — a migration NEVER
 * silently corrupts a doc. Returns a NEW tree; the input is not mutated.
 */
export function migrateDocJson(docJson: unknown, fromVersion: number, opts: MigrationOptions): unknown {
  if (typeof docJson !== "object" || docJson === null) return docJson;
  let doc = docJson as JsonNode;
  if (fromVersion < 5) doc = migrateNodeV4ToV5(doc, opts);
  return doc;
}
