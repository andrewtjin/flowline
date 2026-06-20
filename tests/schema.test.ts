// schema.test.ts — locked schema invariants + conformance "rejects malformed docs".
import { describe, it, expect } from "vitest";
import { Node } from "prosemirror-model";
import { schema, buildCard } from "../src/schema";

const uuid = () => crypto.randomUUID();
const BLOCKS = ["card", "analytic", "heading", "paragraph"] as const;

describe("schema vocabulary", () => {
  it("defines 4 blocks + card children + text + hard_break", () => {
    // Card children are now `tag body` (the `cite` NODE was removed in schema v5 — cite is an inline MARK).
    for (const n of ["doc", "card", "tag", "body", "analytic", "heading", "paragraph", "text", "hard_break"]) {
      expect(schema.nodes[n], `node ${n}`).toBeTruthy();
    }
    // The structural `cite` node is GONE (replaced by the inline `cite` mark).
    expect(schema.nodes.cite, "no cite node").toBeUndefined();
  });
  it("defines exactly 6 marks: highlight, emphasis, muted, underline (v2), strong (v3), cite (v5)", () => {
    expect(Object.keys(schema.marks).sort()).toEqual(["cite", "emphasis", "highlight", "muted", "strong", "underline"]);
  });
  it("cite (v5) is an inclusive inline mark with no attrs and no excludes", () => {
    expect(schema.marks.cite, "cite mark exists").toBeTruthy();
    expect(schema.marks.cite.spec.inclusive).toBe(true);
    expect(schema.marks.cite.spec.attrs).toBeUndefined(); // no attrs
    // layers freely — excludes nothing (only itself, by default).
    expect(schema.marks.cite.excludes(schema.marks.highlight)).toBe(false);
    expect(schema.marks.cite.excludes(schema.marks.emphasis)).toBe(false);
    expect(schema.marks.cite.excludes(schema.marks.muted)).toBe(false);
    expect(schema.marks.cite.excludes(schema.marks.underline)).toBe(false);
    expect(schema.marks.cite.excludes(schema.marks.strong)).toBe(false);
  });
});

describe("block invariants", () => {
  it("all 4 blocks are isolating with a required blockId", () => {
    for (const n of BLOCKS) {
      expect(schema.nodes[n].spec.isolating, `${n} isolating`).toBe(true);
      expect(schema.nodes[n].spec.attrs!.blockId, `${n} has a blockId attr`).toBeTruthy();
    }
  });
  // card/analytic/heading sit only in `block*` (never a required `+` position), so their blockId
  // keeps NO default — a missing id can't be auto-filled.
  it("card/analytic/heading blockId has NO default", () => {
    for (const n of ["card", "analytic", "heading"] as const) {
      const blockId = schema.nodes[n].spec.attrs!.blockId as { default?: unknown };
      expect("default" in blockId, `${n}.blockId has no default`).toBe(false);
    }
  });
  // paragraph is the content of body's required `paragraph+` position, so PM needs it to be
  // generatable — its blockId carries an explicit `default: null` (a structural proxy only). The teeth
  // move to a `validate` function (asserted by the "rejects a paragraph with null/absent blockId" case).
  it("paragraph.blockId has an explicit default (null) so body's paragraph+ can build", () => {
    const blockId = schema.nodes.paragraph.spec.attrs!.blockId as { default?: unknown };
    expect("default" in blockId).toBe(true);
    expect(blockId.default).toBe(null);
  });
  // card body content model is `paragraph+`, not `inline*`.
  it("card body content is paragraph+ (multi-paragraph evidence)", () => {
    expect(schema.nodes.body.spec.content).toBe("paragraph+");
  });
  it("heading.level defaults to 'block'", () => {
    const level = schema.nodes.heading.spec.attrs!.level as { default?: unknown };
    expect(level.default).toBe("block");
  });
});

describe("mark invariants", () => {
  it("highlight inclusive + required color; emphasis inclusive; muted non-inclusive", () => {
    expect(schema.marks.highlight.spec.inclusive).toBe(true);
    const color = schema.marks.highlight.spec.attrs!.color as { default?: unknown };
    expect("default" in color).toBe(false);
    expect(schema.marks.emphasis.spec.inclusive).toBe(true);
    expect(schema.marks.muted.spec.inclusive).toBe(false);
  });
  it("emphasis <-> muted is a symmetric excludes pair", () => {
    expect(schema.marks.emphasis.excludes(schema.marks.muted)).toBe(true);
    expect(schema.marks.muted.excludes(schema.marks.emphasis)).toBe(true);
    expect(schema.marks.emphasis.excludes(schema.marks.highlight)).toBe(false);
  });
  it("underline (v2) is inclusive and layers freely — excludes nothing", () => {
    expect(schema.marks.underline.spec.inclusive).toBe(true);
    // Only a mark excludes itself by default; underline must not evict highlight/emphasis/muted.
    expect(schema.marks.underline.excludes(schema.marks.highlight)).toBe(false);
    expect(schema.marks.underline.excludes(schema.marks.emphasis)).toBe(false);
    expect(schema.marks.underline.excludes(schema.marks.muted)).toBe(false);
  });
  it("strong (v3) is inclusive and layers freely — excludes nothing", () => {
    expect(schema.marks.strong.spec.inclusive).toBe(true);
    expect(schema.marks.strong.excludes(schema.marks.highlight)).toBe(false);
    expect(schema.marks.strong.excludes(schema.marks.emphasis)).toBe(false);
    expect(schema.marks.strong.excludes(schema.marks.muted)).toBe(false);
    expect(schema.marks.strong.excludes(schema.marks.underline)).toBe(false);
  });
});

describe("conformance — accepts well-formed, REJECTS malformed", () => {
  it("accepts a well-formed doc", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.heading.create({ blockId: uuid(), level: "hat" }, schema.text("H")),
      buildCard({
        blockId: uuid(),
        tag: [schema.text("t")],
        cite: [schema.text("c")],
        body: [{ blockId: uuid(), content: [schema.text("b")] }],
      }),
      schema.nodes.paragraph.create({ blockId: uuid() }, schema.text("p")),
    ]);
    expect(() => doc.check()).not.toThrow();
  });

  it("rejects a card missing a required child (body)", () => {
    // Card content is now `tag body`; a card with ONLY a tag (no body) violates the content model.
    expect(() => {
      const card = schema.nodes.card.create({ blockId: uuid() }, [
        schema.nodes.tag.create(null, schema.text("t")),
      ]);
      card.check();
    }).toThrow();
  });

  // body is `paragraph+` — a card with ZERO body paragraphs violates the required `+` and is
  // rejected by check(). buildCard with body:[] deliberately constructs that rejected card.
  it("rejects a card with an EMPTY body (paragraph+ requires >=1)", () => {
    const card = buildCard({ blockId: uuid(), body: [] });
    expect(() => card.check()).toThrow();
  });

  it("accepts a card with >=1 body paragraph", () => {
    const card = buildCard({ blockId: uuid(), body: [{ blockId: uuid(), content: [schema.text("only")] }] });
    expect(() => card.check()).not.toThrow();
  });

  // a multi-paragraph body must survive toJSON/fromJSON identically — including a cite-MARKED run
  // (the v5 inline replacement for the old structural cite child).
  it("round-trips a multi-paragraph-body card (with a cite-marked run) via toJSON/fromJSON", () => {
    const card = buildCard({
      blockId: uuid(),
      tag: [schema.text("claim")],
      body: [
        // leading body paragraph carrying the source as an inline cite-marked run.
        { blockId: uuid(), content: [schema.text("Author 2020", [schema.marks.cite.create()])] },
        { blockId: uuid(), content: [schema.text("first para")] },
        { blockId: uuid(), content: [schema.text("second para")] },
      ],
    });
    expect(() => card.check()).not.toThrow();
    const round = Node.fromJSON(schema, card.toJSON());
    expect(round.eq(card)).toBe(true);
    // sanity: card children are now `tag body` (NO cite child) — body is the SECOND child (index 1).
    expect(round.childCount).toBe(2);
    expect(round.child(0).type.name).toBe("tag");
    const body = round.child(1);
    expect(body.type.name).toBe("body");
    expect(body.childCount).toBe(3);
    expect(body.child(0).type.name).toBe("paragraph");
    // the cite mark survived the round-trip on the leading body run.
    expect(body.child(0).firstChild!.marks.some((mk) => mk.type === schema.marks.cite)).toBe(true);
  });

  // teeth: the paragraph blockId default (null) is a generatability proxy only — a real
  // paragraph with a null or absent blockId is still rejected by check().
  it("rejects a paragraph with a null blockId (check throws)", () => {
    const p = schema.nodes.paragraph.create({ blockId: null }, schema.text("x"));
    expect(() => p.check()).toThrow();
  });
  it("rejects a paragraph with an absent blockId (default null => check throws)", () => {
    const p = schema.nodes.paragraph.create(null, schema.text("x")); // attr coerced to the null default
    expect(() => p.check()).toThrow();
  });

  // Note: prosemirror-model's `.create()` is permissive (it coerces a missing attr toward null);
  // the conformance teeth are in `.check()` / `Node.fromJSON`, which validate against the attr validators.
  it("rejects a block missing blockId (check throws)", () => {
    const p = schema.nodes.paragraph.create(null, schema.text("x")); // blockId coerced to null
    expect(() => p.check()).toThrow();
  });

  it("rejects a highlight missing color (check throws)", () => {
    const node = schema.nodes.paragraph.create(
      { blockId: "b1" },
      schema.text("x", [schema.marks.highlight.create()]),
    );
    expect(() => node.check()).toThrow();
  });

  it("rejects nodeFromJSON with missing blockId", () => {
    expect(() =>
      Node.fromJSON(schema, { type: "paragraph", content: [{ type: "text", text: "x" }] }),
    ).toThrow();
  });

  it("rejects nodeFromJSON with a highlight mark missing color", () => {
    expect(() =>
      Node.fromJSON(schema, {
        type: "paragraph",
        attrs: { blockId: "b1" },
        content: [{ type: "text", text: "x", marks: [{ type: "highlight" }] }],
      }),
    ).toThrow();
  });

  // Domain teeth (not just type teeth): out-of-set enum values are rejected by check()'s validators.
  it("rejects an out-of-set heading level (check throws)", () => {
    const h = schema.nodes.heading.create({ blockId: "b1", level: "GARBAGE" }, schema.text("x"));
    expect(() => h.check()).toThrow();
  });
  it("rejects an out-of-set highlight color (check throws)", () => {
    const node = schema.nodes.paragraph.create(
      { blockId: "b1" },
      schema.text("x", [schema.marks.highlight.create({ color: "PUCE" })]),
    );
    expect(() => node.check()).toThrow();
  });
});

// The excludes pair behaves differently for LOCAL edits vs a state assembled from an external source.
// A normalizer must reconcile a transient both-marks doc BEFORE it is validated, because check() rejects the
// both-marks state that fromJSON tolerates.
describe("emphasis<->muted excludes — local vs externally-assembled", () => {
  it("local editing cannot put both on one char (addToSet evicts the excluded mark)", () => {
    const set = schema.marks.muted.create().addToSet(schema.marks.emphasis.create().addToSet([]));
    expect(set.map((m) => m.type.name)).toEqual(["muted"]); // last applied wins
  });
  it("node.check() REJECTS a char carrying both (schema forbids the combo)", () => {
    const node = schema.nodes.paragraph.create({ blockId: "b" }, [
      schema.text("x", [schema.marks.emphasis.create(), schema.marks.muted.create()]),
    ]);
    expect(() => node.check()).toThrow();
  });
  it("Node.fromJSON TOLERATES both (the transient post-merge state the normalizer reconciles)", () => {
    const node = Node.fromJSON(schema, {
      type: "paragraph",
      attrs: { blockId: "b" },
      content: [{ type: "text", text: "x", marks: [{ type: "emphasis" }, { type: "muted" }] }],
    });
    expect(node.firstChild!.marks.map((m) => m.type.name).sort()).toEqual(["emphasis", "muted"]);
  });
});
