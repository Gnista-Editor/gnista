# 0040. Everyday editing commands

Status: accepted · 2026-10-31

## Context

Ember had grown the deep machinery of Emacs (regexps, syntax tables, processes, tree-sitter) faster than some of its plainest commands. A survey of the commands every Emacs user types found these missing:
- `M-m`, `M-\`, `M-SPC`, `M-^`, `C-x C-o`, `M-z`, `C-q`;
- `M-g g`, `C-x =`, `M-=`;
- `M-@`, `M-h`, `C-M-o`;
- moving by sentences (`M-a`, `M-e`, `M-k`).

They are Lisp in Emacs (simple.el and paragraphs.el), short, and easy to compare with batch Emacs.

## Decision

Port them from simple.el and paragraphs.el into `packages/simple.ts` and `packages/paragraphs.ts`, under Emacs's names, keys and messages.

**Spaces and lines** (simple.el):
- **Moving:** `back-to-indentation` (`M-m`), `forward-to-indentation` and `backward-to-indentation`.
- **Spaces:** `delete-horizontal-space` (`M-\`), `delete-all-space`, `just-one-space`, `cycle-spacing` (`M-SPC`, with `cycle-spacing-actions`) and `fixup-whitespace`.
- **Joining and blank lines:** `delete-indentation` (`M-^`), `delete-blank-lines` (`C-x C-o`), and `delete-trailing-whitespace` with `delete-trailing-lines`.

**Killing:**
- `kill-whole-line` on `C-S-DEL`, as `C-S-<backspace>` in Emacs.
- `zap-to-char` (`M-z`) and `zap-up-to-char`: an upper-case character is matched exactly.
- `copy-region-as-kill`, and `append-next-kill` (`C-M-w`).

**Where point is:**
- `goto-line` (`M-g g`, `M-g M-g`), defaulting to the number at point, and widening as `widen-automatically` says.
- `goto-char` (`M-g c`).
- `what-line`.
- `what-cursor-position` (`C-x =`): the character in decimal, octal and hex, how the file's coding writes it, a `display` property over it, and point, the percentage and the column, as Emacs words them.
- `count-words` and `count-words-region` (`M-=`), with lines, sentences, words and characters.

**Marking and inserting:**
- `mark-word` (`M-@`) and `mark-paragraph` (`M-h`), which extend the region when repeated.
- `split-line` (`C-M-o`).
- `quoted-insert` (`C-q`): with octal digits as `read-quoted-char-radix` says, ended by RET or by a key that is then typed.

**Sentences** (paragraphs.el):
- `sentence-end` is built from `sentence-end-double-space`, `sentence-end-base`, `sentence-end-without-period` and `sentence-end-without-space`, as Emacs builds it.
- On it: `forward-sentence` (`M-e`), `backward-sentence` (`M-a`), `kill-sentence` (`M-k`), `backward-kill-sentence` (`C-x DEL`), `mark-end-of-sentence` and `count-sentences`.
- The paragraph motion they use now keeps within a narrowed buffer, as Emacs's does; it ran past the narrowing before.

**The command loop**, which two of these showed differing from Emacs:
- **`last-command` across a prompt.** A command that reads arguments or answers sees, as `last-command`, the command before it. Before, it saw whatever ran while the answer was typed, such as `self-insert-command`. So `M-x kill-whole-line` twice joins the kills, as in Emacs.
- **`setLastCommand`.** Scripts set `last-command` with `ember.setLastCommand`, as `kill-whole-line` does to join its two kills.

**Lines** (sort.el and replace.el, added in a second batch):
- `packages/sort.ts`: `sort-lines`, stably and the other way round with a prefix argument as sort-subr does, with `sort-fold-case`; `reverse-region` over the whole lines in the region; and `delete-duplicate-lines`, with C-u to keep the last of each, C-u C-u for adjacent lines only and C-u C-u C-u to keep blank ones.
- In `packages/replace.ts`: `keep-lines`, `flush-lines`, `kill-matching-lines`, `copy-matching-lines` and `how-many`, from point or in the active region, with `search-upper-case`, and the aliases `delete-non-matching-lines`, `delete-matching-lines` and `count-matches`.

**Registers and rectangles** (register.el and rect.el, a third batch):
- **Rectangles** (`packages/rect.ts`): `kill-rectangle` (`C-x r k`), `delete-rectangle` (`C-x r d`), `copy-rectangle-as-kill` (`C-x r M-w`), `yank-rectangle` (`C-x r y`), `open-rectangle` (`C-x r o`), `clear-rectangle` (`C-x r c`), `string-rectangle` (`C-x r t`) and `rectangle-number-lines` (`C-x r N`). They work by columns on each line, with tabs across an edge turned into spaces and short lines padded as `move-to-column` with FORCE does.
- **Registers** (`packages/register.ts`): `point-to-register` (`C-x r SPC`), `jump-to-register` (`C-x r j`), `copy-to-register` (`C-x r s`), `append-to-register`, `prepend-to-register`, `insert-register` (`C-x r i`), `copy-rectangle-to-register` (`C-x r r`), `number-to-register` (`C-x r n`), `increment-register` (`C-x r +`), `window-configuration-to-register` (`C-x r w`) and `view-register`. A register's name is read as one key, as `register-use-preview`'s default, `traditional`, reads it.

**Occur** (in `packages/replace.ts`, from replace.el): `occur` on `M-s o` lists the lines matching a regexp, in the region if it is active, in `*Occur*` under Emacs's header ("3 matches in 2 lines for \"alpha\" in buffer: foo") with `%7d:` line numbers and the matches in `list-matching-lines-face`. In `occur-mode`, RET, `o` and `C-o` go to or show a line's match, `M-n` and `M-p` move between them, `g` lists them again, and `M-g n` from anywhere goes through them as `occur-next-error`. Ten cases match Emacs (`occur.json`).

**A fourth batch**, from page.el, tabify.el, text-mode.el, paragraphs.el and simple.el:
- **Pages** (`packages/page.ts`): `forward-page` (`C-x ]`), `backward-page` (`C-x [`), `mark-page` (`C-x C-p`), `narrow-to-page` (`C-x n p`), `count-lines-page` (`C-x l`) and `what-page`, by `page-delimiter`.
- **Tabs and centering:** `tabify` and `untabify`, `center-line` and `center-region`.
- **Transposing and killing:** `transpose-sexps` (`C-M-t`), `transpose-sentences`, `transpose-paragraphs`, `kill-paragraph` and `backward-kill-paragraph`. `transpose-subr` now takes a mover that gives an object's ends itself, as transpose-sexps-default-function does.
- **Other buffers:** `append-to-buffer`, `prepend-to-buffer`, `copy-to-buffer` and `insert-buffer`.
- **`C-l`** is `recenter-top-bottom` (window.el): the line with point to the middle, then the top, then the bottom of the window, as `recenter-positions` says, with `scroll-margin`. **`M-r`** is `move-to-window-line-top-bottom`, moving point there instead, on `move-to-window-line` in the core.
- **Defuns** (lisp.el): `mark-defun` (`C-M-h`), with the comments above the defun and extending when repeated, and `narrow-to-defun` (`C-x n d`).
- Twenty-six cases match Emacs (`everyday-2.json`).

**A fifth batch**, partly in the core:
- **The global mark ring.** `push-mark` keeps the mark of each buffer it was set in on a global ring (`global-mark-ring-max`, 16), as Emacs's does, and `pop-global-mark` (`C-x C-SPC`) goes back through it. `Editor::push_mark` does this, and the commands that set the mark use it.
- **`undo-only`.** It passes over the undo on top and the change it undid, once, as Emacs's `undo-equiv-table` finds them. Two cases are known gaps where Emacs's undo list differs: an undo boundary after a failed command, and its position entries.
- **`M-y` after anything but a yank** reads a kill from the minibuffer with completion and inserts it, as Emacs 28's `yank-from-kill-ring`, making it the one `C-y` inserts next (`yank-from-kill-ring-rotate`). Scripts read the kill ring with `ember.killRing` and set its yank pointer with `ember.setKillRingYankPointer`.
- **`keyboard-escape-quit`** (`ESC ESC ESC`). ESC now counts as a key, not Meta for the next one, when the keys before it bind it, so `M-ESC ESC` can be bound.
- **Small commands:** `duplicate-line`, `duplicate-dwim` and `copy-from-above-command` (`packages/misc.ts`, from misc.el), `raise-sexp` and `delete-pair` (lisp.el, without delete-pair's blink), and `upcase-dwim`, `downcase-dwim` and `capitalize-dwim`.
- **`deactivate-mark`** in the core: a command that sets it to nil after its changes keeps the region active, as `duplicate-dwim` does.
- Twenty-four cases (`everyday-3.json`): twenty-two match and two are those known gaps.

**The buffer list** (`packages/buff-menu.ts`, from buff-menu.el): `list-buffers` (`C-x C-b`) shows `*Buffer List*` in another window and `buffer-menu` in this one, a line for each buffer: `.` for the one it was made from, `%` if read-only, `*` if modified, then the name, size, mode and file in the columns buff-menu.el gives an 80-column window. In `Buffer-menu-mode`, RET, `f`, `o` and `C-o` show a line's buffer, `d`, `k`, `C-d` and `s` mark it to be killed or saved, `u`, `DEL` and `U` unmark, `x` does what is marked, `~` and `%` change it, `m` and `v` show several, `T` keeps to file buffers, `g` lists them again. Ember has no header line yet, so the column titles are the first line, as with `Buffer-menu-use-header-line` off. Batch Emacs leaves the mode column empty, so `tests/buff_menu.rs` checks the layout instead of the Emacs comparison. `kill-some-buffers`, `kill-matching-buffers` and `kill-matching-buffers-no-ask` (files.el) ask about each buffer as Emacs does; batch Emacs hangs answering them, so the same test file checks them.

**Highlighting** (`packages/hi-lock.ts`, from hi-lock.el): `highlight-regexp` (`M-s h r`), `highlight-phrase` (`M-s h p`), `highlight-lines-matching-regexp` (`M-s h l`), `highlight-symbol-at-point` (`M-s h .`) and `unhighlight-regexp` (`M-s h u`), with `hi-lock-mode` and Emacs's `hi-` faces offered in its order. Matches get overlays, as Emacs gives them in a buffer without font-lock rules, so text typed later is not highlighted. `tests/hi_lock.rs` checks the faces.

**Bookmarks** (`packages/bookmark.ts`, from bookmark.el): `bookmark-set` (`C-x r m`) names the place point is at in a file, keeping 16 characters of text on each side (`bookmark-search-size`). `bookmark-jump` (`C-x r b`, `C-x 4 r` for another window) goes back, finding the place by that text after edits around it. `bookmark-delete`, `bookmark-rename`, `bookmark-insert` and `bookmark-save` are there too, and `bookmark-bmenu-list` (`C-x r l`) lists them. They are saved after each change (`bookmark-save-flag` 1) in Emacs's own file format, to `bookmarks` in `user-emacs-directory` or `bookmark-default-file`, and read back from it, so Emacs and Ember can share a file. Batch Emacs would save into the user's own bookmarks, so `tests/bookmark.rs` checks them instead of the Emacs comparison.

**Whitespace** (`packages/whitespace.ts`, from whitespace.el): `whitespace-cleanup` takes away empty lines at the buffer's start and end and spaces at the ends of lines, and turns indentation and the spaces around tabs into tabs or spaces as `indent-tabs-mode` says, for the kinds `whitespace-style` names; with the region active, and in `whitespace-cleanup-region`, only there. `tabify` and `untabify` are functions packages share for it. Seven cases match Emacs (`whitespace.json`). The visual `whitespace-mode` is not here.

**Viewing** (`packages/view.ts`, from view.el): `view-mode` makes a buffer read-only for reading, with less-like keys (SPC and DEL by pages, `d` and `u` by half pages, RET and `y` by lines, `<`, `>`, `g`, `%`, `s`, `r`, `/`, `\\`, `n`, `p`); `e` leaves it, `q` leaves the buffer too, killing one `view-file` read. `view-buffer` too. `tests/view.rs` checks them.

**Diffs** (`packages/diff.ts`, from diff.el and diff-mode.el): `diff` compares two files with `diff-command` and `diff-switches` (`-u`), the new file this buffer's and the old its newest backup by default, into `*Diff*`: the command, diff's output, and "Diff finished." with the time, as Emacs writes it. `diff-backup` and `diff-buffer-with-file` (the buffer against its file, labelled as Emacs labels them) too. In `diff-mode`, hunks and file headers are coloured, `n`, `p`, `N` and `P` move between hunks and files, RET and `o` show the source line in another window, and `g` runs the diff again. diff runs to the end before the buffer shows, where Emacs's runs alongside, and diff-mode cannot yet apply, split or refine hunks. `tests/diff.rs` checks them, as the time keeps them out of the Emacs comparison.

**Abbrevs** (`packages/abbrev.ts`, from abbrev.el): the global table and each major mode's. `add-global-abbrev` (`C-x a g`) and `add-mode-abbrev` (`C-x a l`) define one for the words before point or the region; `inverse-add-global-abbrev` (`C-x a i g`) and `inverse-add-mode-abbrev` (`C-x a i l`) define the word before point and expand it; `define-global-abbrev`, `define-mode-abbrev` and `kill-all-abbrevs` too. `expand-abbrev` (`C-x '`, `C-x a e`) expands the one before point, capitalizing as the abbrev was typed, as abbrev-insert does, and `abbrev-mode` expands as a character that ends a word is typed, through advice before `self-insert-command`. `list-abbrevs` and `edit-abbrevs` show the tables as `insert-abbrev-table-description` writes them, and `C-c C-c` there makes the edited text the abbrevs. Eight cases match Emacs (`abbrev.json`), and `tests/abbrev.rs` checks the listing against Emacs's text. Abbrevs are not saved to `abbrev_defs`.

**Dynamic abbreviations** (`packages/dabbrev.ts`, from dabbrev.el): `dabbrev-expand` on `M-/` expands the word before point to the nearest distinct word before it that starts the same way, then one after it, then one in other buffers (those in windows, then those of the same major mode, then the rest), saying which buffer. `M-/` again tries the next one, and after a space it copies the word that followed. Case follows `dabbrev-case-fold-search` and `dabbrev-case-replace`, as dabbrev--substitute-expansion works it out. Thirteen cases match Emacs (`dabbrev.json`), and `tests/dabbrev.rs` checks other buffers.

The Emacs comparison has 50 cases (`everyday.json`), 17 more for the second batch (`sort-and-lines.json`) and 12 for rectangles (`registers-and-rectangles.json`), all matching. Batch Emacs cannot answer a register's prompt, so `tests/registers.rs` types the keys instead. Ember's own tests cover what batch Emacs cannot record: `C-q` with octal digits, and `C-S-DEL` as a key.

## Consequences

The keys a newcomer from Emacs reaches for first now work as there.

Differences, in [differences.md](../differences.md):
- `zap-to-char` reads its character as a key, not from the minibuffer, so it has no history.
- `what-cursor-position` with a prefix argument does not describe the character (`describe-char`), and `what-cursor-show-names` has no names to show.

Still missing from the survey:
- `occur` with context lines (a prefix argument), `multi-occur` and `occur-edit-mode`, and the other sort.el commands (`sort-fields`, `sort-numeric-fields`, `sort-paragraphs`, `sort-regexp-fields`);
- `list-registers`, the register preview window, and `rectangle-mark-mode` (`C-x SPC`);
- `dabbrev-completion` (`C-M-/`), and dabbrev's search of the file name's parts;
- `view-read-only`, the visual `whitespace-mode`, `ibuffer`, and bookmark annotations and the bookmark list's other keys.

## Dependencies introduced

None.
