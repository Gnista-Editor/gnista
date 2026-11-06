# 0047. Bidirectional text

Status: accepted · 2026-10-31

## Context

[ADR 0029](0029-redisplay-beyond-rows.md)'s fifth step is bidirectional text: Hebrew, Arabic and the other right-to-left scripts, mixed with left-to-right text, shown as Emacs's bidi.c and xdisp.c show them. Emacs reorders every line for display by the Unicode Bidirectional Algorithm (UAX#9), with paired brackets and isolates; finds each paragraph's direction from its first strong character, or from `bidi-paragraph-direction`; lays a right-to-left paragraph out from the window's right edge; mirrors brackets; and gives Lisp `current-bidi-paragraph-direction`, `bidi-resolved-levels`, `bidi-find-overridden-directionality` and `move-point-visually`, which `right-char` and `left-char` use. Until now E8 showed all text in the order it is in, and those primitives answered for left-to-right text only.

Redisplay runs after every key, and text without right-to-left characters must cost nothing new ([docs/optimisation.md](../optimisation.md)).

Emacs's own description of its implementation ([bidi.c](https://github.com/emacs-mirror/emacs/blob/emacs-30.2/src/bidi.c)) notes one deliberate departure from UAX#9, which decides what E8 must do: Emacs reorders a whole line before breaking it into screen lines, so a continued line is broken in the visual order, not each screen line reordered on its own.

## Options considered

1. **The `unicode-bidi` crate (MIT/Apache).** A conforming UAX#9 with its own Unicode tables, per paragraph and line. Its results are the standard's, which differ from Emacs's where bidi.c resolves one character at a time with state carried along (below); it has no switch for bracket pairs (`bidi-inhibit-bpa`), keeps no explicit controls in the text with levels of their own as Emacs does, and its tables are its Unicode version's rather than Emacs's. It would also be a new dependency, as it is not in the lock file.
2. **Port bidi.c's sequential iterator.** Exactly Emacs, but its design, an iterator that hops back and forth over the buffer with a cache of states, exists to fit Emacs's display engine, which E8 does not have, and is some 3,700 lines.
3. **A batch UAX#9 that follows bidi.c's choices, checked against Emacs.** Resolve a line's levels together, as the standard describes, but with Emacs's tables and every rule where bidi.c does something particular, found by comparing with Emacs on hundreds of recorded lines.

## Decision

Option 3: `crates/e8-core/src/bidi.rs`, with no new dependency. Emacs's tables come from Emacs itself, as `chartab_data.rs` does: `tests/emacs/bidi-data.el` writes `bidi_data.rs`, each character's `bidi-class` as runs, its `mirroring` and `paired-bracket`, `bracket-type` and `mirrored`.

- **The algorithm.** Levels are resolved per line, a newline ending the explicit embeddings as in Emacs, by X1 to X10, W1 to W7, N0 to N2, I1, I2 and L1, with these of bidi.c's:
  - controls are kept in the text, as "X9 retaining" describes, an embedding or override initiator and its PDF at the level inside, an isolate initiator and its PDI at the level outside;
  - W1 to W7 go one character at a time with bidi.c's state: a separator looks at the very next character, and a terminator at what bidi.c's cached forward search found, which a run of terminators sees only from its first;
  - a BN is resolved as a neutral, except BNs alone at the end of a level run;
  - text inside an isolate ends with the direction its initiator resolved to, and an isolate left open with the level the paragraph ends at;
  - L1 puts an embedding control at the paragraph's level only after a space, as bidi.c's search for what follows whitespace does;
  - mirrored characters are those whose resolved type is R, as xdisp.c mirrors them, unless `inhibit-bidi-mirroring`.
- **Paragraphs.** A paragraph's direction is `bidi-paragraph-direction`'s, else its first strong character's, skipping isolates, the paragraph bounded by `bidi-paragraph-start-re` and `bidi-paragraph-separate-re` or empty lines, looking back no more than bidi.c does (7,500 lines, 100,000 characters). A paragraph without a strong character takes the one's before it, as Emacs keeps the direction it had; an empty line takes the next paragraph's.
- **Rows.** A line that needs it is reordered when its row is made (`rows.rs`, through `bidi_display.rs`), before it is broken into screen rows, so rows break in visual order as Emacs's do. A string a display property or overlay shows is one object in the line's order, U+FFFC as bidi.c sees it, its own text reordered within it. A right-to-left row's segments are then turned around to run left to right like every row's, a tab measured from the right edge as Emacs measures it, an escape such as `^A` shown back to front, `A^`, and the end of the line given a glyph at its left, where the cursor goes after the last character. `Row::right_to_left` says the row is laid out from the right edge: `Editor::row_offset_in` gives how far right it starts, which posn functions, line motion, clicks and both front ends use. A continued right-to-left row's fringe arrows swap sides.
- **Points and positions.** `display::cursor_glyph` puts the cursor on the glyph showing point in a reordered row, on a tab's or a string's cell at the right in a right-to-left one; `display::row_showing` finds the row showing a position when a reordered line spreads it over rows whose ranges overlap. `C-n` and `C-p` keep the goal where it shows. The GUI paints the region over each run of selected glyphs, so it can be in pieces.
- **Primitives.** `currentBidiParagraphDirection`, `bidiResolvedLevels`, `bidiFindOverriddenDirectionality` (on a buffer or a string), `movePointVisually` (along the row, then onto the next row the way it moves, or by the order the row shows its characters where the window ends, as Emacs lays lines out afresh) and `getCharCodeProperty` for `bidi-class`, `mirroring`, `paired-bracket`, `bracket-type` and `mirrored`, in a block of their own (`crates/e8-script/src/bidi.rs`). subr.ts has `bidiStringMarkLeftToRight`, and a new package, `bindings.ts`, `right-char`, `left-char`, `right-word` and `left-word` on `<right>`, `<left>`, `C-` and `M-` with them, and `visual-order-cursor-movement`. The variables are Emacs's: `bidi-display-reordering`, `bidi-paragraph-direction`, `bidi-paragraph-start-re`, `bidi-paragraph-separate-re`, `bidi-inhibit-bpa` and `inhibit-bidi-mirroring`.
- **The terminal** draws right-to-left rows from the right edge, a continued one with `/` at the left and a truncated one with `$` there, as Emacs on a terminal does; a line broken between words has no mark, left to right too, as Emacs's has none. The bidi controls show as a space, as Emacs's thin space for them is on a terminal.
- **The GUI** falls back to Arial Hebrew or Noto Sans Hebrew and to Geeza Pro or Noto Sans Arabic, spacing each letter to its column. egui 0.37 shapes text with harfrust, which shapes a run of right-to-left letters right to left and so would turn the core's visual order around again; so each letter of a right-to-left script is drawn on its own, over a space the row keeps for it. Arabic letters therefore do not join.
- **Speed.** A buffer keeps whether any text that may reorder, a right-to-left letter, an Arabic digit or a control, was ever put in it (`Buffer::has_rtl`, checked 64 bytes at a time for bytes from 0xD6 as text goes in). Without such text, or with `bidi-display-reordering` nil, rows are made as before, with two variable lookups more per call. In a buffer with such text, a line of a left-to-right paragraph is reordered only if its text has some, the same byte check; paragraph starts and directions are found once per paragraph as rows are made in order.

The oracle is `tests/emacs/bidi/`: `record.el` runs an interactive Emacs 30.2 inside tmux, 40 columns by 16 lines, and records for each of 281 cases (31 written by hand, 150 random lines and 100 random long lines, some word-wrapped, mixing Hebrew, Arabic, both kinds of digit, brackets, separators and every control) the screen as tmux shows it, `bidi-resolved-levels` of each screen line, where each position shows, `move-point-visually` both ways from each position, `current-bidi-paragraph-direction` at each, and `bidi-find-overridden-directionality`. `tests/bidi.rs` in e8-script compares all of it; the few places it differs are listed there and in [differences.md](../differences.md).

## Consequences

- Hebrew, Arabic and mixed text read as in Emacs in both front ends, and packages that ask about direction or move visually can be ported.
- A reordered row is made of more segments, a right-to-left run's characters each its own, so such rows cost more to make and draw; text without right-to-left characters costs what it did. The benchmark has no right-to-left buffer yet.
- Row ranges of a continued line with mixed directions can overlap, which code looking for the row of a position must allow for, as `row_showing` does.
- Still missing: line numbers on the right of right-to-left rows, Arabic letters joined in the GUI, and `highlight-confusing-reorderings`.

## Dependencies introduced

None.
