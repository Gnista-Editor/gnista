# 0023. Filling, parens and the everyday modes

Status: accepted · 2026-10-29

## Context

The modes people turn on in their Emacs init file were missing: filling paragraphs (`M-q`, `auto-fill-mode`), seeing and typing matching parens (`show-paren-mode`, `electric-pair-mode`), line numbers, and coming back to the history and places of an earlier session (`savehist-mode`, `save-place-mode`). Each is Lisp in Emacs, but each leans on something Emacs does in C that Gnista lacked: markers, `subst-char-in-region`, `post-self-insert-hook` and auto-fill in self-insertion, syntax tables with their scanners, change groups, and line numbers drawn by redisplay.

## Options considered

1. **Port each mode on what the script API had.** Org fakes markers and treats parens as fixed characters. Quick, but every mode would repeat the fakes, and none of them would follow a mode's own idea of what a paren, a word or a comment is.
2. **Add what Emacs has in C first, then port the Lisp closely.** More work up front, but the Lisp then reads as Emacs's does, and the coding round's comment and indentation commands need the same pieces.

## Decision

Option 2.

- **In the core**, as Emacs has them in C:
  - **Markers:** positions that move with edits and come back with undo, for scripts as `makeMarker`, `markerPosition` and `setMarker`.
  - **`subst-char-in-region`:** it changes characters in place without moving point or markers, and records point for undo only in an already modified buffer, as Emacs's `modify_text` makes it.
  - **Self-insertion:** typing a space or newline runs `auto-fill-function`, and `post-self-insert-hook` runs after.
  - **Syntax tables:**
    - each character gets a class, a matching paren and comment flags;
    - tables are named and inherit, ending at `standard-syntax-table`;
    - each major mode gets NAME-syntax-table, built on its parent's;
    - the scanners `scan-lists`, `scan-sexps`, `forward-comment` and `parse-partial-sexp` work from them;
    - word motion reads the table, replacing `word-constituents`.
  - **Change groups**, as `prepare-change-group` and `cancel-change-group`: changes taken back without trace in the undo history.
  - **Line numbers:** worked out for each row by `Editor::line_numbers`, as Emacs's redisplay does. Their gutter narrows the text, and both front ends draw it.
- **In packages**, each after the Lisp file of its name:
  - **fill.ts:** `M-q`, `fill-region`, Adaptive Fill's prefixes, `C-u M-q` justification, `C-x f`, `C-x .`, `auto-fill-mode`.
  - **indent.ts:** `indent-according-to-mode`.
  - **lisp.ts:** `C-M-f`, `C-M-b`, `C-M-n`, `C-M-p`, `C-M-u`, `C-M-d`, `C-M-k`, `C-M-SPC`, `M-(` and `check-parens`.
  - **paren.ts:** `show-paren-mode`, on by default as in Emacs.
  - **elec-pair.ts:** `electric-pair-mode`, keeping parens balanced.
  - **display-line-numbers.ts:** `display-line-numbers-mode`, also as a global mode.
  - **savehist.ts:** `savehist-mode`.
  - **saveplace.ts:** `save-place-mode`.

  Savehist and saveplace write JSON in `user-emacs-directory`, where Emacs writes Lisp, as `project.ts` does.
- **Points of detail**, from comparing with Emacs:
  - Electric indent after RET runs late in `post-self-insert-hook`, after Electric Pair mode, as its depth places it.
  - A command called interactively from another shares the caller's undo step, as `call-interactively` from Lisp does.
  - A trailing escape leaves a sexp unbalanced.
  - Scan errors name their positions in Emacs's order.
- **Testing:**
  - Oracle cases can set buffer-local variables (`vars`), and record.el takes `GNISTA_ORACLE_ONLY`.
  - 182 new cases cover filling, sexps and pairing.
  - Fuzzers for filling and for Electric Pair mode ran until their returns dropped: filling from 23 differences in 300 cases to 2, electric pair through 3,800 cases to none.
  - Show Paren mode, line numbers and the two session modes get headless tests, and line numbers a GUI snapshot.

## Consequences

- Modes can say what a paren, word, string or comment is, and commands that move over code read it.
- The comment and indentation commands of the next round have markers, `forward-comment` and `parse-partial-sexp` to build on.
- Script code can edit and keep positions without faking markers. Org could move to real markers in time.

Left out:
- Syntax-table text properties and `syntax-propertize`.
- The `syntax-ppss` cache. Each call parses from the start, which is quick enough for files of a few thousand lines, but `electric-pair-mode` in a very large file would feel it.
- `blink-matching-paren`'s cursor jump.
- `show-paren-context-when-offscreen`.
- `transpose-sexps` and the defun motions, which the coding round does with tree-sitter.
- Dired places in save-place-mode.
- `display-line-numbers-grow-only` and major ticks.
- Filling of comments, which needs the comment syntax of the coding round.
- Fill mode's handling of CJK text.

Gnista keeps Show Paren mode's idle timer only while the mode is on, where Emacs keeps it always. The difference cannot be seen.

## Dependencies introduced

None.
