// envelope.test.ts — native save→reopen identity + typed open errors.
//
// Asserts the DECODE CONTRACT (deep-equal via doc.eq + header fields), never golden bytes (gzip stamps a
// platform OS byte → cross-OS byte-instability). Drives the full version-skew / corruption / Buffer-agnostic
// matrix, plus the doc-validation cliff (docFromJson) that nodeFromJSON alone misses.

import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Node as PMNode } from "prosemirror-model";
import { schema, buildCard } from "../src/schema";
import { createSeedDoc } from "../src/seed";
import { SCHEMA_VERSION } from "../src/version";
import { encodeEnvelope, decodeEnvelope, EnvelopeError, MAX_DOC_BYTES } from "../src/persistence/envelope";
import { docFromJson } from "../src/persistence/document";

const id = (): string => crypto.randomUUID();
const MAGIC = new Uint8Array([0x46, 0x4c, 0x4f, 0x57, 0x01]);

/** Hand-frame an envelope (to exercise framing/version/compression cells encode never produces). */
function frame(header: object, payload: Uint8Array, headerLenOverride?: number): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(5 + 4 + headerBytes.length + payload.length);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(5, headerLenOverride ?? headerBytes.length, true);
  out.set(headerBytes, 9);
  out.set(payload, 9 + headerBytes.length);
  return out;
}
/** Frame an envelope with RAW header bytes (to express a header that is JSON null / a primitive / an array). */
function frameRaw(headerText: string, payload: Uint8Array): Uint8Array {
  const headerBytes = new TextEncoder().encode(headerText);
  const out = new Uint8Array(5 + 4 + headerBytes.length + payload.length);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(5, headerBytes.length, true);
  out.set(headerBytes, 9);
  out.set(payload, 9 + headerBytes.length);
  return out;
}
const okHeader = { formatVersion: 1, schemaVersion: SCHEMA_VERSION, payloadKind: "pm-json", compression: "gzip", appVersion: "0.0.0" };
const gzipDoc = (doc: PMNode): Uint8Array => gzipSync(new TextEncoder().encode(JSON.stringify(doc.toJSON())));

/** Round-trip a doc and assert PM-level identity + correct header fields. */
function roundTrip(doc: PMNode): void {
  const bytes = encodeEnvelope(doc.toJSON());
  const { header, docJson } = decodeEnvelope(bytes);
  expect(header.formatVersion).toBe(1);
  expect(header.schemaVersion).toBe(SCHEMA_VERSION);
  expect(header.payloadKind).toBe("pm-json");
  expect(header.compression).toBe("gzip");
  expect(docFromJson(docJson).eq(doc)).toBe(true); // deep-equal via doc.eq, NOT JSON-string equality
}

describe("envelope round-trip identity", () => {
  it("round-trips the seed doc deep-equal", () => {
    roundTrip(createSeedDoc());
  });

  it("round-trips empty paragraph / tag-only card / empty body paragraph", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ blockId: id() }), // empty paragraph (no content key in JSON)
      // Card is now `tag body` (no cite child in v5); an empty-but-valid body paragraph.
      buildCard({ blockId: id(), tag: [schema.text("t")], body: [{ blockId: id() }] }),
    ]);
    roundTrip(doc);
  });

  it("round-trips a run carrying every layerable mark applied in REVERSED order", () => {
    // emphasis excludes muted, so the 'all marks' run uses highlight+emphasis+underline+strong; muted gets its
    // own run. Applied in reverse of the locked render order — toJSON normalises order, so doc.eq still holds.
    const allMarks = schema.text("loud", [
      schema.marks.strong.create(),
      schema.marks.underline.create(),
      schema.marks.emphasis.create(),
      schema.marks.highlight.create({ color: "green" }),
    ]);
    const mutedRun = schema.text(" quiet", [schema.marks.muted.create()]);
    const doc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create({ blockId: id() }, [allMarks, mutedRun])]);
    roundTrip(doc);
  });

  it("encode is deterministic within one process (same doc → identical bytes)", () => {
    const doc = createSeedDoc();
    expect(Buffer.from(encodeEnvelope(doc.toJSON())).equals(Buffer.from(encodeEnvelope(doc.toJSON())))).toBe(true);
  });

  it("round-trips a 0-block (empty) doc deep-equal (childCount stays 0)", () => {
    const empty = schema.nodes.doc.create(null, []);
    const { docJson } = decodeEnvelope(encodeEnvelope(empty.toJSON()));
    const back = docFromJson(docJson);
    expect(back.childCount).toBe(0);
    expect(back.eq(empty)).toBe(true); // codec preserves emptiness; the renderer's loadDoc reseeds it for usability
  });

  it("survives a real file write→read round-trip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flowline-"));
    try {
      const file = join(dir, "speech.fl");
      const doc = createSeedDoc();
      await writeFile(file, encodeEnvelope(doc.toJSON()));
      const { docJson } = decodeEnvelope(await readFile(file));
      expect(docFromJson(docJson).eq(doc)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("envelope is Buffer-agnostic + byte-offset safe (IPC realism)", () => {
  it("decodes a structuredClone (plain Uint8Array, not a Buffer)", () => {
    const seed = createSeedDoc(); // ONE instance — createSeedDoc mints fresh random blockIds each call
    const cloned = structuredClone(encodeEnvelope(seed.toJSON()));
    expect(ArrayBuffer.isView(cloned)).toBe(true); // a typed-array view (instanceof can fail cross-realm)
    const { docJson } = decodeEnvelope(cloned);
    expect(docFromJson(docJson).eq(seed)).toBe(true);
  });

  it("decodes a view at a NON-zero byteOffset of a larger buffer", () => {
    const seed = createSeedDoc();
    const env = encodeEnvelope(seed.toJSON());
    const padded = new Uint8Array(env.length + 7);
    padded.set(env, 7); // shift the envelope 7 bytes into a bigger buffer
    const view = padded.subarray(7); // byteOffset 7, same underlying ArrayBuffer
    expect(view.byteOffset).toBe(7);
    const { docJson } = decodeEnvelope(view);
    expect(docFromJson(docJson).eq(seed)).toBe(true);
  });

  it("honours a multibyte UTF-8 header field via BYTE length framing", () => {
    const doc = createSeedDoc();
    // A multibyte appVersion: string length != byte length. Correct (byte-length) framing must round-trip.
    const good = frame({ ...okHeader, appVersion: "1.0-β★" }, gzipDoc(doc));
    const { header, docJson } = decodeEnvelope(good);
    expect(header.appVersion).toBe("1.0-β★");
    expect(docFromJson(docJson).eq(doc)).toBe(true);
    // If the length were the STRING length (too small), the frame desyncs → a decode error, never a silent misread.
    const strLen = JSON.stringify({ ...okHeader, appVersion: "1.0-β★" }).length; // chars, < byte length
    expect(() => decodeEnvelope(frame({ ...okHeader, appVersion: "1.0-β★" }, gzipDoc(doc), strLen))).toThrow(EnvelopeError);
  });
});

/** Assert a decode throws an EnvelopeError of a specific kind. */
function expectKind(bytes: Uint8Array, kind: string): void {
  try {
    decodeEnvelope(bytes);
    expect.unreachable("decode should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(EnvelopeError);
    expect((err as EnvelopeError).kind).toBe(kind);
  }
}

describe("envelope typed open errors", () => {
  const goodPayload = (): Uint8Array => gzipDoc(createSeedDoc());

  it("BadHeader for a buffer shorter than magic+len (4 bytes)", () => {
    expectKind(new Uint8Array([0x46, 0x4c, 0x4f, 0x57]), "BadHeader");
  });
  it("BadMagic for the wrong magic", () => {
    const wrong = frame(okHeader, goodPayload());
    wrong[0] = 0x58; // 'X' — corrupt the first magic byte
    expectKind(wrong, "BadMagic");
  });
  it("BadHeader when the header length exceeds the file size (0xFFFFFFFF)", () => {
    expectKind(frame(okHeader, goodPayload(), 0xffffffff), "BadHeader");
  });
  it("BadHeader when the header length points into the payload (unparseable header JSON)", () => {
    expectKind(frame(okHeader, goodPayload(), new TextEncoder().encode(JSON.stringify(okHeader)).length + 20), "BadHeader");
  });
  it("BadPayload for a corrupt gzip payload", () => {
    const corrupt = goodPayload();
    corrupt[corrupt.length - 1] ^= 0xff; // flip the last byte
    expectKind(frame(okHeader, corrupt), "BadPayload");
  });
  it("BadPayload when the payload decompresses to invalid JSON", () => {
    expectKind(frame(okHeader, gzipSync(new TextEncoder().encode("{not json"))), "BadPayload");
  });
  it("BadHeader (typed, not a raw TypeError) for a header that is JSON null / a primitive / an array", () => {
    for (const raw of ["null", "5", '"x"', "[]"]) expectKind(frameRaw(raw, goodPayload()), "BadHeader");
  });
  it("BadPayload (bounded — no OOM) for a gzip bomb that decompresses past the size cap", () => {
    const bomb = gzipSync(new Uint8Array(MAX_DOC_BYTES + 1024)); // zeros: tiny compressed, > cap inflated
    expectKind(frame(okHeader, bomb), "BadPayload");
  });

  it("UnsupportedFormat for a newer formatVersion", () => {
    expectKind(frame({ ...okHeader, formatVersion: 2 }, goodPayload()), "UnsupportedFormat");
  });
  it("UnsupportedSchema for a newer schemaVersion", () => {
    expectKind(frame({ ...okHeader, schemaVersion: SCHEMA_VERSION + 1 }, goodPayload()), "UnsupportedSchema");
  });
  it("MIGRATES an older (v4) schemaVersion: the cite NODE folds into a cite-marked leading body paragraph", () => {
    // A v4-shaped payload: a card with the OLD `[tag, cite, body]` structure. Decode must now SUCCEED (the
    // v4→v5 migration runs), returning a migrated docJson whose card is `[tag, body]` with the cite content
    // folded into a leading body paragraph carrying the inline `cite` mark.
    const v4Doc = {
      type: "doc",
      content: [
        {
          type: "card",
          attrs: { blockId: id() },
          content: [
            { type: "tag", content: [{ type: "text", text: "claim" }] },
            { type: "cite", content: [{ type: "text", text: "Author 2020" }] },
            { type: "body", content: [{ type: "paragraph", attrs: { blockId: id() }, content: [{ type: "text", text: "evidence" }] }] },
          ],
        },
      ],
    };
    const v4Payload = gzipSync(new TextEncoder().encode(JSON.stringify(v4Doc)));
    const { header, docJson } = decodeEnvelope(frame({ ...okHeader, schemaVersion: SCHEMA_VERSION - 1 }, v4Payload));
    expect(header.schemaVersion).toBe(SCHEMA_VERSION - 1); // header stays as-saved; payload was up-migrated

    // The migrated card is `[tag, body]` (cite NODE gone) and validates against the CURRENT schema.
    const migratedCard = (docJson as { content: { type: string; content: { type: string }[] }[] }).content[0];
    expect(migratedCard.content.map((c) => c.type)).toEqual(["tag", "body"]);
    const migratedDoc = docFromJson(docJson); // nodeFromJSON + check() — proves the migrated tree is valid
    const card = migratedDoc.child(0);
    expect(card.childCount).toBe(2); // tag + body, no cite child
    const body = card.child(1);
    expect(body.type.name).toBe("body");
    // the cite content became a LEADING body paragraph whose run carries the inline cite mark.
    const leadRun = body.child(0).firstChild!;
    expect(leadRun.text).toBe("Author 2020");
    expect(leadRun.marks.some((mk) => mk.type === schema.marks.cite)).toBe(true);
    // the original evidence paragraph follows it.
    expect(body.child(1).textContent).toBe("evidence");
  });
  it("UnsupportedPayloadKind for a non-pm-json payload kind", () => {
    expectKind(frame({ ...okHeader, payloadKind: "future-binary" }, goodPayload()), "UnsupportedPayloadKind");
  });
  it("BadHeader for an unknown compression", () => {
    expectKind(frame({ ...okHeader, compression: "brotli" }, goodPayload()), "BadHeader");
  });

  it('honours compression:"none" (no gunzip)', () => {
    const seed = createSeedDoc();
    const raw = new TextEncoder().encode(JSON.stringify(seed.toJSON()));
    const { docJson } = decodeEnvelope(frame({ ...okHeader, compression: "none" }, raw));
    expect(docFromJson(docJson).eq(seed)).toBe(true);
  });
});

describe("document validation: docFromJson is the real cliff", () => {
  it("BadDocument when the root is not a `doc`", () => {
    expect(() => docFromJson({ type: "paragraph", attrs: { blockId: "b1" } })).toThrow(EnvelopeError);
    try {
      docFromJson({ type: "paragraph", attrs: { blockId: "b1" } });
    } catch (e) {
      expect((e as EnvelopeError).kind).toBe("BadDocument");
    }
  });

  it("BadDocument for an excludes-violating emphasis+muted run (nodeFromJSON tolerates, check() rejects)", () => {
    const both = {
      type: "doc",
      content: [
        { type: "paragraph", attrs: { blockId: "b1" }, content: [{ type: "text", text: "x", marks: [{ type: "emphasis" }, { type: "muted" }] }] },
      ],
    };
    try {
      docFromJson(both);
      expect.unreachable("a both-marks doc must be rejected by check()");
    } catch (e) {
      expect(e).toBeInstanceOf(EnvelopeError);
      expect((e as EnvelopeError).kind).toBe("BadDocument");
    }
  });

  it("BadDocument for a card missing a required child", () => {
    const bad = { type: "doc", content: [{ type: "card", attrs: { blockId: "b1" }, content: [{ type: "tag" }] }] };
    expect(() => docFromJson(bad)).toThrow(EnvelopeError);
  });

  it("accepts a valid doc and returns a deep-equal node", () => {
    const doc = createSeedDoc();
    expect(docFromJson(doc.toJSON()).eq(doc)).toBe(true);
  });
});
