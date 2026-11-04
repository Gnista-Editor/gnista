# 0007. Text properties, faces and display rows

Status: accepted · 2026-10-27

## Context

The first slice of milestone 3 in [the plan](../plan.md) is what syntax highlighting, org headings and folding stand on: text properties, overlays, faces and invisible text. In Emacs these are C primitives that redisplay reads. Gnista has two front ends, so it needs one model of what to draw that both can use.

## Options considered

1. **Each front end interprets properties itself.** Simple at first, but folding and faces would be implemented twice, and line movement in the core would not know what is hidden.
2. **The core computes display rows.** The core resolves faces and invisibility into rows of styled segments, and the front ends only lay them out.

## Decision

The core computes display rows.

**Text properties** are kept as sorted runs over the text. They move with edits, and inserted text gets none, as with Emacs's `insert`. Undo restores the properties of text it brings back. Changing properties does not mark the buffer modified, as Emacs's font-lock does not. Inserted text doesn't inherit properties yet, the way `insert-and-inherit` would. Property changes are not themselves undoable. A plain list of runs is fine for now; large files will want a tree.

**Overlays** move with edits as Emacs's overlay markers do by default: text inserted at the start goes inside, at the end goes after. They have priorities and `evaporate`.

**Faces** are named, inherit from other faces, and have attributes for both backgrounds plus dark and light overrides. Colours are names from a palette in the core, which follows ArtCraft's, or hex values. Both front ends take their colours from that one palette. `face` properties name a face or a list of faces, earlier ones winning, and overlays' faces come before the text's.

**Invisible text** follows Emacs's `buffer-invisibility-spec`, including the "..." ellipsis.

**Rows:**

- A row ends at a visible newline, so hidden newlines join lines into one row; a folded heading is one row.
- Line moves, `C-a`, `C-e`, scrolling, recentring and keeping point visible all count rows.
- After each command, point moves out of hidden text in the direction it moved, as Emacs's command loop does.
- `Editor::window_rows` gives the rows with resolved styles, and `display::row_glyphs` turns a row into glyphs with tabs expanded, which both front ends draw. The GUI lays each row out as one egui job; the terminal uses true colour, blending translucent colours over the palette background.

**In the GUI:**

- Bold text uses Geist Mono Bold when installed. Otherwise it is drawn twice, 0.6 points apart, because egui's built-in font has no bold face.
- The region is a background on the selected glyphs.

**`outline.ts`** follows Emacs's `outline.el`, folding with overlays whose `invisible` property is "outline". It is the first package built on all of this, and a preview of org folding.

## Consequences

Org mode can fold and style headings with the same primitives. Folding motion is checked against Emacs's own outline-minor-mode in the oracle. Heading faces in outline mode are reapplied after every command until font-lock arrives with tree-sitter in the next slice. Script positions count characters, not JavaScript string indices, which differ for emoji, so the API offers line functions.

## Dependencies introduced

None.
