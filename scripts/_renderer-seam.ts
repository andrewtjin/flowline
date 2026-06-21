// _renderer-seam.ts — PURE detector for the EditorHost platform-seam gate (makes the §S6 grep invariant durable).
//
// WHY THIS EXISTS. The EditorHost refactor collapsed the scattered platform branching
//   `const isWeb = !window.flowline`  →  ONE platform decision, taken once at the composition root
//   (`src/renderer/main.ts`: `const bridge = window.flowline` → `resolveHost(bridge)`). After that single read,
// EVERY platform capability flows through `host` / `shell`. The seam discipline IS the refactor's point, so it
// must not silently rot back: no renderer module OUTSIDE `src/renderer/host/` may
//   (1) reintroduce an `isWeb` predicate — the deleted platform branch; or
//   (2) reach a capability THROUGH the preload bridge. "Reaching through" covers, however spelled:
//        - the bridge ref:   window.flowline · window?.flowline · window["flowline"] · self.flowline · top.flowline
//                            · globalThis.flowline  (all reference the one global `flowline` the preload exposes);
//        - the access:        a member after it — `.x` / `?.x` / `!.x` / `["x"]`, including across an erased
//                            `as`/`satisfies` cast (`(window.flowline as T).x()` ≡ `window.flowline.x()` at runtime);
//        - or destructuring:  `const { exportDocx } = window.flowline` (pulling N capabilities into renderer scope).
// The lone BARE read `const bridge = window.flowline` (a single-identifier value handoff, optionally cast) and
// existence checks (`!window.flowline`, `if (window.flowline)`, passing it as an arg) stay legal — that bare read
// IS the composition root the seam is built around.
//
// `src/renderer/host/` is EXEMPT (the seam's INSIDE): `DesktopHost` forwards 1:1 to `window.flowline` and
// `resolveHost` reads it to choose the platform. This detector is pure (string → findings); the filesystem walk +
// reporting + `process.exit` live in `check-renderer-seam.ts`, which calls this. Splitting the logic out (the same
// pattern as `_schema-fingerprint.ts`) lets `tests/renderer-seam.test.ts` exercise the rules hermetically.
//
// HEURISTIC, by design — a string scan over comment- AND string-literal-blanked source (the same deliberate
// class as the project's other source-scanning CI gates, hardened after an adversarial review). DOCUMENTED
// residual bounds it does NOT catch (accepted, like those sibling gates' own bounds): true cross-statement aliasing
// (`const b = window.flowline; b.x()` — no static string scan can follow a binding); tokens hidden in a raw
// back-tick template TEXT or a regex-literal body (rare; `${…}` expressions and ordinary strings ARE handled);
// an old-style `<Type>`-cast between the ref and the member; and a Unicode-escaped `isWeb`. The goal is to
// catch the OBVIOUS, single-expression reintroductions a refactor regression actually produces.

import { stripComments, blankStringLiterals } from "./_scan-utils";

/** One seam leak: its 1-based line within the scanned source, a machine `kind`, and a human message. */
export interface SeamViolation {
  readonly line: number;
  readonly kind: "isWeb" | "bridge-access";
  readonly message: string;
}

// A reference to the global `flowline` bridge property, however spelled: any global object (window/globalThis/self/
// top), dotted or optional-chained, plus the bracketed `window["flowline"]` form. `globalThis.flowline` is also
// blocked upstream by tsc (the bridge augments `interface Window`, not globalThis) — kept here as cheap insurance.
const BRIDGE_REF =
  '(?:window|globalThis|self|top)\\s*(?:(?:\\?\\.|\\.)\\s*flowline\\b|(?:\\?\\.\\s*)?\\[\\s*["\']flowline["\']\\s*\\])';

// VIOLATION: a member reaching THROUGH the bridge. After the ref, allow an optional `!` non-null assertion and an
// optional `as`/`satisfies` cast tail (with its closing paren) — both compile-time-erased — then REQUIRE a member
// accessor `.` / `?.` / `[`. A bare read / existence check / arg-pass has none of these next, so it is NOT matched.
const RE_BRIDGE_ACCESS = new RegExp(
  BRIDGE_REF + "\\s*(?:!\\s*)?(?:(?:as|satisfies)\\b[^.;,\\n)]*\\)?\\s*)?(?:\\?\\.|\\.|\\[)",
  "g",
);

// VIOLATION: destructuring capabilities straight off the bridge — `const { exportDocx } = window.flowline`. The
// allowed read is a SINGLE-identifier handoff; a `{`/`[` binding pattern initialized from the bridge extracts
// capabilities into renderer scope and is therefore a leak. The binding body is `[^;]*?` (lazy, stops at the
// statement `;`) so a default value INSIDE the pattern (`const { exportDocx = noop } = …`) does not end the match
// at its `=`; an optional `: Type` annotation between the pattern and `=` is tolerated.
const RE_BRIDGE_DESTRUCTURE = new RegExp(
  "(?:const|let|var)\\s*[{\\[][^;]*?[}\\]]\\s*(?::[^=;]*)?\\s*=\\s*" + BRIDGE_REF,
  "g",
);

// The deleted predicate, as a standalone identifier. `\b…\b` so `isWebSocket`/`thisWeb` never false-positive.
const RE_ISWEB = /\bisWeb\b/g;

// String contents kept intact through literal-blanking: `"flowline"` is the property key in the `window["flowline"]`
// bracket-access form, which the gate must still SEE. (A string that merely CONTAINS it, like "flowline.theme", is
// not exact and is still blanked — so the repo's "flowline.*" localStorage keys do not false-positive.)
const KEEP_LITERALS: ReadonlySet<string> = new Set(["flowline"]);

const ISWEB_MSG =
  "`isWeb` is forbidden outside src/renderer/host/ — platform is decided once via resolveHost(bridge), then flows through host/shell";
const ACCESS_MSG =
  "capability access through the `flowline` preload bridge is forbidden outside src/renderer/host/ — call it through `host` / `shell`";
const DESTRUCTURE_MSG =
  "destructuring capabilities off the `flowline` bridge is forbidden outside src/renderer/host/ — the only allowed read is the composition-root `const bridge = window.flowline` handoff";

/** 1-based line number of `index` within `code`. */
function lineOf(code: string, index: number): number {
  return code.slice(0, index).split(/\r?\n/).length;
}

/**
 * Scan ONE file's source for platform-seam leaks. Order matters: strip block comments, blank string literals, then
 * strip `//` line comments — so a `//` inside a string (a URL) is gone before the line strip, and tokens living
 * only in a string (e.g. the repo's "flowline.*" localStorage keys, or a help/error message) never false-positive.
 * `matchAll` clones the regex internally, so the module-level globals carry no `lastIndex` state between calls.
 */
export function findSeamViolations(source: string): SeamViolation[] {
  const code = blankStringLiterals(stripComments(source), KEEP_LITERALS).replace(/\/\/[^\n]*/g, "");
  const out: SeamViolation[] = [];
  for (const m of code.matchAll(RE_ISWEB)) {
    out.push({ line: lineOf(code, m.index), kind: "isWeb", message: ISWEB_MSG });
  }
  for (const m of code.matchAll(RE_BRIDGE_ACCESS)) {
    out.push({ line: lineOf(code, m.index), kind: "bridge-access", message: ACCESS_MSG });
  }
  for (const m of code.matchAll(RE_BRIDGE_DESTRUCTURE)) {
    out.push({ line: lineOf(code, m.index), kind: "bridge-access", message: DESTRUCTURE_MSG });
  }
  return out;
}
