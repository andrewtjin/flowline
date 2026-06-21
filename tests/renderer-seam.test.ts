// renderer-seam.test.ts — proves the platform-seam gate (check-renderer-seam) both BITES and is false-positive-free.
// A gate that never fires is inert; the negative cases below are the load-bearing ones. Many of these encode bypasses
// + false positives an adversarial review confirmed (TS casts, alt-globals, bracket/optional-chain on window,
// destructuring, and string-literal over-matching). The final block also scans the REAL src/renderer (minus host/)
// so the seam invariant rides in the test suite, not only in `npm run check`.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { walkSourceFiles } from "../scripts/_scan-utils";
import { findSeamViolations } from "../scripts/_renderer-seam";

const kinds = (src: string): string[] => findSeamViolations(src).map((v) => v.kind);

describe("renderer-seam detector — catches reintroductions (the gate must bite)", () => {
  it("flags a reintroduced `isWeb` declaration", () => {
    expect(kinds("const isWeb = !window.flowline && !hidden;")).toContain("isWeb");
  });
  it("flags `if (isWeb)` branching", () => {
    expect(kinds("if (isWeb) { doWebThing(); }")).toContain("isWeb");
  });
  it("flags a member call through the bridge", () => {
    expect(kinds("await window.flowline.exportDocx(blob, name);")).toContain("bridge-access");
  });
  it("flags optional-chained bridge access", () => {
    expect(kinds("window.flowline?.openFile();")).toContain("bridge-access");
  });
  it("flags non-null-asserted bridge access", () => {
    expect(kinds("window.flowline!.saveFile(data);")).toContain("bridge-access");
  });
  it("flags indexed access on the capability", () => {
    expect(kinds('const f = window.flowline["exportDocx"];')).toContain("bridge-access");
  });
  it("flags whitespace-split access", () => {
    expect(kinds("window . flowline . openFile();")).toContain("bridge-access");
  });
  it("flags a multi-line method chain", () => {
    expect(kinds("window.flowline\n  .openFile();")).toContain("bridge-access");
  });

  // --- bypasses an adversarial review confirmed (v1 missed these) ---
  it("flags access across an `as` cast", () => {
    expect(kinds("(window.flowline as Flowline).exportDocx(blob);")).toContain("bridge-access");
  });
  it("flags access across a `satisfies` cast", () => {
    expect(kinds("(window.flowline satisfies FlowlineApi).openFile();")).toContain("bridge-access");
  });
  it("flags access across a non-null + cast", () => {
    expect(kinds("(window.flowline! as Flowline).exportDocx(blob);")).toContain("bridge-access");
  });
  it("flags bracketed access to the bridge itself (double quotes)", () => {
    expect(kinds('window["flowline"].exportDocx(blob);')).toContain("bridge-access");
  });
  it("flags bracketed access to the bridge itself (single quotes)", () => {
    expect(kinds("window['flowline'].openFile();")).toContain("bridge-access");
  });
  it("flags optional-chaining ON window", () => {
    expect(kinds("window?.flowline.exportDocx(blob);")).toContain("bridge-access");
  });
  it("flags the bridge reached via `self`", () => {
    expect(kinds("self.flowline.exportDocx(blob);")).toContain("bridge-access");
  });
  it("flags the bridge reached via `top`", () => {
    expect(kinds("top.flowline.openFile();")).toContain("bridge-access");
  });
  it("flags destructuring capabilities off the bridge", () => {
    expect(kinds("const { exportDocx, openFile } = window.flowline;")).toContain("bridge-access");
  });
  it("flags destructuring with a default value (the default's `=` must not end the match)", () => {
    expect(kinds("const { exportDocx = noop } = window.flowline;")).toContain("bridge-access");
    expect(kinds("let { saveFile = fallback } = self.flowline;")).toContain("bridge-access");
  });
});

describe("renderer-seam detector — leaves legal forms alone (no false positives)", () => {
  it("allows the composition-root bare read", () => {
    expect(findSeamViolations("const bridge = window.flowline;")).toEqual([]);
  });
  it("allows the composition-root bare read with a cast", () => {
    expect(findSeamViolations("const bridge = window.flowline as FlowlineBridge;")).toEqual([]);
  });
  it("allows a `!window.flowline` existence check", () => {
    expect(findSeamViolations("const web = !window.flowline && import.meta.env.DEV;")).toEqual([]);
  });
  it("allows `if (window.flowline)` guarding", () => {
    expect(findSeamViolations("if (window.flowline) { boot(); }")).toEqual([]);
  });
  it("allows passing the bridge as an argument then using the result", () => {
    // bridge handed to resolveHost (legal value use); `.host` is on resolveHost's RESULT, not the bridge.
    expect(findSeamViolations("const { host, shell } = resolveHost({ bridge: window.flowline });")).toEqual([]);
    expect(findSeamViolations("const h = resolveHost(window.flowline).host;")).toEqual([]);
  });
  it("ignores `isWeb` / bridge access inside a line comment", () => {
    expect(findSeamViolations("// the old isWeb used window.flowline.exportDocx — now via host")).toEqual([]);
  });
  it("ignores them inside a block comment", () => {
    expect(findSeamViolations("/* isWeb + window.flowline.openFile */\nconst ok = 1;")).toEqual([]);
  });
  it("ignores bridge access spelled inside a string literal (repo's `flowline.*` key convention)", () => {
    expect(findSeamViolations('localStorage.setItem("window.flowline.geom", json);')).toEqual([]);
    expect(findSeamViolations('throw new Error("window.flowline.saveFile failed");')).toEqual([]);
  });
  it("ignores `isWeb` spelled inside a string literal", () => {
    expect(findSeamViolations('const KEY = "flowline.isWeb";')).toEqual([]);
    expect(findSeamViolations("const t = `mode=${'isWeb'}`;")).toEqual([]);
  });
  it("does not treat `isWebSocket` as the banned predicate (word boundary)", () => {
    expect(kinds("const s = new isWebSocket();")).not.toContain("isWeb");
  });
  it("does not treat `window.flowlineConfig` as a bridge member access", () => {
    expect(findSeamViolations("const c = window.flowlineConfig.value;")).toEqual([]);
  });
});

describe("renderer-seam detector — accuracy", () => {
  it("reports the correct 1-based line number", () => {
    const v = findSeamViolations("line1;\nline2;\nwindow.flowline.openFile();");
    expect(v).toHaveLength(1);
    expect(v[0].line).toBe(3);
  });
});

describe("renderer-seam gate — the live renderer is clean", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const RENDERER = join(ROOT, "src", "renderer");
  const HOST = join(RENDERER, "host");
  const rendererFiles = walkSourceFiles(RENDERER, { exts: new Set([".ts", ".tsx"]) }).filter(
    (f) => f !== HOST && !f.startsWith(HOST + sep),
  );

  it("scans more than one renderer file (the walk is wired correctly)", () => {
    expect(rendererFiles.length).toBeGreaterThan(1);
  });

  it("has zero seam violations outside src/renderer/host/", () => {
    const problems = rendererFiles.flatMap((f) =>
      findSeamViolations(readFileSync(f, "utf8")).map((v) => `${f}:${v.line} ${v.message}`),
    );
    expect(problems).toEqual([]);
  });

  it("keeps exactly the one composition-root bridge read in main.ts, unflagged", () => {
    const main = readFileSync(join(RENDERER, "main.ts"), "utf8");
    expect(main).toMatch(/const bridge = window\.flowline/);
    expect(findSeamViolations(main)).toEqual([]);
  });
});
