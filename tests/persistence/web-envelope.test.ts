// web-envelope.test.ts — the WEB (browser) `.fl` codec (web-envelope.ts) and its byte-format compatibility with
// the node codec (envelope.ts). E10b-S2/S3.
//
// Proves: (1) the web codec round-trips a doc deep-equal through its own encode→decode; (2) it is CROSS-COMPATIBLE
// with the node codec in BOTH directions (web-encode → node-decode and node-encode → web-decode) — i.e. a `.fl`
// saved on web opens on desktop and vice-versa, because both share the framing (envelope-frame.ts) and only differ
// in the gzip engine; (3) the same typed-error contract (EnvelopeError + kind) for corrupt/short/newer files; and
// (4) the v4→v5 migration runs through the web decode path too. jsdom + Node 24 both expose CompressionStream /
// crypto.randomUUID, so this runs headless with no browser.

import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import type { Node as PMNode } from "prosemirror-model";
import { schema, buildCard } from "../../src/schema";
import { createSeedDoc } from "../../src/seed";
import { SCHEMA_VERSION } from "../../src/version";
import { encodeEnvelope, decodeEnvelope } from "../../src/persistence/envelope";
import { encodeEnvelopeWeb, decodeEnvelopeWeb, EnvelopeError } from "../../src/persistence/web-envelope";
import { docFromJson } from "../../src/persistence/document";

const id = (): string => crypto.randomUUID();
const MAGIC = new Uint8Array([0x46, 0x4c, 0x4f, 0x57, 0x01]);
const okHeader = { formatVersion: 1, schemaVersion: SCHEMA_VERSION, payloadKind: "pm-json", compression: "gzip", appVersion: "0.0.0" };

/** Hand-frame an envelope with node gzip (to exercise version/corruption cells the web encoder never produces). */
function frame(header: object, payload: Uint8Array): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(5 + 4 + headerBytes.length + payload.length);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(5, headerBytes.length, true);
  out.set(headerBytes, 9);
  out.set(payload, 9 + headerBytes.length);
  return out;
}
const gzipDoc = (doc: PMNode): Uint8Array => gzipSync(new TextEncoder().encode(JSON.stringify(doc.toJSON())));

describe("web-envelope round-trip identity (S2/S3)", () => {
  it("round-trips the seed doc deep-equal through the WEB codec", async () => {
    const doc = createSeedDoc();
    const bytes = await encodeEnvelopeWeb(doc.toJSON());
    const { header, docJson } = await decodeEnvelopeWeb(bytes);
    expect(header.formatVersion).toBe(1);
    expect(header.schemaVersion).toBe(SCHEMA_VERSION);
    expect(header.payloadKind).toBe("pm-json");
    expect(header.compression).toBe("gzip");
    expect(docFromJson(docJson).eq(doc)).toBe(true);
  });

  it("round-trips empty paragraph / tag-only card / marks-laden run through the WEB codec", async () => {
    const allMarks = schema.text("loud", [
      schema.marks.strong.create(),
      schema.marks.underline.create(),
      schema.marks.emphasis.create(),
      schema.marks.highlight.create({ color: "green" }),
    ]);
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ blockId: id() }),
      buildCard({ blockId: id(), tag: [schema.text("t")], body: [{ blockId: id() }] }),
      schema.nodes.paragraph.create({ blockId: id() }, [allMarks]),
    ]);
    const { docJson } = await decodeEnvelopeWeb(await encodeEnvelopeWeb(doc.toJSON()));
    expect(docFromJson(docJson).eq(doc)).toBe(true);
  });

  it("preserves a 0-block (empty) doc through the WEB codec", async () => {
    const empty = schema.nodes.doc.create(null, []);
    const { docJson } = await decodeEnvelopeWeb(await encodeEnvelopeWeb(empty.toJSON()));
    const back = docFromJson(docJson);
    expect(back.childCount).toBe(0);
    expect(back.eq(empty)).toBe(true);
  });
});

describe("web↔node codec byte-format compatibility (a .fl saved on web opens on desktop and vice-versa)", () => {
  it("WEB-encode → NODE-decode round-trips deep-equal", async () => {
    const doc = createSeedDoc();
    const webBytes = await encodeEnvelopeWeb(doc.toJSON());
    const { header, docJson } = decodeEnvelope(webBytes); // node decoder reads web-written bytes
    expect(header.payloadKind).toBe("pm-json");
    expect(docFromJson(docJson).eq(doc)).toBe(true);
  });

  it("NODE-encode → WEB-decode round-trips deep-equal", async () => {
    const doc = createSeedDoc();
    const nodeBytes = encodeEnvelope(doc.toJSON());
    const { docJson } = await decodeEnvelopeWeb(nodeBytes); // web decoder reads node-written bytes
    expect(docFromJson(docJson).eq(doc)).toBe(true);
  });

  it("the two encoders agree on the FRAME (magic + header bytes) for the same doc", async () => {
    // The gzip OS-stamp byte may differ across engines, so the PAYLOAD bytes can diverge — but the magic and the
    // header JSON (identical fields) must match, proving both produce the same envelope SHAPE.
    const doc = createSeedDoc();
    const web = await encodeEnvelopeWeb(doc.toJSON());
    const node = encodeEnvelope(doc.toJSON());
    // Magic (first 5 bytes) identical.
    expect([...web.subarray(0, 5)]).toEqual([...node.subarray(0, 5)]);
    // Header length (uint32 LE at offset 5) + header bytes identical (same header fields → same JSON → same bytes).
    const webLen = new DataView(web.buffer, web.byteOffset).getUint32(5, true);
    const nodeLen = new DataView(node.buffer, node.byteOffset).getUint32(5, true);
    expect(webLen).toBe(nodeLen);
    expect([...web.subarray(9, 9 + webLen)]).toEqual([...node.subarray(9, 9 + nodeLen)]);
  });
});

/** Assert a web decode rejects with an EnvelopeError of a specific kind. */
async function expectKind(bytes: Uint8Array, kind: string): Promise<void> {
  await expect(decodeEnvelopeWeb(bytes)).rejects.toBeInstanceOf(EnvelopeError);
  try {
    await decodeEnvelopeWeb(bytes);
  } catch (err) {
    expect((err as EnvelopeError).kind).toBe(kind);
  }
}

describe("web-envelope typed open errors (same contract as node)", () => {
  const goodPayload = (): Uint8Array => gzipDoc(createSeedDoc());

  it("BadHeader for a buffer shorter than magic+len", async () => {
    await expectKind(new Uint8Array([0x46, 0x4c, 0x4f, 0x57]), "BadHeader");
  });
  it("BadMagic for the wrong magic", async () => {
    const wrong = frame(okHeader, goodPayload());
    wrong[0] = 0x58;
    await expectKind(wrong, "BadMagic");
  });
  it("BadPayload for a corrupt gzip payload", async () => {
    const corrupt = goodPayload();
    corrupt[corrupt.length - 1] ^= 0xff;
    await expectKind(frame(okHeader, corrupt), "BadPayload");
  });
  it("UnsupportedFormat for a newer formatVersion", async () => {
    await expectKind(frame({ ...okHeader, formatVersion: 2 }, goodPayload()), "UnsupportedFormat");
  });
  it("UnsupportedSchema for a newer schemaVersion", async () => {
    await expectKind(frame({ ...okHeader, schemaVersion: SCHEMA_VERSION + 1 }, goodPayload()), "UnsupportedSchema");
  });
  it("UnsupportedPayloadKind for a non-pm-json payload kind", async () => {
    await expectKind(frame({ ...okHeader, payloadKind: "future-binary" }, goodPayload()), "UnsupportedPayloadKind");
  });
  it("BadHeader for an unknown compression", async () => {
    await expectKind(frame({ ...okHeader, compression: "brotli" }, goodPayload()), "BadHeader");
  });
});

describe("web-envelope migrates an older schema (v4→v5) on decode", () => {
  it("a v4 card payload decodes via the WEB path with the cite node folded into a cite-marked body paragraph", async () => {
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
    const { docJson } = await decodeEnvelopeWeb(frame({ ...okHeader, schemaVersion: SCHEMA_VERSION - 1 }, v4Payload));
    const migratedDoc = docFromJson(docJson); // validates against the CURRENT schema
    const card = migratedDoc.child(0);
    expect(card.childCount).toBe(2); // tag + body (cite node gone)
    const body = card.child(1);
    const leadRun = body.child(0).firstChild!;
    expect(leadRun.text).toBe("Author 2020");
    expect(leadRun.marks.some((mk) => mk.type === schema.marks.cite)).toBe(true);
  });
});
