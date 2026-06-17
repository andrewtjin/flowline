// todom.test.ts — deterministic, order-independent serialization + round-trip and ZERO NodeViews.
import { describe, it, expect } from "vitest";
import { DOMSerializer, DOMParser, Fragment } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { schema, buildCard } from "../src/schema";
import { buildViewProps } from "../src/editor";

const serializer = DOMSerializer.fromSchema(schema);
const parser = DOMParser.fromSchema(schema);

function html(fragment: Fragment): string {
  const dom = serializer.serializeFragment(fragment);
  const div = document.createElement("div");
  div.appendChild(dom);
  return div.innerHTML;
}

describe("mark order determinism", () => {
  // The determinism SOURCE: ProseMirror normalizes a mark set by schema rank at node-creation time,
  // so highlight (rank 0) is always first regardless of the order marks were applied. This asserts
  // that mechanism directly (not just that two equal inputs serialize equally).
  it("PM normalizes mark order by schema rank, highlight first", () => {
    const h = schema.marks.highlight.create({ color: "blue" });
    const e = schema.marks.emphasis.create();
    const applied1 = schema.text("w", [h, e]).marks.map((m) => m.type.name);
    const applied2 = schema.text("w", [e, h]).marks.map((m) => m.type.name);
    expect(applied1).toEqual(applied2);
    expect(applied1[0]).toBe("highlight"); // rank 0 => outermost
  });
  it("serialized HTML is identical regardless of mark application order", () => {
    const h = schema.marks.highlight.create({ color: "yellow" });
    const e = schema.marks.emphasis.create();
    expect(html(Fragment.from(schema.text("word", [h, e])))).toBe(html(Fragment.from(schema.text("word", [e, h]))));
  });
  it("highlight serializes OUTSIDE emphasis (locked order), with color as data-color", () => {
    const out = html(Fragment.from(schema.text("word", [schema.marks.emphasis.create(), schema.marks.highlight.create({ color: "green" })])));
    expect(out.indexOf("fl-highlight")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("fl-highlight")).toBeLessThan(out.indexOf("fl-emphasis"));
    expect(html(Fragment.from(schema.text("w", [schema.marks.highlight.create({ color: "blue" })])))).toContain('data-color="blue"');
  });
  // Both inner marks (emphasis|muted) matter. Pin the highlight+muted pair too, so a rank
  // regression that affected muted specifically would be caught.
  it("highlight serializes OUTSIDE muted, order-independently", () => {
    const a = html(Fragment.from(schema.text("word", [schema.marks.muted.create(), schema.marks.highlight.create({ color: "yellow" })])));
    const b = html(Fragment.from(schema.text("word", [schema.marks.highlight.create({ color: "yellow" }), schema.marks.muted.create()])));
    expect(a).toBe(b); // application order doesn't matter
    expect(a.indexOf("fl-highlight")).toBeGreaterThanOrEqual(0);
    expect(a.indexOf("fl-highlight")).toBeLessThan(a.indexOf("fl-muted"));
  });
  // underline (v2, rank 3) is innermost: highlight must still wrap a read+underlined span.
  it("underline serializes INSIDE highlight (innermost), order-independently", () => {
    const a = html(Fragment.from(schema.text("word", [schema.marks.underline.create(), schema.marks.highlight.create({ color: "blue" })])));
    const b = html(Fragment.from(schema.text("word", [schema.marks.highlight.create({ color: "blue" }), schema.marks.underline.create()])));
    expect(a).toBe(b);
    expect(a.indexOf("fl-highlight")).toBeLessThan(a.indexOf("fl-underline"));
  });
  // strong (v3, rank 4) is the INNERMOST mark: highlight wraps it, and it sits inside underline too.
  it("strong serializes INSIDE highlight and underline (innermost), order-independently", () => {
    const a = html(Fragment.from(schema.text("word", [schema.marks.strong.create(), schema.marks.highlight.create({ color: "blue" }), schema.marks.underline.create()])));
    const b = html(Fragment.from(schema.text("word", [schema.marks.underline.create(), schema.marks.highlight.create({ color: "blue" }), schema.marks.strong.create()])));
    expect(a).toBe(b);
    expect(a.indexOf("fl-highlight")).toBeLessThan(a.indexOf("fl-strong"));
    expect(a.indexOf("fl-underline")).toBeLessThan(a.indexOf("fl-strong"));
    expect(a).toContain("fl-strong");
  });
});

describe("parseDOM(toDOM(node)) round-trips", () => {
  it("round-trips a paragraph with blockId and marks", () => {
    const para = schema.nodes.paragraph.create({ blockId: "b1" }, [
      schema.text("plain "),
      schema.text("hot", [schema.marks.highlight.create({ color: "yellow" })]),
    ]);
    const div = document.createElement("div");
    div.appendChild(serializer.serializeNode(para));
    expect(parser.parse(div).firstChild!.eq(para)).toBe(true);
  });
  it("round-trips a full card (tag/cite/single-paragraph body)", () => {
    const card = buildCard({
      blockId: "c1",
      tag: [schema.text("claim")],
      cite: [schema.text("source")],
      body: [{ blockId: "bp1", content: [schema.text("quoted")] }],
    });
    const div = document.createElement("div");
    div.appendChild(serializer.serializeNode(card));
    expect(parser.parse(div).firstChild!.eq(card)).toBe(true);
  });
});

// a multi-paragraph body serializes to div.fl-body wrapping N paragraph divs and round-trips.
describe("multi-paragraph card body serialization", () => {
  it("body serializes to div.fl-body > N paragraph divs (each with its data-block-id)", () => {
    const card = buildCard({
      blockId: "c2",
      tag: [schema.text("t")],
      cite: [schema.text("c")],
      body: [
        { blockId: "p-a", content: [schema.text("alpha")] },
        { blockId: "p-b", content: [schema.text("beta")] },
      ],
    });
    const div = document.createElement("div");
    div.appendChild(serializer.serializeNode(card));
    const bodyEl = div.querySelector("div.fl-body")!;
    expect(bodyEl).toBeTruthy();
    const paras = bodyEl.querySelectorAll(":scope > div.fl-paragraph");
    expect(paras.length).toBe(2);
    expect(paras[0].getAttribute("data-block-id")).toBe("p-a");
    expect(paras[1].getAttribute("data-block-id")).toBe("p-b");
    expect(paras[0].textContent).toBe("alpha");
  });

  it("multi-paragraph body round-trips through parseDOM(toDOM())", () => {
    const card = buildCard({
      blockId: "c3",
      tag: [schema.text("tag")],
      cite: [schema.text("cite")],
      body: [
        { blockId: "rp-1", content: [schema.text("one")] },
        { blockId: "rp-2", content: [schema.text("two", [schema.marks.highlight.create({ color: "blue" })])] },
        { blockId: "rp-3", content: [schema.text("three")] },
      ],
    });
    const div = document.createElement("div");
    div.appendChild(serializer.serializeNode(card));
    expect(parser.parse(div).firstChild!.eq(card)).toBe(true);
  });
});

describe("ZERO NodeViews", () => {
  it("buildViewProps never registers nodeViews", () => {
    const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create({ blockId: "a" }, schema.text("x")));
    const props = buildViewProps(EditorState.create({ schema, doc }));
    expect("nodeViews" in props).toBe(false);
  });
});
