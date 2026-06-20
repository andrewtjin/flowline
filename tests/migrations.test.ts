// migrations.test.ts — E11: the pure v4→v5 cite-node → cite-mark document migration.
//
// migrateDocJson rewrites a decoded `doc.toJSON()` saved at an older schema so it validates against the
// current schema. The v4→v5 transform folds each card's removed `cite` NODE into a cite-MARKED leading body
// paragraph. These tests assert the transform on raw JSON (deterministic injected ids) AND that the result
// validates via the live schema (nodeFromJSON + check()), so an old `.fl` really opens.

import { describe, it, expect } from "vitest";
import { migrateDocJson } from "../src/persistence/migrations";
import { schema } from "../src/schema";

/** A loose, fully-resolved JSON node view for terse deep access in assertions (the shapes here are known). */
interface J {
  type: string;
  attrs: Record<string, unknown>;
  content: J[];
  text: string;
  marks: { type: string }[];
}
const asJ = (v: unknown): J => v as J;

/** A deterministic blockId factory so the migration output is assertable. */
function seqIds(): () => string {
  let n = 0;
  return () => `mig-${n++}`;
}

/** Build a v4-shaped card JSON `[tag, cite, body]`. */
function v4Card(tagText: string, citeText: string, bodyText: string): object {
  return {
    type: "card",
    attrs: { blockId: "c1" },
    content: [
      { type: "tag", content: tagText ? [{ type: "text", text: tagText }] : [] },
      { type: "cite", content: citeText ? [{ type: "text", text: citeText }] : [] },
      {
        type: "body",
        content: [{ type: "paragraph", attrs: { blockId: "c1b0" }, content: [{ type: "text", text: bodyText }] }],
      },
    ],
  };
}

const v4Doc = (card: object): object => ({ type: "doc", content: [card] });

describe("v4 → v5 cite-node → cite-mark migration (E11)", () => {
  it("folds a non-empty cite into a cite-marked LEADING body paragraph, and the result validates", () => {
    const migrated = asJ(migrateDocJson(v4Doc(v4Card("Claim", "Author 2020", "Evidence")), 4, { newId: seqIds() }));
    const card = migrated.content[0];
    expect(card.content.map((c) => c.type)).toEqual(["tag", "body"]); // cite child is gone

    const body = card.content[1];
    expect(body.content.length).toBe(2); // cite-line paragraph + original evidence paragraph
    const citePara = body.content[0];
    expect(citePara.type).toBe("paragraph");
    expect(citePara.attrs.blockId).toBe("mig-0"); // injected id used
    expect(citePara.content[0].text).toBe("Author 2020");
    expect(citePara.content[0].marks).toEqual([{ type: "cite" }]); // cite-marked
    expect(body.content[1].content[0].text).toBe("Evidence");

    // The migrated tree must validate against the CURRENT (v5) schema.
    const doc = schema.nodeFromJSON(migrated as unknown);
    expect(() => doc.check()).not.toThrow();
  });

  it("DROPS an empty cite (no empty leading paragraph)", () => {
    const migrated = asJ(migrateDocJson(v4Doc(v4Card("Claim", "", "Evidence")), 4, { newId: seqIds() }));
    const body = migrated.content[0].content[1];
    expect(body.content.length).toBe(1); // only the original evidence paragraph
    expect(() => schema.nodeFromJSON(migrated as unknown).check()).not.toThrow();
  });

  it("preserves a cite run's existing marks, adding cite ALONGSIDE them", () => {
    const card = {
      type: "card",
      attrs: { blockId: "c1" },
      content: [
        { type: "tag", content: [{ type: "text", text: "Claim" }] },
        { type: "cite", content: [{ type: "text", text: "Src", marks: [{ type: "underline" }] }] },
        { type: "body", content: [{ type: "paragraph", attrs: { blockId: "c1b0" }, content: [{ type: "text", text: "Ev" }] }] },
      ],
    };
    const migrated = asJ(migrateDocJson(v4Doc(card), 4, { newId: seqIds() }));
    const marks = migrated.content[0].content[1].content[0].content[0].marks;
    expect(marks).toContainEqual({ type: "underline" });
    expect(marks).toContainEqual({ type: "cite" });
    expect(() => schema.nodeFromJSON(migrated as unknown).check()).not.toThrow();
  });

  it("leaves an already-v5 `tag body` card untouched (idempotent)", () => {
    const v5Card = {
      type: "doc",
      content: [
        {
          type: "card",
          attrs: { blockId: "c1" },
          content: [
            { type: "tag", content: [{ type: "text", text: "Claim" }] },
            { type: "body", content: [{ type: "paragraph", attrs: { blockId: "c1b0" }, content: [{ type: "text", text: "Ev" }] }] },
          ],
        },
      ],
    };
    const out = asJ(migrateDocJson(v5Card, 4, { newId: seqIds() }));
    expect(out.content[0].content.map((c) => c.type)).toEqual(["tag", "body"]);
  });
});
