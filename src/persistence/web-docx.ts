// persistence/web-docx.ts — the WEB build's Word export (E10b-S7).
//
// S7 decision: the `docx` library CAN bundle for the browser — its `Packer.toBlob` produces a real .docx Blob in
// the browser (the node lane uses `Packer.toBuffer`). The Flowline → docx mapping is the SHARED, fs-free
// `buildDocxDocument` (docx.ts); only the final pack step differs. So Export to Word is OFFERED on web (it is NOT
// hidden/disabled): the renderer builds the Document and downloads the packed Blob. The blue→cyan highlight remap
// and all style handling are identical to desktop because the IR + Document build are the same code.

import { Packer } from "docx";
import { buildDocxDocument } from "./docx";

/** Result of a web .docx export: the downloaded filename, or an error to surface. */
export type WebExportResult = { readonly ok: true; readonly name: string } | { readonly ok: false; readonly message: string };

/**
 * Export a Flowline doc (`doc.toJSON()`) to a `.docx` and DOWNLOAD it in the browser. `suggestedName` (without
 * the extension, or with — normalised) seeds the download filename. Async (Packer is async). On any pack failure,
 * returns `{ ok:false, message }` so the host can show an error rather than throwing into a click handler.
 */
export async function webExportDocx(docJson: unknown, suggestedName = "Untitled"): Promise<WebExportResult> {
  const base = suggestedName.replace(/\.(fl|docx)$/i, ""); // strip a .fl/.docx so we don't get "x.fl.docx"
  const filename = `${base || "Untitled"}.docx`;
  let blob: Blob;
  try {
    blob = await Packer.toBlob(buildDocxDocument(docJson));
  } catch {
    return { ok: false, message: "Could not export to Word." };
  }
  // Trigger a download via a transient <a download> (same pattern as the .fl Blob fallback in web-files.ts).
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a long delay (not the next tick): a slow UA may still be reading the blob URL to start the
  // download when a tick-0 revoke would yank it out from under the in-flight download. 10s is ample headroom.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { ok: true, name: filename };
}
