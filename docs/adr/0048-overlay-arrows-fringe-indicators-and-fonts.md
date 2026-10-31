# 0048. Overlay arrows, fringe indicators and fonts

Status: accepted · 2026-10-31

## Context

[ADR 0045](0045-margins-fringes-and-redisplay-primitives.md) left four things out.
- **The overlay arrow.** `next-error`, the debugger and `gdb` mark a line with it: a marker in `overlay-arrow-position` (or another variable in `overlay-arrow-variable-list`). On a graphical frame it shows as a triangle in the left fringe, and on a terminal as `overlay-arrow-string` (`=>`) written over the start of the line.
- **The fringe indicators.**
  - `indicate-empty-lines` marks the screen lines past the end of the buffer.
  - `indicate-buffer-boundaries` marks the buffer's first and last lines with angles, and with arrows when there is more above or below.
  - `fringe-indicator-alist` names the bitmap for each of these, and for the continuation and truncation arrows, per buffer.
- **Fonts.** Lisp asks about them with font.c's primitives:
  - `font-spec`, `font-get` and `font-xlfd-name` build and read font descriptions;
  - `face-font` and `font-at` tell which font text is drawn in;
  - `font-family-list`, `list-fonts`, `x-list-fonts` and `find-font` list what is installed;
  - `char-displayable-p` tells whether a character can be shown.

  Packages use them to choose fonts and to check for glyphs, such as emoji or icon fonts, before using them. Ember had none (font.c: 0 of about 30).
- **The bell.** In the GUI it only flashed, and only with `visible-bell`.

## Options considered

1. **Overlay arrows as overlays.** A package could put a `before-string` or a fringe display spec where the arrow goes. That is what compile.el does when it uses the margin. It is not what Lisp asks for, though: code sets a marker in a variable and expects redisplay to find it.
2. **Overlay arrows and indicators in redisplay, as Emacs.**
   - Rows from `rows_of_window` and `rows_to_draw` get the arrow's string written over them when the metrics have no fringes, as xdisp.c's `display_line` copies the arrow's glyphs.
   - `Editor::window_fringes` picks each row's bitmaps in the order fringe.c's `update_window_fringes` does, given which rows the front end truncated.
3. **Fonts as plain data** (plists) rather than values. Simpler, but `fontp` could not tell a font from a list, and `font-put` could not change a spec in place.

## Decision

Option 2, and fonts as values.

**Markers become values.** `Value::Marker` holds one, as Lisp variables hold markers. A script's `Marker` stored in a variable or property stays alive, rather than being deleted when the script's object is collected, and reads back as the same object.

**The overlay arrow.**
- Without fringes, the arrow's string (the variable's `overlay-arrow-string` property, else the variable) is written over the row's first columns. A character it partly covers leaves spaces for the rest of its width. This matches what Emacs 30.2 draws on a terminal, checked on a pseudo-terminal: `=>      two` for a line starting with a tab.
- With fringes, it is the variable's `overlay-arrow-bitmap`, else `fringe-indicator-alist`'s `overlay-arrow` (`right-triangle`), drawn over the left fringe's bitmap.
- compile.ts sets it as compile.el does: `overlay-arrow-position` is local to the compilation buffer, at the current message's line, and `overlay-arrow-string` is empty there. So the GUI shows a triangle and a terminal nothing.

**Fringe indicators.**
- `window_fringes` ports `update_window_fringes`. For each row it takes, in order:
  1. a display spec's bitmap;
  2. truncation;
  3. the top and bottom angles;
  4. continuation;
  5. empty lines (left) or the up and down arrows;
  6. empty lines (right).
- `logical_fringe_bitmap` ports `get_logical_fringe_bitmap`: the buffer's alist before the default, `t` meaning the default's, and partial bitmaps for a last line without a newline.
- The empty line after a final newline is marked, as Emacs marks it.
- The GUI draws the rows below the buffer's end with the `empty-line` bitmap.
- `fringe-bitmaps` gains `horizontal-bar` and `empty-line`, as Emacs has 24 standard bitmaps.

**Fonts.**
- **Values.** `font.rs` holds font specs, entities and objects (`Value::Font`):
  - `font-spec` with Emacs's checks and errors;
  - names parsed in the XLFD, Fontconfig and GTK forms;
  - `font-get`, `font-put` and `fontp`;
  - `font-xlfd-name` as `font_unparse_xlfd` writes it, with FOLD-WILDCARDS.
- **What a front end reports.** `TextMetrics` gains `font_metrics`, `font_families` and `has_glyph`, which answer for:
  - `face-font`, `font-at`, `query-font` and `font-info`;
  - `font-family-list`, `list-fonts`, `find-font` and `x-list-fonts`;
  - `font-has-char-p` and `char-displayable-p`.
- **The GUI** reports egui's fonts. A face's font is the first font of the family egui draws it in, and the system's families come from fontique.
- **A terminal** has no fonts, so these answer nil there, as batch and terminal Emacs do.
- **Sizes.** A whole `:size` is in pixels and a fraction in points, as in Emacs. Scripts cannot write `12.0`, so `:point-size` gives a size in points.

**The bell.** The GUI on macOS sounds the system beep (`NSBeep`, as Emacs's Mac port does) and flashes with `visible-bell`. Elsewhere egui has no sound, so it flashes either way.

## Consequences

- **Packages can mark lines as Emacs's do.** The debugger, `gdb`, `next-error` and Flymake-like packages set a marker, and the arrow follows it as the buffer changes.
- **Speed.** A window's fringes are worked out once per redraw from rows already built. Overlay arrows cost a variable lookup per window when there are none, so the benchmark should not move.
- **Fonts are limited by egui.**
  - The GUI draws text in two families, monospace and proportional. `face-font` therefore names one of those two, whatever `:family` a face asks for.
  - `list-fonts` offers each installed family in four styles, without asking the system which exist.
  - egui keeps no ascent, so ascent and descent split the line four to one.
  - Drawing a face in any installed family needs egui to load fonts on demand, which is a separate step.

## Dependencies introduced

| Crate | Version | Purpose |
| --- | --- | --- |
| objc2-app-kit (macOS only, `NSGraphics`) | 0.3 | `NSBeep` for the GUI's bell; already in the build through eframe |
