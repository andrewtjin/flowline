// seed.ts — the self-documenting demo speech (DEV-ONLY content for the editor preview + human gates).
//
// This is ORIGINAL, clean-room instructional copy: its purpose is to TEACH the editor's mechanics while
// exercising every block type (heading + card + analytic + paragraph) and every mark (underline F9,
// emphasis F10, highlight F11, muted Mod-8, strong/bold Ctrl+B). The prose is the author's own wording —
// it deliberately does NOT reproduce any third-party tutorial text. Never the app's default doc.
//
// SCHEMA NOTE (v4): a card `body` is now `paragraph+` — a card holds ONE OR MORE body paragraphs, each its
// own isolating unit with a blockId. The demo card below uses a MULTI-paragraph body to exercise that, and
// teaches the real mechanics live: Enter at the end of a body paragraph SPLITS into a fresh body paragraph
// (you stay inside the card); a loose paragraph AFTER the card reads as a continuation; a heading breaks out.

import { schema, buildCard } from "./schema";
import { structureHost } from "./structure-host";
import type { Node as PMNode } from "prosemirror-model";

const { nodes, marks } = schema;
const id = () => structureHost.structure.newUnitId();

export function createSeedDoc(): PMNode {
  // Mark helpers — each wraps a run of text in one of the five marks so the demo shows the visual.
  const und = (t: string) => schema.text(t, [marks.underline.create()]); // F9 read-aloud underline
  const emph = (t: string) => schema.text(t, [marks.emphasis.create()]); // F10 emphasis (bold+ul+box)
  const mud = (t: string) => schema.text(t, [marks.muted.create()]); // Mod-8 muted (small, skip-past)
  const strong = (t: string) => schema.text(t, [marks.strong.create()]); // Ctrl+B bold/strong
  // Highlight (F11) layered with underline — the key read words a debater both highlights and reads.
  const hlu = (t: string, color: string) =>
    schema.text(t, [marks.highlight.create({ color }), marks.underline.create()]);

  return nodes.doc.create(null, [
    // A HAT heading and a BLOCK heading — the flat heading hierarchy (level attr, not nesting).
    nodes.heading.create({ blockId: id(), level: "hat" }, schema.text("How To Read This Editor")),
    nodes.heading.create({ blockId: id(), level: "block" }, schema.text("Marks, blocks, and the keys")),

    // A CARD: tag (the claim), a cite line (source), and a MULTI-paragraph body (v4 `paragraph+`). The
    // first body paragraph exercises all five marks; the second teaches the in-body Enter split mechanic.
    buildCard({
      blockId: id(),
      tag: [schema.text("Every read mark has a key — learn the five and you never touch the mouse.")],
      cite: [schema.text("Demo Author 26 (Flowline guide, “Marks at a glance,” 2026)")],
      body: [
        {
          blockId: id(),
          content: [
            mud("Skim text reads small — "),
            schema.text("inside the body you can "),
            und("underline the words you read aloud"),
            schema.text(" with F9, draw the "),
            emph("emphasis box"),
            schema.text(" with F10, "),
            hlu("highlight the key claim", "yellow"),
            schema.text(" with F11, and make a word "),
            strong("bold"),
            schema.text(" with Ctrl+B. Press F12 to clear every mark off a selection."),
          ],
        },
        {
          blockId: id(),
          content: [
            schema.text("This is a second body paragraph. A card body now holds many paragraphs: press Enter at the end of one and a fresh body paragraph opens right here — you never leave the card. Backspace at the very start of a body paragraph folds it back into the one above."),
          ],
        },
      ],
    }),

    // A loose PARAGRAPH right after the card — this is the "absorbed as body" lesson, demonstrated live.
    nodes.paragraph.create(
      { blockId: id() },
      schema.text(
        "This paragraph sits right after the card: a paragraph immediately following a card reads as a continuation of its body. Press Enter at the end of a card body and you land here. To break out and start a fresh section, make a heading instead.",
      ),
    ),

    // An ANALYTIC — your own argument prose, rendered dark blue and bold, distinct from quoted body text.
    nodes.analytic.create({ blockId: id() }, [
      schema.text("Analytic blocks are "),
      emph("your own words"),
      schema.text(" — use them to explain why the card matters, not to quote a source."),
    ]),

    // A closing PARAGRAPH that names the keys, so the demo doubles as a cheat sheet.
    nodes.paragraph.create(
      { blockId: id() },
      schema.text("Keys: F9 underline · F10 emphasis · F11 highlight · F12 clear · Mod-8 muted · Ctrl+B bold."),
    ),
  ]);
}
