// doc-purity.test.ts — the ProseMirror doc holds ONLY shared content.
// No peripheral/per-user state (selection, scroll, active tool, theme, focused-block, read-mode) may
// EVER appear in doc.toJSON(). There are no peripheral-state sources yet — this gate exists from the start
// so that any later change which accidentally parks session state in the doc fails immediately.
import { describe, it, expect } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../src/schema";
import { createSeedDoc } from "../src/seed";

const ALLOWED_NODE_KEYS = new Set(["type", "attrs", "content", "text", "marks"]);
const ALLOWED_NODE_ATTRS = new Set(["blockId", "level"]); // the ONLY doc-content node attrs
const ALLOWED_MARK_ATTRS = new Set(["color"]); // the ONLY doc-content mark attr

interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

function assertPure(node: JsonNode, path: string): void {
  for (const k of Object.keys(node)) {
    expect(ALLOWED_NODE_KEYS.has(k), `${path}: unexpected node key "${k}"`).toBe(true);
  }
  for (const k of Object.keys(node.attrs ?? {})) {
    expect(ALLOWED_NODE_ATTRS.has(k), `${path}: peripheral/unknown node attr "${k}"`).toBe(true);
  }
  for (const mark of node.marks ?? []) {
    for (const k of Object.keys(mark.attrs ?? {})) {
      expect(ALLOWED_MARK_ATTRS.has(k), `${path}: unknown mark attr "${k}" on ${mark.type}`).toBe(true);
    }
  }
  (node.content ?? []).forEach((child, i) => assertPure(child, `${path}/${child.type}[${i}]`));
}

const check = (doc: PMNode): void => assertPure(doc.toJSON() as JsonNode, doc.type.name);

describe("doc purity", () => {
  it("the seed doc's toJSON contains only content — no peripheral state", () => {
    check(createSeedDoc());
  });
  it("a constructed doc with every block type + every mark stays pure", () => {
    const id = () => crypto.randomUUID();
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.heading.create({ blockId: id(), level: "pocket" }, schema.text("H")),
      // Card is now `tag body` (no cite NODE). The cite MARK is exercised inline on a leading body run,
      // so "every mark" still includes cite. body is `paragraph+`, so wrap the runs in paragraphs.
      schema.nodes.card.create({ blockId: id() }, [
        schema.nodes.tag.create(null, schema.text("t")),
        schema.nodes.body.create(null, [
          schema.nodes.paragraph.create({ blockId: id() }, schema.text("Author 24", [schema.marks.cite.create()])),
          schema.nodes.paragraph.create({ blockId: id() }, schema.text("hot", [schema.marks.highlight.create({ color: "green" })])),
        ]),
      ]),
      schema.nodes.analytic.create({ blockId: id() }, schema.text("a", [schema.marks.emphasis.create()])),
      schema.nodes.paragraph.create({ blockId: id() }, schema.text("p", [schema.marks.muted.create()])),
    ]);
    check(doc);
  });
});
