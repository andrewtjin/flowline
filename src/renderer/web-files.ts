// renderer/web-files.ts — the WEB build's file save/open glue (E10b-S2/S3).
//
// The desktop app saves/opens `.fl` through the Electron MAIN process (native dialogs + node fs + the envelope
// codec). The WEB build has none of that, so this module provides the browser equivalent:
//   - SAVE: encode the doc to native `.fl` bytes (web-envelope) and write them, preferring the File System Access
//     API (`showSaveFilePicker` → a real Save dialog + a writable handle, so a later Save can overwrite the same
//     file with no re-prompt), falling back to a Blob download (an <a download>) when FSA is unavailable.
//   - OPEN: read a `.fl` file (FSA `showOpenFilePicker`, else a transient `<input type=file>`), decode + validate
//     it (the same typed-error contract as desktop), and hand back the doc JSON for the host to load.
//
// WEB-ONLY: every export here is reached only when `!window.flowline`. The byte format is identical to desktop
// (web-envelope shares envelope-frame), so a file saved here round-trips through desktop Open and vice-versa.
//
// A FileSystemFileHandle (when FSA is available) is returned so the host can remember it and overwrite-in-place on
// a subsequent plain Save — the web analogue of desktop's `currentPath`. The fallback path has no handle (a Blob
// download cannot be re-targeted), so a web Save without a handle always re-prompts, which is the correct,
// honest behaviour for a download-based environment.

import type { Node as PMNode } from "prosemirror-model";
import { encodeEnvelopeWeb, decodeEnvelopeWeb } from "../persistence/web-envelope";
import { docFromJson } from "../persistence/document";
import { EnvelopeError } from "../persistence/errors";

/** A successful open: the validated doc + a display name + the FSA handle (if any) so the host can save-in-place. */
export interface WebOpenOk {
  readonly ok: true;
  readonly doc: PMNode;
  readonly name: string;
  readonly handle: FileSystemFileHandle | null;
}
/** A failed/cancelled open. `canceled` is silent (user dismissed the picker); `message` is a real error to show. */
export interface WebOpenFail {
  readonly ok: false;
  readonly canceled?: boolean;
  readonly message?: string;
}
export type WebOpenResult = WebOpenOk | WebOpenFail;

/** A successful save: the chosen display name + the FSA handle (if any) for save-in-place next time. */
export interface WebSaveOk {
  readonly ok: true;
  readonly name: string;
  readonly handle: FileSystemFileHandle | null;
  /**
   * Set ONLY when a save that HELD a handle had to fall back to a Blob download because the user DENIED the
   * readwrite permission — the bytes went to a NEW file in Downloads, NOT the original. The caller surfaces an
   * honest "saved a copy to Downloads" message so the user isn't misled into thinking they overwrote the original.
   * Absent (undefined) on every other success (in-place overwrite, fresh picker save, or no-FSA download).
   */
  readonly downloadedFallback?: true;
}
export interface WebSaveFail {
  readonly ok: false;
  readonly canceled?: boolean;
  readonly message?: string;
}
export type WebSaveResult = WebSaveOk | WebSaveFail;

/** True iff the FSA save picker is available (Chromium). Drives the picker-vs-download branch. */
export function hasFileSystemAccess(): boolean {
  return typeof window !== "undefined" && typeof window.showSaveFilePicker === "function";
}

/** The picker filter for `.fl` files (FSA). A generic binary MIME keeps it neutral; the extension is what matters. */
const FL_PICKER_TYPES = [{ description: "Flowline document", accept: { "application/octet-stream": [".fl"] } }];

/** Does a thrown error look like a user-cancelled picker? FSA rejects with a DOMException named "AbortError". */
function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/**
 * Validate already-decoded payload JSON into a doc, mapping a typed EnvelopeError to a user-facing message and any
 * other throw to a generic one. Pure (no DOM, no IO) so the decode→validate cliff is unit-testable, mirroring the
 * desktop split where MAIN frames and the renderer validates with docFromJson.
 */
export function validateOpenedDoc(docJson: unknown): { ok: true; doc: PMNode } | { ok: false; message: string } {
  try {
    return { ok: true, doc: docFromJson(docJson) };
  } catch (err) {
    if (err instanceof EnvelopeError) return { ok: false, message: err.message };
    return { ok: false, message: "Could not open the file." };
  }
}

/**
 * Decode + validate raw `.fl` bytes into a doc. Async (web gzip is async). Any frame/payload error (typed
 * EnvelopeError) or doc-validation error becomes a `{ ok:false, message }`; a valid file becomes `{ ok:true, doc }`.
 * Factored from the picker so the whole byte→doc path is testable without a DOM file picker.
 */
export async function decodeFlBytes(bytes: Uint8Array): Promise<{ ok: true; doc: PMNode } | { ok: false; message: string }> {
  let docJson: unknown;
  try {
    ({ docJson } = await decodeEnvelopeWeb(bytes));
  } catch (err) {
    if (err instanceof EnvelopeError) return { ok: false, message: err.message };
    return { ok: false, message: "Could not open the file (it may be unreadable)." };
  }
  return validateOpenedDoc(docJson);
}

/**
 * Ensure we hold a readwrite grant on `handle` before writing to it, WITHOUT prompting more than necessary.
 * Chromium's File System Access consent ("…can see edits you make") is the BROWSER's own dialog around
 * `requestPermission`/`createWritable` — we cannot reword it, but we CAN keep it from re-firing spuriously:
 *   - `queryPermission` first: if the grant is already live ("granted"), write straight through — NO prompt.
 *   - only when it is not granted do we `requestPermission`, which is the one place the browser may consent-prompt.
 * Returns true iff we end up "granted". On a UA without these methods (the API is optional), assume granted and
 * let `createWritable` itself surface any real failure — exactly the prior behaviour, so nothing regresses there.
 */
async function ensureWritePermission(handle: FileSystemFileHandle): Promise<boolean> {
  if (typeof handle.queryPermission !== "function" || typeof handle.requestPermission !== "function") {
    return true; // permissions API absent → defer to createWritable (legacy behaviour, no extra prompt)
  }
  if ((await handle.queryPermission({ mode: "readwrite" })) === "granted") return true;
  return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
}

/** Trigger a Blob download of `bytes` as `filename` (the FSA fallback). Creates a transient <a download> + clicks. */
function downloadBytes(bytes: Uint8Array, filename: string): void {
  // Copy into a fresh ArrayBuffer-backed Uint8Array so the Blob never aliases a pooled buffer (Node Buffer / a
  // subarray view) — a defensive copy guarantees the exact bytes are what we hand to the Blob.
  const buf = new Uint8Array(bytes.length);
  buf.set(bytes);
  const blob = new Blob([buf], { type: "application/octet-stream" });
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
}

/**
 * Save `doc` as a `.fl` file on the WEB build. If `handle` is given (a prior FSA save/open of THIS doc) AND
 * `forceDialog` is false, overwrite that file in place with no prompt (plain Save). Otherwise prompt: FSA's
 * `showSaveFilePicker` when available (returning a handle for next time), else a Blob download (no handle).
 * `suggestedName` seeds the picker / download filename.
 */
export async function webSaveFl(
  doc: PMNode,
  opts: { handle?: FileSystemFileHandle | null; forceDialog?: boolean; suggestedName?: string },
): Promise<WebSaveResult> {
  const bytes = await encodeEnvelopeWeb(doc.toJSON());
  // Write a Blob (not the raw Uint8Array) to the FSA writable: a Blob copies the exact bytes and sidesteps the
  // `Uint8Array<ArrayBufferLike>` vs `ArrayBuffer` strictness in the writable's typed signature. Built once, reused
  // by either write path below.
  const blob = new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" });
  const suggestedName = opts.suggestedName && /\.fl$/i.test(opts.suggestedName) ? opts.suggestedName : `${opts.suggestedName ?? "Untitled"}.fl`;

  // Save-in-place: a known handle + a plain Save → overwrite, no prompt.
  //
  // DURABILITY — why no manual temp-file+rename here (cf. a node fs path that does atomic temp+rename).
  // `createWritable()` (default `keepExistingData:false`) does NOT truncate the
  // target file: Chromium's File System Access API writes to a browser-managed SWAP file and only ATOMICALLY moves
  // it onto the target when `close()` RESOLVES (per the FSA spec, the write operations are buffered and committed
  // on close). So the prior good `.fl` survives intact until a successful close; `keepExistingData` merely controls
  // whether the swap is seeded with the old bytes (irrelevant — we overwrite the whole file). A manual temp+rename
  // is not even expressible from a bare handle (we have no parent-directory handle from showSaveFilePicker).
  // The only safeguard we MUST get right is therefore: await BOTH write() and close(), let either throw propagate
  // to {ok:false}, and clear the in-memory `dirty` flag ONLY after this resolves ok (the caller in main.ts does
  // that — it returns before touching `dirty` on any non-ok result), so a failed save never reports success and
  // the in-memory copy of the doc is never lost.
  if (opts.handle && !opts.forceDialog) {
    const handle = opts.handle;
    try {
      // Gate the write on a live readwrite grant: queryPermission first (no prompt when already granted, so a
      // plain Ctrl+S after the first save NEVER re-consents), then requestPermission only if needed. If the grant
      // is ultimately DENIED, do NOT error — fall back to a Blob download so the user still gets their bytes, and
      // return `handle:null` so the caller drops the now-unusable handle (the next Save re-prompts honestly).
      if (!(await ensureWritePermission(handle))) {
        downloadBytes(bytes, suggestedName);
        // `downloadedFallback` flags that this success went to a NEW Downloads file, not the original the handle
        // pointed at — so the caller can tell the user the truth instead of implying an in-place overwrite.
        return { ok: true, name: suggestedName, handle: null, downloadedFallback: true };
      }
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close(); // commit point: the swap is atomically moved onto the target only once this resolves
      return { ok: true, name: handle.name, handle };
    } catch (err) {
      if (isAbort(err)) return { ok: false, canceled: true };
      return { ok: false, message: "Could not save the file." };
    }
  }

  // Prompt via FSA when available (gives us a reusable handle), else fall back to a one-shot download.
  if (hasFileSystemAccess()) {
    try {
      const handle = await window.showSaveFilePicker!({ suggestedName, types: FL_PICKER_TYPES });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close(); // commit point (see save-in-place note): target is written atomically on close()
      return { ok: true, name: handle.name, handle };
    } catch (err) {
      if (isAbort(err)) return { ok: false, canceled: true }; // user dismissed the dialog — silent
      return { ok: false, message: "Could not save the file." };
    }
  }

  // No FSA: a Blob download. There is no reusable handle, so a later Save re-prompts (i.e. re-downloads).
  downloadBytes(bytes, suggestedName);
  return { ok: true, name: suggestedName, handle: null };
}

/** Read a File's bytes as a Uint8Array (the FSA + <input> fallback share this). */
async function readFileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/** Open a `.fl` file via a transient `<input type=file>` (the FSA fallback). Resolves to the picked File, or null
 *  if the user dismissed the dialog. Cancel detection prefers the `<input type=file>` `cancel` event (supported in
 *  modern Chromium/Firefox/Safari — fires when the picker is dismissed with no selection); the focus-back timer is
 *  kept ONLY as a last-resort fallback for UAs lacking that event, with a long window so a slow-but-real selection
 *  is never misreported as a cancel (`change` always wins the race when a file is actually chosen). Every exit path
 *  (success, cancel, error) removes BOTH the focus listener AND the appended <input> so nothing leaks. */
function pickFileViaInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".fl";
    let settled = false;
    // The focus-back fallback fires after a long delay; if `cancel`/`change` already settled, this is a no-op.
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    // Declared up-front so finish() (any exit path) can detach it — avoids a leaked one-shot listener if the user
    // never refocuses the window after a `change`/`cancel` resolves first.
    const onFocus = (): void => {
      // Give a genuinely-slow selection time to deliver `change` before assuming a cancel. Long (2s) because this
      // is only the fallback for UAs without the `cancel` event; the `cancel` event (below) handles the common case.
      focusTimer = setTimeout(() => finish(null), 2000);
    };
    const finish = (file: File | null): void => {
      if (settled) return;
      settled = true;
      if (focusTimer !== undefined) clearTimeout(focusTimer);
      window.removeEventListener("focus", onFocus);
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => finish(input.files && input.files[0] ? input.files[0] : null));
    // Primary cancel signal: the standardized `cancel` event on <input type=file>, dispatched when the file picker
    // is dismissed without choosing a file. Reliable where supported; the focus heuristic remains as a fallback.
    input.addEventListener("cancel", () => finish(null));
    // Last-resort fallback for UAs without `cancel`: when the window refocuses (the picker closed) and no file has
    // arrived within the long window, treat it as a cancel. One-shot, defensive — `change`/`cancel` win the race.
    window.addEventListener("focus", onFocus, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Open a `.fl` file on the WEB build: read it (FSA picker when available — also yielding a save-in-place handle —
 * else an <input type=file>), decode + validate it, and return the doc. A user-dismissed picker is a silent
 * `{ ok:false, canceled:true }`; a corrupt/newer/invalid file is `{ ok:false, message }`.
 */
export async function webOpenFl(): Promise<WebOpenResult> {
  let bytes: Uint8Array;
  let name: string;
  let handle: FileSystemFileHandle | null = null;

  if (typeof window !== "undefined" && typeof window.showOpenFilePicker === "function") {
    try {
      const [picked] = await window.showOpenFilePicker({ types: FL_PICKER_TYPES, multiple: false });
      handle = picked;
      const file = await picked.getFile();
      name = file.name;
      bytes = await readFileBytes(file);
    } catch (err) {
      if (isAbort(err)) return { ok: false, canceled: true };
      return { ok: false, message: "Could not open the file." };
    }
  } else {
    const file = await pickFileViaInput();
    if (!file) return { ok: false, canceled: true }; // dismissed
    name = file.name;
    bytes = await readFileBytes(file);
  }

  const decoded = await decodeFlBytes(bytes);
  if (!decoded.ok) return { ok: false, message: decoded.message };
  return { ok: true, doc: decoded.doc, name, handle };
}
