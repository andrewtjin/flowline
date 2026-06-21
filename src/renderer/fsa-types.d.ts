// renderer/fsa-types.d.ts — minimal ambient types for the File System Access API entry points the DOM lib lacks.
//
// TypeScript's bundled DOM lib (this project's target) already declares `FileSystemFileHandle` and
// `FileSystemWritableFileStream` (with `createWritable`/`getFile`), but it does NOT declare the picker ENTRY
// POINTS — `window.showSaveFilePicker` / `window.showOpenFilePicker` — nor their option bags. So we add ONLY those
// here (declaring the handle/stream types again would create conflicting duplicate definitions). Everything is
// OPTIONAL on Window: the web file code feature-detects (`typeof window.showSaveFilePicker === "function"`) and
// falls back to a Blob download / <input type=file> when absent (Firefox/Safari/older), so the types never assert
// the methods exist. This keeps us off a `@types/wicg-file-system-access` dependency for the tiny surface we touch.

interface FilePickerAcceptType {
  readonly description?: string;
  // A map of MIME type → allowed extensions (e.g. { "application/octet-stream": [".fl"] }).
  readonly accept: Record<string, string[]>;
}

interface SaveFilePickerOptions {
  readonly suggestedName?: string;
  readonly types?: FilePickerAcceptType[];
}

interface OpenFilePickerOptions {
  readonly types?: FilePickerAcceptType[];
  readonly multiple?: boolean;
}

interface Window {
  showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
  showOpenFilePicker?(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
}

// The FileSystemHandle permissions API (query/requestPermission) is NOT in the bundled DOM lib, but Chromium
// exposes it on every handle. The web save-in-place path calls it BEFORE createWritable to (a) avoid a spurious
// re-prompt when the handle is already granted, and (b) re-acquire (or gracefully fall back) when the grant has
// lapsed. Both are OPTIONAL so the feature-detect (`typeof handle.queryPermission === "function"`) stays honest
// on UAs lacking them. Augments the DOM-lib `FileSystemHandle` base interface (FileSystemFileHandle extends it).
type FileSystemPermissionState = "granted" | "denied" | "prompt";
interface FileSystemHandlePermissionDescriptor {
  readonly mode?: "read" | "readwrite";
}
interface FileSystemHandle {
  queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<FileSystemPermissionState>;
  requestPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<FileSystemPermissionState>;
}
