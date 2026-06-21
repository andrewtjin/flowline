// doc-registry.test.ts — the renderer-only in-window MDI registry (doc-registry.ts). E10b-S4 + F2/S-003.
//
// Proves the MDI state machine (New adds + activates; select switches; close removes + re-points; parked state is
// restored on switch) AND the load-bearing invariant F2/S-003: the registry NEVER enters doc.toJSON() — the
// persisted bytes for a doc are byte-identical whether 0 or N other docs are open. No DOM: the registry is pure
// state over EditorStates, so this runs headless.

import { describe, it, expect } from "vitest";
import { EditorState } from "prosemirror-state";
import { schema } from "../../src/schema";
import { createSeedDoc } from "../../src/seed";
import { createDocRegistry } from "../../src/renderer/doc-registry";
import { encodeEnvelopeWeb } from "../../src/persistence/web-envelope";

const id = (): string => crypto.randomUUID();
// A doc with a recognizable single paragraph of `text`, so we can tell parked docs apart by content.
const docWith = (text: string) =>
  schema.nodes.doc.create(null, [schema.nodes.paragraph.create({ blockId: id() }, schema.text(text))]);
const stateOf = (text: string): EditorState => EditorState.create({ schema, doc: docWith(text) });

// A deterministic id minter so tests can address entries by a stable id ("d0", "d1", …) instead of random UUIDs.
function counterMinter(): () => string {
  let n = 0;
  return () => `d${n++}`;
}

describe("doc-registry — the MDI state machine (S4)", () => {
  it("starts empty; add makes the new doc active and returns its id", () => {
    const reg = createDocRegistry(counterMinter());
    expect(reg.size()).toBe(0);
    expect(reg.active()).toBeNull();
    const idA = reg.add(stateOf("A"), null);
    expect(idA).toBe("d0");
    expect(reg.size()).toBe(1);
    expect(reg.activeId()).toBe("d0");
    expect(reg.active()!.state.doc.textContent).toBe("A");
  });

  it("New retains the prior doc in the list and makes the new one active (the S4 retain rule)", () => {
    const reg = createDocRegistry(counterMinter());
    reg.add(stateOf("first"), "first.fl");
    reg.add(stateOf("second"), null); // a second "New"
    expect(reg.size()).toBe(2); // the first doc is RETAINED
    expect(reg.activeId()).toBe("d1"); // the new one is active
    expect(reg.list().map((d) => d.title)).toEqual(["first.fl", "Untitled"]);
    expect(reg.list().map((d) => d.active)).toEqual([false, true]);
  });

  it("select switches the active doc and restores its parked state", () => {
    const reg = createDocRegistry(counterMinter());
    reg.add(stateOf("A"), null); // d0
    reg.add(stateOf("B"), null); // d1 (active)
    expect(reg.select("d0")).toBe(true);
    expect(reg.activeId()).toBe("d0");
    expect(reg.active()!.state.doc.textContent).toBe("A"); // d0's parked doc restored
    expect(reg.select("d0")).toBe(false); // already active → no switch
    expect(reg.select("nope")).toBe(false); // unknown id → no switch
  });

  it("syncActiveState parks the active doc's latest edits (switch-away keeps them)", () => {
    const reg = createDocRegistry(counterMinter());
    reg.add(stateOf("A"), null); // d0
    reg.add(stateOf("B"), null); // d1 active
    // Edit d1's parked state (as the dispatch seam would on every keystroke), then switch away + back.
    reg.syncActiveState(stateOf("B-edited"));
    reg.select("d0");
    reg.select("d1");
    expect(reg.active()!.state.doc.textContent).toBe("B-edited");
  });

  it("close removes a doc and returns the now-active doc's id (active neighbour)", () => {
    const reg = createDocRegistry(counterMinter());
    reg.add(stateOf("A"), null); // d0
    reg.add(stateOf("B"), null); // d1
    reg.add(stateOf("C"), null); // d2 active
    // Close the active (d2) → activate the previous neighbour (d1).
    expect(reg.close("d2")).toBe("d1");
    expect(reg.activeId()).toBe("d1");
    expect(reg.size()).toBe(2);
  });

  it("closing a doc BEFORE the active one keeps the SAME doc active (index shifts, not the selection)", () => {
    const reg = createDocRegistry(counterMinter());
    reg.add(stateOf("A"), null); // d0
    reg.add(stateOf("B"), null); // d1
    reg.add(stateOf("C"), null); // d2 active
    reg.select("d2");
    expect(reg.close("d0")).toBe("d2"); // still d2 active, just shifted left in the list
    expect(reg.activeId()).toBe("d2");
    expect(reg.list().map((d) => d.title)).toEqual(["Untitled", "Untitled"]); // B, C remain
    expect(reg.active()!.state.doc.textContent).toBe("C");
  });

  it("closing the LAST doc empties the registry (returns null) so the host can seed a fresh one", () => {
    const reg = createDocRegistry(counterMinter());
    reg.add(stateOf("only"), null);
    expect(reg.close("d0")).toBeNull();
    expect(reg.size()).toBe(0);
    expect(reg.activeId()).toBeNull();
  });

  it("title derives from the path base name (handles \\ and /), or Untitled; dirty + active reflected in list()", () => {
    const reg = createDocRegistry(counterMinter());
    reg.add(stateOf("A"), "C:\\docs\\speech.fl");
    reg.add(stateOf("B"), "/home/u/case.fl");
    reg.setActiveDirty(true);
    const list = reg.list();
    expect(list.map((d) => d.title)).toEqual(["speech.fl", "case.fl"]);
    expect(list[1].dirty).toBe(true);
    expect(list[1].active).toBe(true);
  });

  it("setActivePath / setActiveDirty update only the active entry", () => {
    const reg = createDocRegistry(counterMinter());
    reg.add(stateOf("A"), null); // d0
    reg.add(stateOf("B"), null); // d1 active
    reg.setActivePath("saved.fl");
    reg.setActiveDirty(false);
    expect(reg.list()[0].path).toBeNull(); // d0 untouched
    expect(reg.list()[1].path).toBe("saved.fl"); // d1 updated
  });
});

describe("F2 / S-003 — the registry NEVER enters doc.toJSON() (byte-for-byte equality guarantee)", () => {
  it("a doc's toJSON() — and the encoded .fl bytes — are IDENTICAL with 0 vs N other docs open", async () => {
    // Build the target doc once and capture its JSON when it is the ONLY doc in the registry.
    const reg0 = createDocRegistry(counterMinter());
    const target = createSeedDoc();
    reg0.add(EditorState.create({ schema, doc: target }), "target.fl");
    const jsonAlone = JSON.stringify(reg0.active()!.state.doc.toJSON());

    // Now open the SAME doc with several other docs before AND after it, switching around, dirtying others, etc.
    const regN = createDocRegistry(counterMinter());
    regN.add(stateOf("before-1"), "b1.fl");
    regN.add(stateOf("before-2"), null);
    regN.add(EditorState.create({ schema, doc: target }), "target.fl"); // the SAME doc content
    const targetId = regN.activeId()!;
    regN.add(stateOf("after-1"), "a1.fl");
    regN.setActiveDirty(true); // dirty a DIFFERENT doc
    regN.select("before-1");
    regN.syncActiveState(stateOf("before-1-edited")); // edit a DIFFERENT doc
    regN.select(targetId); // back to the target

    const jsonWithOthers = JSON.stringify(regN.active()!.state.doc.toJSON());
    // The persisted content of the target is byte-identical regardless of the registry around it.
    expect(jsonWithOthers).toBe(jsonAlone);

    // STRONGER (FIX 5): the report claims "persisted bytes identical", so prove it at the byte level — run the doc
    // through the SAME production web encoder the save path calls (encodeEnvelopeWeb → frame + gzipped payload) and
    // assert the actual `.fl` envelope bytes are identical with 0 vs N other docs open. The frame header is
    // deterministic (no timestamp/random) and the gzip engine (CompressionStream) is deterministic within a run, so
    // identical input JSON ⇒ identical bytes; any registry-induced divergence in the doc would change them.
    const bytesAlone = await encodeEnvelopeWeb(reg0.active()!.state.doc.toJSON());
    const bytesWithOthers = await encodeEnvelopeWeb(regN.active()!.state.doc.toJSON());
    expect(Array.from(bytesWithOthers)).toEqual(Array.from(bytesAlone));
  });

  it("the persisted bytes for a doc do not depend on registry ordering or active index", () => {
    // Two registries with the same target doc but different surrounding docs / active positions → same target JSON.
    const target = createSeedDoc();
    const targetJson = JSON.stringify(target.toJSON());

    const regA = createDocRegistry(counterMinter());
    regA.add(EditorState.create({ schema, doc: target }), null);
    expect(JSON.stringify(regA.active()!.state.doc.toJSON())).toBe(targetJson);

    const regB = createDocRegistry(counterMinter());
    regB.add(stateOf("x"), null);
    regB.add(EditorState.create({ schema, doc: target }), null);
    regB.add(stateOf("y"), null); // target is now NOT the active/last doc
    regB.select(regB.list()[1].id); // re-activate the target
    expect(JSON.stringify(regB.active()!.state.doc.toJSON())).toBe(targetJson);
  });
});
