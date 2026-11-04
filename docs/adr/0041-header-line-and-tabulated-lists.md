# 0041. The header line and tabulated lists

Status: accepted · 2026-10-31

## Context

Emacs windows can show a header line above their text, from the buffer-local `header-line-format`, a mode line construct like `mode-line-format`. Many of Emacs's listing modes title their columns there: tabulated-list.el, which `list-buffers`, `list-processes`, `list-packages` and the bookmark list are built on, puts the column titles in the header line, lined up with the columns below by `(space :align-to COLUMN)` display specs. Gnista had neither, so the buffer list (ADR 0040) printed its titles as the first line of text and laid its columns out by hand. [ADR 0029](0029-redisplay-beyond-rows.md) lists the header line third among the parts of redisplay still to come.

## Options considered

1. **Format the header line in the core, as the mode line, and have each front end leave a line for it.** The core already formats `mode-line-format` at redisplay (`modeline.rs`, as xdisp.c), so the header line is the same formatter on another variable; front ends lay windows out, so they decide where the line goes, and tell the core each window's text height, as now.
2. **Leave the header line out and keep tabulated lists' titles as text.** What `tabulated-list-use-header-line` off does in Emacs. Simpler, but the titles scroll away, the text differs from Emacs's, and every listing mode would carry the special case.

## Decision

Option 1. `header-line-format` is a buffer-local variable, nil by default; a window's `header-line-format` parameter takes its place, and `none` there hides it, as in Emacs 28 and later. `Editor::window_wants_header_line(window, total_lines)` says whether a window shows one, as xdisp.c's `window_wants_header_line`: it has a format and is more than two lines high. Redisplay formats it with the mode line's formatter into `Editor::header_line(window)`, and the formatter now works out `(space :align-to POS)` display specs in mode line and header line strings, POS a number, a variable such as `header-line-indent-width`, or a `(+ ...)` of them. The terminal draws the header line in reverse video at the top of the window, as Emacs's `header-line` face is on a terminal; the GUI draws it as a bar like the mode line's, with a hairline under it. Both leave the window one line less for text, and a click on the header line is over no text.

`packages/tabulated-list.ts` ports tabulated-list.el: `tabulated-list-mode`, built on `special-mode` (new in simple.ts, as simple.el's), with `tabulated-list-format`, `tabulated-list-entries` (a list or a function), `tabulated-list-padding`, `tabulated-list-sort-key`, `tabulated-list-printer`, `tabulated-list-init-header`, `tabulated-list-print` (remembering point's entry, and updating in place), `tabulated-list-print-entry` and `-print-col` (right-aligned columns, and a column cut to fit kept whole in the text under a `display` property showing the ellipsis, as `truncate-string-to-width` with ELLIPSIS-TEXT-PROPERTY), `tabulated-list-put-tag`, `-clear-all-tags`, `-set-col`, `-delete-entry`, `-get-id` and `-get-entry`, and the commands `S`, `M-<left>`, `M-<right>`, `{` and `}`. With `tabulated-list-use-header-line` off the titles are the first line, under the `tabulated-list-fake-header` face, as in Emacs. `buff-menu.ts` is now buff-menu.el on tabulated-list: buffers as the entries' ids, the name column's width from the window, the titles in the header line, and the marks set with `tabulated-list-set-col`.

Text with a `font-lock-face` property and no `face` is drawn in it, as Emacs's font-lock-mode, on by default, makes `font-lock-face` an alias of `face`; the buffer list's names are bold by it.

`tests/tabulated_list.rs` checks printing, tagging, sorting both ways, setting a column, putting the original order back and widening a column against Emacs 30.2's text and header line on the same list; batch Emacs gives `format-mode-line` nothing for the header line, so the recording worked out its `:align-to` spaces in Lisp.

## Consequences

- Any mode can have a header line, and modes built on `tabulated-list-mode` get sorting and column titles as Emacs's do. The bookmark list, `list-processes` and Dired's header could move onto them.
- The header line takes a line from the window, so `window-body-height` and scrolling see one line fewer, as in Emacs.
- Not yet: clicks on the header line as `<header-line> <mouse-1>` events, which Emacs's sort buttons are bound to; `header-line-indent-mode` following the line numbers' width; tabulated-list groups; and `text-scale-remap-header-line`. [docs/differences.md](../differences.md) lists them.

## Dependencies introduced

None.
