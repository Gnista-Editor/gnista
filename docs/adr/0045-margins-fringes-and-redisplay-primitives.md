# 0045. Margins, fringes and redisplay's primitives

Status: accepted · 2026-10-31

## Context

[ADR 0029](0029-redisplay-beyond-rows.md)'s third step was the header line, margins and fringes; [ADR 0041](0041-header-line-and-tabulated-lists.md) did the header line. Emacs packages put text and bitmaps beside a window's rows:

- `(margin left-margin)` display specs, which annotation, breakpoint and blame modes use;
- `(left-fringe BITMAP FACE)` specs and `define-fringe-bitmap`, which Flymake, diff-hl and git-gutter use.

On a graphical frame Emacs shows a continued line's curly arrows in the fringes and keeps no column for the `\` a terminal shows. Lisp also asks redisplay through the primitives of xdisp.c, dispnew.c and fringe.c: `invisible-p`, `get-display-property`, `buffer-text-pixel-size` (which `string-pixel-width` measures with), `move-point-visually`, `ding`, `redraw-display`, `frame-or-buffer-changed-p` and `internal-show-cursor`. [docs/plan.md](../plan.md) counted 2 of xdisp.c's and dispnew.c's 27 as there.

## Decision

- **Margins.**
  - Each window has a left and right margin, as `window-margins` gives them: `set-window-margins`' while it shows the same buffer, else the buffer's `left-margin-width` and `right-margin-width`.
  - A `((margin left-margin) STRING)` display spec, on text or on an overlay string's characters, puts its string in that margin beside the row, and the text it is on shows nothing.
  - Rows carry their margins' segments. The terminal and the GUI lay each window out as fringe, margin, text, margin, fringe and draw the margins beside each row. A click in a margin is over no text.
- **Fringes.** A front end's `TextMetrics` says whether its frames have fringes: the GUI's do, the terminal's do not, as in Emacs.
  - With fringes, no column is kept for the continuation mark, so a GUI window shows one more character per row.
  - `Editor::row_fringes` gives a row's bitmaps: those `(left-fringe BITMAP FACE)` and `(right-fringe ...)` specs put there, else `right-curly-arrow` where the line goes on and `left-curly-arrow` where it came from the row before. `fringe-bitmaps-at-pos` answers from the same.
  - The GUI also shows `right-arrow` and `left-arrow` where a truncated line runs past either edge. It draws Emacs's standard bitmaps as shapes and those `define-fringe-bitmap` defines from their bits, in the `fringe` face or the one `set-fringe-bitmap-face` or the spec gives.
- **The bell.**
  - `ding` calls `ring-bell-function` if it is set, else rings the front end's bell, as a command's error does too (Emacs's `bitch_at_user`).
  - The terminal sends BEL, or with `visible-bell` flashes.
  - The GUI flashes with `visible-bell`; egui has no sound for the audible bell.
- **Primitives for scripts.**
  - `invisibleP`, `getDisplayProperty`, `bufferTextPixelSize`, `stringPixelWidth` and `displayLineIsContinuedP`;
  - `currentBidiParagraphDirection` (always left to right until bidi, ADR 0029's fifth step) and `movePointVisually`;
  - `ding`, `beep`, `redisplay`, `redrawDisplay`, `redrawFrame` and `frameOrBufferChangedP`;
  - `tabBarHeight`, `toolBarHeight` and `longLineOptimizationsP`;
  - `windowMargins`, `setWindowMargins`, `windowFringes`, `internalShowCursor` and `internalShowCursorP`;
  - `defineFringeBitmap`, `destroyFringeBitmap`, `setFringeBitmapFace`, `fringeBitmapP` and `fringeBitmapsAtPos`.

`get-display-property` and `invisible-p` answer as Emacs 30.2 does on the same text; batch Emacs cannot show `move-point-visually`, which needs a window. `tests/margins_and_fringes.rs` and `tests/redisplay.rs` check the rest. A terminal test checks margins, and a GUI snapshot checks margins and fringes.

## Consequences

- Packages that annotate rows beside the text can be ported as written.
- A GUI window gains a column, which changes where long lines wrap in the GUI, as they do in Emacs's.
- Still to come from ADR 0029: images, bidirectional text, the minibuffer wrapped as a window, and line motion by pixels in mixed rows.
- Fringes still lack:
  - `overlay-arrow-position`'s arrow, with the terminal's `=>`;
  - `indicate-empty-lines` and `indicate-buffer-boundaries`;
  - `fringe-indicator-alist`, `overflow-newline-into-fringe` and fringe widths other than 8 points.

  A defined bitmap's bits are points, so it draws small on a high-density display.

## Dependencies introduced

None.
