// structure-host.test.ts — the StructureHost predicate surface.
import { describe, it, expect } from "vitest";
import { structureHost } from "../src/structure-host";
import { schema } from "../src/schema";
import { SCHEMA_VERSION } from "../src/version";

const block = (type: string) =>
  type === "card"
    ? schema.nodes.card.create({ blockId: "u" }, [
        schema.nodes.tag.create(),
        schema.nodes.cite.create(),
        schema.nodes.body.create(),
      ])
    : type === "heading"
      ? schema.nodes.heading.create({ blockId: "u", level: "hat" }, schema.text("h"))
      : schema.nodes[type].create({ blockId: "u" }, schema.text("x"));

describe("StructureHost.structure", () => {
  it("unitIdOf reads blockId on every isolating block (incl. heading with its extra attr)", () => {
    for (const t of ["card", "analytic", "heading", "paragraph"]) {
      expect(structureHost.structure.unitIdOf(block(t)), `${t}`).toBe("u");
    }
  });
  it("unitIdOf is null for non-unit nodes (text, card children, hard_break)", () => {
    expect(structureHost.structure.unitIdOf(schema.text("x"))).toBeNull();
    expect(structureHost.structure.unitIdOf(schema.nodes.tag.create())).toBeNull();
    expect(structureHost.structure.unitIdOf(schema.nodes.cite.create())).toBeNull();
    expect(structureHost.structure.unitIdOf(schema.nodes.body.create())).toBeNull();
    expect(structureHost.structure.unitIdOf(schema.nodes.hard_break.create())).toBeNull();
  });
  it("isUnitBoundary: true for the 4 blocks, false for children/inline", () => {
    for (const t of ["card", "analytic", "heading", "paragraph"]) {
      expect(structureHost.structure.isUnitBoundary(block(t)), `${t} is boundary`).toBe(true);
    }
    for (const t of ["tag", "cite", "body"]) {
      expect(structureHost.structure.isUnitBoundary(schema.nodes[t].create()), `${t} not boundary`).toBe(false);
    }
    expect(structureHost.structure.isUnitBoundary(schema.text("x"))).toBe(false);
    expect(structureHost.structure.isUnitBoundary(schema.nodes.hard_break.create())).toBe(false);
  });
  it("newUnitId mints unique RFC-4122 v4 UUIDs", () => {
    const a = structureHost.structure.newUnitId();
    const b = structureHost.structure.newUnitId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("StructureHost.marks", () => {
  it("inclusive reflects edge-growth behavior", () => {
    expect(structureHost.marks.inclusive(schema.marks.highlight)).toBe(true);
    expect(structureHost.marks.inclusive(schema.marks.emphasis)).toBe(true);
    expect(structureHost.marks.inclusive(schema.marks.muted)).toBe(false);
  });
  it("sidecarAnchored is false for ALL marks", () => {
    for (const m of ["highlight", "emphasis", "muted"]) {
      expect(structureHost.marks.sidecarAnchored(schema.marks[m])).toBe(false);
    }
  });
});

describe("StructureHost.schemaVersion", () => {
  it("matches SCHEMA_VERSION", () => {
    expect(structureHost.schemaVersion).toBe(SCHEMA_VERSION);
  });
});
