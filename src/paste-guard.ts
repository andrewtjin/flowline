// paste-guard.ts — the minimal paste sanitiser.
//
// WHY a Slice rebuild, NOT an HTML re-parse (a critical correctness trap). The obvious reading of "strip pasted HTML
// to text + marks" — `transformPastedHTML` then re-parse through the schema — is actively DANGEROUS here: the
// schema's own parseDOM rules re-import `div.fl-card`/`div.fl-tag`/… straight back into real card structure (with
// whatever blockId the markup carried → duplicate ids that break moveBlock and the normalizer), and ordinary
// Word/web `<p>…</p>` parses into GROUPLESS `tag` nodes that fit neither the top level nor a paragraph — the
// schema-rejection cliff. So instead we operate on the ALREADY-PARSED Slice and REBUILD it from
// scratch: keep only text + the supported marks + hard_break, DROP every block wrapper, then materialise the
// result for the CURRENT paste target.
//
// CONTEXT-AWARE materialisation:
//   - Pasting into a card BODY paragraph → emit one `paragraph` per line (fresh blockIds), so multi-paragraph
//     evidence survives as multiple body paragraphs (preserving paragraph breaks into the body).
//   - Anywhere else (tag/analytic/heading, or a top-level paragraph) → emit inline content with a
//     `hard_break` between lines, injecting NO new block — so the caret's container never shatters (pasting a
//     paragraph-bearing slice into an inline-only `tag` otherwise splits the card apart).
// In BOTH cases the result contains NO card/tag/body/heading/analytic node, so a paste can never inject
// structure or a duplicate unit id, and the doc stays check()-valid. (Internal copy of a styled block is thus
// flattened too — deliberate for this minimal guard; structured internal paste is a later, separate concern.)

import { Plugin } from "prosemirror-state";
import { Slice, Fragment } from "prosemirror-model";
import type { Mark, Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { schema } from "./schema";
import { structureHost } from "./structure-host";

/** The marks a paste may keep — the 6 schema marks. Anything else PM parsed is dropped. */
const ALLOWED_MARKS = new Set(["highlight", "emphasis", "muted", "underline", "strong", "cite"]);

/** Keep only the supported marks on a pasted text run (they are already schema Mark instances). */
function filterMarks(marks: readonly Mark[]): readonly Mark[] {
  return marks.filter((m) => ALLOWED_MARKS.has(m.type.name));
}

/**
 * Flatten a pasted Slice to "lines" of inline content: every block boundary starts a new line; only text (with
 * supported marks) and hard_break survive. Empty lines are dropped. This discards ALL block structure — exactly
 * what prevents card/heading re-import and groupless-`tag` cliffs.
 */
function sliceToLines(slice: Slice): PMNode[][] {
  const lines: PMNode[][] = [];
  let current: PMNode[] = [];
  const flush = (): void => {
    if (current.length) {
      lines.push(current);
      current = [];
    }
  };
  const walk = (frag: Fragment): void => {
    frag.forEach((node) => {
      if (node.isText) {
        if (node.text) current.push(schema.text(node.text, filterMarks(node.marks)));
      } else if (node.type === schema.nodes.hard_break) {
        current.push(schema.nodes.hard_break.create());
      } else if (node.isInline) {
        // an unknown inline leaf (none exist in the schema) → drop it
      } else {
        // a block wrapper (paragraph/card/tag/body/heading/analytic): its boundary is a line break; drop
        // the wrapper itself and recurse into its content.
        flush();
        walk(node.content);
        flush();
      }
    });
  };
  walk(slice.content);
  flush();
  return lines;
}

/** True iff the paste target (selection $from) sits inside a card `body` (where multi-paragraph paste belongs). */
function targetIsCardBody(view: EditorView): boolean {
  const $from = view.state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === schema.nodes.body) return true;
  }
  return false;
}

/** The paste-guard plugin: props only, no nodeViews. */
export function pasteGuardPlugin(): Plugin {
  return new Plugin({
    props: {
      transformPasted(slice: Slice, view: EditorView): Slice {
        const lines = sliceToLines(slice);
        if (lines.length === 0) return Slice.empty; // nothing pasteable (e.g. an image) → insert nothing

        // Non-textblock target: a NodeSelection / GapCursor over a WHOLE block (reachable via Ctrl/Cmd-click,
        // triple-click, or drag — see commands.ts). replaceSelection of an inline slice here would replace the
        // block with a PM auto-generated paragraph whose blockId DEFAULTS to null (schema generatability proxy) →
        // a check()-INVALID doc that would SAVE into an unreopenable file. Emit fully-formed paragraphs
        // (freshly minted blockIds, closed slice) so the selected block is replaced by VALID paragraphs.
        if (!view.state.selection.$from.parent.isTextblock) {
          const blocks = lines.map((line) =>
            schema.nodes.paragraph.create({ blockId: structureHost.structure.newUnitId() }, line),
          );
          return new Slice(Fragment.from(blocks), 0, 0);
        }

        if (targetIsCardBody(view)) {
          // One paragraph per line; openStart/openEnd 1 so the first/last lines MERGE into the surrounding body
          // paragraphs and only interior lines become new body paragraphs — the standard multi-paragraph paste shape.
          const paras = lines.map((line) =>
            schema.nodes.paragraph.create({ blockId: structureHost.structure.newUnitId() }, line),
          );
          return new Slice(Fragment.from(paras), 1, 1);
        }

        // Inline target: one flat run, lines joined by a soft break — no block is ever injected.
        const inline: PMNode[] = [];
        lines.forEach((line, i) => {
          if (i > 0) inline.push(schema.nodes.hard_break.create());
          inline.push(...line);
        });
        return new Slice(Fragment.from(inline), 0, 0);
      },
    },
  });
}
