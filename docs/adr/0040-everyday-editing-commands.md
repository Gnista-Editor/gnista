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
- **`C-l`** is `recenter-top-bottom` (window.el): the line with point to the middle, then the top, then the bottom of the window, as `recenter-positions` says, with `scroll-margin`.
- **Defuns** (lisp.el): `mark-defun` (`C-M-h`), with the comments above the defun and extending when repeated, and `narrow-to-defun` (`C-x n d`).
- Twenty-six cases match Emacs (`everyday-2.json`).

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
- `list-buffers`;
- `move-to-window-line-top-bottom` (`M-r`), `pop-global-mark`, and `keyboard-escape-quit`.

## Dependencies introduced

None.
