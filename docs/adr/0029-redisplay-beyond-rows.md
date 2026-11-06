# 0029. Redisplay beyond rows of characters

Status: accepted · 2026-10-30

## Context

The core lays every window out as a grid of character cells: each character is one or two columns wide, each row one line high, and the GUI draws that grid in a monospace font. Emacs's redisplay works in pixels. A face can make text taller (`:height`) or proportional (`:family`, the `variable-pitch` face); `C-x C-+` scales a buffer's text; a window shows as many rows as fit its height in pixels; and Lisp asks redisplay where things are, with `pos-visible-in-window-p`, `window-end`, `posn-at-point` and `window-text-pixel-size`, which completion popups, scrolling commands, Org's tables and the mouse code use. Images, margins, fringes, the header line and bidirectional text are built on the same layout. [docs/plan.md](../plan.md) lists this third among the gaps in the core, and the largest.

Speed matters as much as fidelity here. Redisplay runs after every key, and E8 means to be faster than Emacs everywhere ([docs/optimisation.md](../optimisation.md)). Today the core's part of a key, the rows of a 120 × 50 window included, takes 0.1 to 2.4 ms in a 50,000-line Org file and a 100 MB text file ([docs/performance.md](../performance.md)).

## Options considered

1. **The front end lays out, the core asks it.** The GUI measures and wraps text with egui and tells the core what it showed. Commands such as `C-v`, `C-n` over wrapped lines and `pos-visible-in-window-p` need answers in the middle of a command, before anything is drawn, so the core would have to call into the front end's layout anyway, and the terminal and the headless editor would need their own.
2. **The core lays out in pixels, with metrics the front end supplies**, as Emacs's redisplay asks its font backend for glyph metrics. The core decides where every glyph goes and how tall every row is; front ends draw what it decided. The terminal's metrics are cells, so it behaves as Emacs's terminal frames do, where heights and families have no effect.
3. **Keep cells, and approximate heights with whole rows.** Cheap, but proportional text and scaled text cannot be placed, and positions in pixels cannot be answered.

## Decision

Option 2, in steps, each with the oracle and the benchmark run before and after.

**Metrics.** A front end gives the editor a `TextMetrics`: the advance of a character and the height and ascent of a line in a font, where a font is a family (fixed or proportional, or a family name), a size relative to the default face's, and bold and italic. Units are the front end's own: points in the GUI, cells in the terminal. The terminal's `CellMetrics`, which headless editors and tests use too, makes every character one cell, or two for wide ones, and every line one cell high, whatever the face. Advances are cached in the core per font, with an array for ASCII.

**Faces** gain Emacs's `:height`, an absolute size in tenths of a point or a factor of the face below, which multiplies through inheritance and face lists as Emacs merges it, and `:family`, with Emacs's `fixed-pitch` and `variable-pitch` faces. `face-remapping-alist` remaps a face in a buffer, as Emacs's face-remap.c, which `text-scale-adjust` on `C-x C-+`, `C-x C--` and `C-x C-0` and `variable-pitch-mode` use, ported from face-remap.el.

**Geometry.** Rows keep their segments and gain a layout: each glyph's x and width, the row's height and ascent, all in the metrics' units, worked out in the core by the same code for every front end. Long lines wrap where the next glyph would pass the window's width in those units; a window shows the rows that fit its body height; `ensure_point_visible`, scrolling and the line motion commands count rows by height. Front ends tell the core each window's body size in their units as well as in columns and lines, and draw each row's segments at the x and y the core gives.

**Positions.** The functions Lisp asks redisplay with are the core's: `pos-visible-in-window-p`, `window-end`, `posn-at-point`, `posn-at-x-y`, `window-text-pixel-size`, `line-pixel-height`, `window-body-width` and `window-body-height` in pixels, `default-font-width` and `default-font-height`. Mouse clicks are hit-tested through `posn-at-x-y`, so the GUI no longer works out positions of its own.

**Speed.** Most buffers show only fixed-pitch text at the default height. For them, the layout in units is the grid scaled by one character's width and one line's height, so the core takes the grid's code path, today's, and the uniform case costs nothing new; a buffer leaves it when a face in effect on the text it shows has a `:height` other than the default's or a proportional family, or its remapping changes the default face. A row is laid out only when it is about to show or a command asks about it, as Emacs's redisplay looks only at what a window can show, and motion over many lines counts row heights without building segments where it can. The benchmark gains a variable-pitch buffer and a scaled one, and each step records the uniform numbers to show they did not move.

The steps:

1. Metrics, `:height` and `:family`, face remapping, `text-scale-adjust` and `variable-pitch-mode`, row geometry with wrapping and window filling by size, and the position functions. The GUI draws proportional and scaled text.
2. Line motion by pixels: `line-move-visual`'s goal column as an x position, as Emacs keeps it, and `C-v` and `M-v` by height in mixed rows.
3. The header line (`header-line-format`, done in [ADR 0041](0041-header-line-and-tabulated-lists.md)), margins (done with fringes in [ADR 0045](0045-margins-fringes-and-redisplay-primitives.md)) (`left-margin-width`, `(margin left-margin)` display specs) and fringes with their bitmaps, which `display-line-numbers`, the continuation mark and `next-error` would use.
4. Images: `create-image`, `(image ...)` display specs and `insert-image`, PNG, JPEG and SVG, drawn by the GUI and shown as text in the terminal.
5. Bidirectional text, as Emacs's bidi.c reorders it for display (done in [ADR 0047](0047-bidirectional-text.md)).
6. The minibuffer's rows wrapped as a window's are, with `resize-mini-windows`.

## Progress

Step 1 is done. With the GUI's metrics, keys in a 50,000-line Org file cost 0.3 to 0.6 ms more than with cells, most of it faces worked out for rows built to move through ([performance.md](../performance.md), [optimisation.md](../optimisation.md)); with cells, as in the terminal, nothing moved. Two things are left for later steps: Emacs's lower limit on `text-scale-adjust`, which depends on the smallest font a frame can show, and faces given as attribute lists in a `face` property rather than by name. The cursor on a space in proportional text is as wide as the space, as Emacs draws it.

Step 2 is done. Off the grid, `C-n` and `C-p` keep their goal as an x position, a fractional column, and land before the glyph that reaches past it, as `vertical-motion` does with a goal in pixels; `C-v` and `M-v` move the window by as many whole lines as fill the screen less two lines of context, and point that would leave it goes to the last line showing whole. On the grid both work as before, so the terminal still scrolls by lines of text rather than screen rows, which differs from Emacs for continued lines until a window can start partway through a line. `C-v` with the GUI's metrics costs 0.3 ms more for measuring the rows it passes.

Step 4 is done ([ADR 0046](0046-images.md)): `(image ...)` display specs on text, overlays, strings and in the margins, sliced or whole, PNG, JPEG, GIF's first frame and SVG, with image.c's primitives and image.el's functions and commands, and a minimal `image-mode`. The core reads each image's size from its header and lays rows out as tall as their images, on the baseline as `:ascent` says, matching Emacs's line heights and positions; the GUI decodes and draws them, and the terminal shows the text, as Emacs's terminals do. Buffers without images take the same paths as before.

Step 5 is done ([ADR 0047](0047-bidirectional-text.md)). Lines with right-to-left text are reordered as they are made into rows, before they are broken into screen rows, as Emacs breaks them; a right-to-left row is laid out from the window's right edge, by an offset the posn functions, line motion and both front ends take from the core. A buffer that never held a right-to-left character, an Arabic digit or a directional control makes its rows as before. The oracle, an interactive Emacs whose screen tmux reads, agrees on 281 recorded cases but for the few the ADR lists.

Step 6 is done. The minibuffer's rows wrap at its window's width, which front ends give the editor (`set_minibuffer_width`), as a window's lines do, and the echo area grows to show them as `resize-mini-windows` says, grow-only by default. Overlay strings now wrap a character at a time, in windows too, as Emacs continues them, where they were kept whole; an ellipsis and a display string standing for text still are. Point before an overlay string that wraps shows on the row where the string starts, before it, as Emacs puts the cursor before an after-string: icomplete's list after the input wraps onto a second line with the cursor at the end of the input, as in Emacs. A long message in the echo area wraps too, and the echo area grows for it and shrinks once it goes.

## Consequences

Packages can style text as Emacs's do and ask where it shows. Every step after the first builds on the core knowing where each glyph is. Front ends get simpler: the GUI stops measuring rows itself, and hit-testing, the cursor and the region come from the core's layout. Rows depend on the metrics, so headless tests see cells, as a terminal frame in Emacs does; the GUI's own tests check its layout with its fonts. A buffer with mixed sizes or a proportional font costs more per key than a uniform one, as it does in Emacs, and the benchmark keeps the price in view.

## Dependencies introduced

None.
