// _scan-utils.ts — shared heuristic-scan helpers for the source-scanning CI gates (e.g. the renderer-seam gate).
// Such gates each walk the source tree and strip block comments the same way; the two helpers here are the ONE
// implementation of each so a fix lands in all gates at once (the same shared-helper pattern as
// _schema-fingerprint.ts). Build/test-only (node:fs/path), never imported by src/ — never bundled.
//
// DELIBERATELY thin: each gate keeps its OWN per-file dispatch, line numbering, and reporting so its output stays
// byte-identical. These helpers only own (a) the directory walk and (b) the block-comment blanking — the parts
// that were verbatim-duplicated. Anything gate-specific (ext→scanner dispatch, line-comment stripping, per-file
// skips) stays in the caller.

import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

/** Options for {@link walkSourceFiles}. */
export interface WalkOptions {
  /** Extensions to KEEP (e.g. new Set([".ts", ".tsx"])). Matched against `extname(path)`. */
  readonly exts: ReadonlySet<string>;
  /** Directory basenames to NOT descend into (node_modules, dist, …). Empty/omitted ⇒ descend everywhere. */
  readonly skipDirs?: ReadonlySet<string>;
}

/**
 * Depth-first collect every file under `dir` whose extension is in `opts.exts`, skipping any directory whose
 * basename is in `opts.skipDirs`. Returns absolute paths in EXACT `readdirSync` traversal order — the same order
 * the three gates walked in before, so their accumulated problem/hit lists (and thus stdout) are byte-identical.
 * The per-file skip (e.g. a gate ignoring its own source) stays in the caller, applied to the returned list.
 */
export function walkSourceFiles(dir: string, opts: WalkOptions): string[] {
  const out: string[] = [];
  const skipDirs = opts.skipDirs ?? new Set<string>();
  const recurse = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        if (!skipDirs.has(name)) recurse(p);
      } else if (opts.exts.has(extname(p))) {
        out.push(p);
      }
    }
  };
  recurse(dir);
  return out;
}

/**
 * Blank out block comments — a `slash-star … star-slash` run — while PRESERVING newlines (each non-newline char
 * becomes a space), so a package name or class-like token mentioned in a comment cannot false-positive AND line
 * numbers stay accurate. This is only the block-comment half some gates share; a caller that also needs to drop
 * `//` line comments applies that itself (the line-comment strip is not universal — check-css's CSS path must keep
 * `//` since `//` is not a CSS comment). Identical regex to what the gates used inline.
 */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * Blank out single- and double-quoted STRING literals (each non-newline char → a space), so a token that appears
 * only inside a string cannot false-positive a content gate that matches tokens anywhere (not just in import
 * positions). `\\.` swallows escaped quotes; the char classes exclude newlines so an unterminated quote stops at
 * end-of-line instead of eating the rest of the file. Quoted strings nested inside a template (`` `x=${"y"}` ``)
 * are blanked too, while the template's `${…}` expression text is left intact for scanning. NOT stripped (rare,
 * documented bounds for callers): raw back-tick template TEXT and regex-literal bodies. Run AFTER {@link stripComments}
 * but BEFORE any `//` line-comment strip, so a `//` sitting inside a string (e.g. a URL) is gone before the line
 * strip runs and cannot delete real code after it.
 *
 * `keep` lists exact string CONTENTS (without quotes) to leave intact — for a gate that must still SEE a string
 * used as a property key, e.g. the `"flowline"` in `window["flowline"]`. Preserving such a token is safe anywhere
 * else because it only matters in a surrounding code shape the gate matches; a literal that merely CONTAINS the
 * token (`"flowline.theme"`) is not exact and is still blanked.
 */
export function blankStringLiterals(text: string, keep: ReadonlySet<string> = EMPTY_KEEP): string {
  return text.replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (m) =>
    keep.has(m.slice(1, -1)) ? m : m.replace(/[^\n]/g, " "),
  );
}
const EMPTY_KEEP: ReadonlySet<string> = new Set();
