// web-docx.test.ts — the WEB Word export (web-docx.ts). E10b-S7.
//
// S7 decision (PROVEN here): the `docx` library bundles for the browser via Packer.toBlob, so Export to Word is
// OFFERED on web (not hidden/disabled). This proves the web export produces a REAL, non-empty .docx Blob built
// from the SAME shared Document builder as desktop — we unzip the Blob and assert word/document.xml has real
// content (a PK-magic-only check would pass on an empty doc). jsdom provides Blob/URL; we read the Blob's bytes
// directly (no actual download) and feed them to JSZip, mirroring tests/docx.test.ts.

import { describe, it, expect, vi, afterEach } from "vitest";
import JSZip from "jszip";
import { schema } from "../../src/schema";
import { createSeedDoc } from "../../src/seed";
import { webExportDocx } from "../../src/persistence/web-docx";

const id = (): string => crypto.randomUUID();

afterEach(() => vi.restoreAllMocks());

/** Read the .docx bytes that webExportDocx packed, by intercepting URL.createObjectURL to capture the Blob. */
async function capturePackedDocx(docJson: unknown, name?: string): Promise<{ result: Awaited<ReturnType<typeof webExportDocx>>; bytes: Uint8Array }> {
  let captured: Blob | null = null;
  // jsdom's URL.createObjectURL throws/returns nothing useful; stub it to capture the Blob and hand back a fake url.
  vi.spyOn(URL, "createObjectURL").mockImplementation((obj: Blob | MediaSource) => {
    captured = obj as Blob;
    return "blob:fake";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const result = await webExportDocx(docJson, name);
  const bytes = captured ? new Uint8Array(await (captured as Blob).arrayBuffer()) : new Uint8Array(0);
  return { result, bytes };
}

describe("web docx export (S7 — docx bundles for the browser)", () => {
  it("downloads a valid ZIP (PK magic) for the seed", async () => {
    const { result, bytes } = await capturePackedDocx(createSeedDoc().toJSON());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.name).toBe("Untitled.docx");
    expect(bytes[0]).toBe(0x50); // 'P'
    expect(bytes[1]).toBe(0x4b); // 'K'
  });

  it("packs a non-empty document.xml with real text (catches the empty-sections bug)", async () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.heading.create({ blockId: id(), level: "pocket" }, schema.text("TITLE")),
      schema.nodes.paragraph.create({ blockId: id() }, [schema.text("hello world")]),
    ]);
    const { bytes } = await capturePackedDocx(doc.toJSON());
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain("TITLE");
    expect(xml).toContain("hello world");
  });

  it("derives the download filename from the suggested name, stripping a .fl/.docx", async () => {
    const { result: r1 } = await capturePackedDocx(createSeedDoc().toJSON(), "speech.fl");
    if (r1.ok) expect(r1.name).toBe("speech.docx");
    const { result: r2 } = await capturePackedDocx(createSeedDoc().toJSON(), "case.docx");
    if (r2.ok) expect(r2.name).toBe("case.docx");
  });
});
