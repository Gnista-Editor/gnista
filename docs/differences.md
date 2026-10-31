# Where Ember differs from Emacs

Ember behaves as Emacs does, and the oracle in `tests/emacs/` checks it on recorded cases. This page lists where it does not: behaviour Ember has that works differently, either on purpose or because matching Emacs is not done yet. It is the place to look before reporting a difference, and the place to add one when it is found.

It does not list what Ember lacks altogether. That is in [plan.md](plan.md) (the gaps in the core) and in each ADR's consequences. Ideas for doing better than Emacs on purpose, later, are in [departures.md](departures.md). Cases the oracle knows differ are in [`tests/emacs/known-gaps.txt`](../tests/emacs/known-gaps.txt).

Each entry says whether the difference is **deliberate**, which keeps it, or **not yet** fixed.

## How code runs

- **Waiting for input** (deliberate): Emacs's Lisp waits inside `read-key`, `yes-or-no-p`, `read-from-minibuffer` and `recursive-edit` until the answer comes. Ember's commands return, and the answer runs code given with the request, which scripts write as `await` ([ADR 0030](adr/0030-the-command-loops-primitives.md)). What the user sees is the same; code after the question runs later rather than in the same call.
- **Keys and events** (deliberate, for now): events are key descriptions, `"C-x"` or `"<mouse-1>"`, not Lisp values carrying their positions. A mouse event's place is the last mouse event's, from `lastMouseEvent` ([ADR 0030](adr/0030-the-command-loops-primitives.md)).
- **Strings** (deliberate): JavaScript strings have no unibyte form. So `downcase` of an ASCII-only string follows a buffer's own case table, where Emacs's ignores it ([ADR 0032](adr/0032-character-tables.md)).
- **Positions in scripts** count characters, not JavaScript string indices, which differ for emoji ([ADR 0007](adr/0007-text-properties-faces-and-display-rows.md)).
- **Face heights** (deliberate): a whole number is an absolute height and a number with a fraction a factor, as Emacs reads them, but a script cannot write the factor 2.0 apart from 2 ([ADR 0029](adr/0029-redisplay-beyond-rows.md)).

## Keys and the command loop

- **`read-key-sequence` and ESC** (not yet): ESC then x reads as `M-x`, where Emacs's gives the two keys `ESC x`. `read-key` takes ESC alone, as Emacs does.
- **Abbrevs** (not yet) are not saved to `abbrev_defs` between sessions, a mode's table does not inherit its parent mode's, and `list-abbrevs` shows only the tables that have been used, where Emacs shows every mode's ([ADR 0040](adr/0040-everyday-editing-commands.md)).
- **`M-x diff`** (not yet) runs diff to the end before showing `*Diff*`, where Emacs shows its output as it comes, and diff-mode cannot apply, split or refine hunks ([ADR 0040](adr/0040-everyday-editing-commands.md)).
- **Highlighting by regexp** (not yet) always uses overlays, as Emacs does only in buffers without font-lock rules, so new text is not highlighted as it is typed; `hi-lock-file-patterns`, `hi-lock-write-interactive-patterns` and the big `hi-black-hb` face are missing.
- **The buffer list** (not yet): `t`, the `M-s a` searches and grouping (`Buffer-menu-group-by`) are missing ([ADR 0040](adr/0040-everyday-editing-commands.md), [ADR 0041](adr/0041-header-line-and-tabulated-lists.md)).
- **The header line and tabulated lists** (not yet): a click on the header line is not a `<header-line> <mouse-1>` event, so clicking a column title does not sort by it (`S` does); `header-line-indent-mode` does not follow the line numbers' width; tabulated lists have no groups (`tabulated-list-groups`); and a cut column ends in `…` whether or not the terminal can show it, where Emacs falls back to `...` ([ADR 0041](adr/0041-header-line-and-tabulated-lists.md)).
- **`undo-only`** (not yet) passes over the last undo and the change it undid once, as Emacs's does when its `undo-equiv-table` finds them. After a command that failed, Emacs's finds nothing, as the failure leaves an undo boundary, and redoes as `undo` would; Ember's still passes over them.
- **`zap-to-char`** (not yet) reads its character as a key rather than from the minibuffer, so there is no history to go back through ([ADR 0040](adr/0040-everyday-editing-commands.md)).
- **`what-cursor-position`** (not yet) with a prefix argument does not describe the character, as `describe-char` is not there, and shows no character names.
- **`sleep-for`** (not yet): keys typed while a command sleeps run their commands at once, where Emacs keeps them until the command ends.
- **Translation keymaps** (not yet): `input-decode-map` and `key-translation-map` translate the keys the command loop reads, but not those `read-key-sequence` reads partway through a command, and there is no `function-key-map`.
- **`this-command-keys`** (not yet): keys a command reads with `read-event` are not added to it, as Emacs adds them.
- **Disabled commands** (not yet): `upcase-region`, `downcase-region` and the others novice.el disables for new users run straight away.
- **Errors' wording** (deliberate): deleting more characters than there are says "End of buffer", where Emacs reports an internal "Args out of range" naming the buffer. The text is the same in both.

## Text and search

- **Literal searches** (not yet) fold case by the standard case table, not by a buffer's own; regexp searches follow the buffer's.
- **Case equivalence tables** (not yet): a case table's third extra slot is not worked out.
- **Putting text properties** (not yet) records no undo, does not mark the buffer modified and runs no change hooks, as if Emacs's `with-silent-modifications` were around every call. Ember's packages fontify and fold this way, as Emacs's font-lock does inside that macro, so a package that relies on properties being undone does not work yet ([ADR 0034](adr/0034-buffer-and-text-property-primitives.md)).
- **Indirect buffers** (not yet): Org's `org-indirect-buffer-display` frames are not titled after the heading, and `org-cycle-hook` is not run after `C-c C-x b` ([ADR 0034](adr/0034-buffer-and-text-property-primitives.md)).
- **`buffer-undo-list`** (not yet) can be read, with positions counted from 0, but not written or let-bound; turning undo off is `bufferDisableUndo` ([ADR 0034](adr/0034-buffer-and-text-property-primitives.md)).
- **Display strings next to each other** (not yet): a `display` property over several characters shows once if the strings are equal, where Emacs shows each character's string apart unless they are the same object. `read-passwd` therefore hides a password with one string of stars, so the cursor shows after them rather than among them when point is moved inside.
- **Faces as attribute lists** in a `face` property, `(:height 1.5)`, are not read (not yet); faces are named.
- **`text-scale-adjust`** (not yet) has no lower limit, where Emacs stops at the smallest font a frame can show.

- **Tree-sitter queries** (not yet) are strings in tree-sitter's syntax; Emacs's Lisp-form queries are not read. In a string, Emacs 30 cannot run its own predicates, `#equal`, `#match` and `#pred`, where Ember can ([ADR 0036](adr/0036-tree-sitter-for-scripts.md)).
- **Tree-sitter and narrowing** (not yet): Emacs parses only the accessible part of a narrowed buffer, Ember all of it, so a node's positions may lie outside the narrowing ([ADR 0036](adr/0036-tree-sitter-for-scripts.md)).
- **Highlighting in tree-sitter modes** (not yet) comes from each grammar's own query, not the mode's `treesit-font-lock-rules`, so faces differ in places from Emacs's.

## Windows and frames

- **Window starts** (not yet): a window always starts at the start of a line. So in the terminal, `C-v` over continued lines scrolls by lines of text rather than screen rows ([ADR 0029](adr/0029-redisplay-beyond-rows.md)).
- **Quitting a window** (not yet): `quit-window` does not restore the window's old height, and does not hide a frame made for the buffer, where Emacs iconifies it ([ADR 0028](adr/0028-windows-as-objects.md)).
- **The buffer list** (not yet): frames have no buffer lists of their own, and a buffer made after another was buried comes before it, where Emacs puts it after. `previous-buffer`'s skip options (`switch-to-prev-buffer-skip`, `switch-to-visible-buffer`) are not there.
- **Window configurations** (not yet): a previous-buffer entry a window dropped after the configuration was saved comes back as it was then, not as a marker that followed edits.

## Files and the clipboard

- **Auto-revert** (not yet) polls every `auto-revert-interval` seconds rather than being told by the system ([ADR 0018](adr/0018-files-and-saving.md)).
- **The clipboard** (not yet): X11's primary selection is not used, and the terminal does not write the clipboard ([ADR 0031](adr/0031-the-system-clipboard.md)).
- **Dired** (not yet): `M-DEL` and `* c` read their mark as text and RET, where Emacs reads a key ([ADR 0022](adr/0022-dired-and-projects.md)).
- **`describe-current-coding-system`** (not yet) stops before Emacs's priority list for detecting coding systems and the coding systems it keeps for particular file names, as Ember detects in a fixed order ([ADR 0035](adr/0035-coding-systems-and-charsets.md)).
- **`directory-files`** (not yet) sorts the names even with NOSORT, where Emacs gives the directory's own order ([ADR 0033](adr/0033-file-primitives.md)).
- **File name handlers** (not yet) are asked by the primitives in ADR 0033 and by visiting and saving, but not yet by `expand-file-name`, `file-attributes` or the copying and renaming commands.
- **Raw bytes** (deliberate): bytes that are no text in their coding are the characters U+10FF80 to U+10FFFF, where Emacs's are beyond Unicode at #x3FFF80 to #x3FFFFF. They show and are written back as in Emacs ([ADR 0035](adr/0035-coding-systems-and-charsets.md)).
- **Unibyte strings** (deliberate): scripts hold bytes as strings of characters U+0000 to U+00FF, as Emacs prints unibyte strings, and a string with other characters stands for its UTF-8. So inserting `encodeCodingString`'s result shows Latin-1 letters where Emacs's shows `\303\251` ([ADR 0035](adr/0035-coding-systems-and-charsets.md)).
- **The `charset` text property** (not yet): Emacs puts it on text decoded in a charset's coding and uses it when encoding again. Ember has none, so `iso-2022-7bit` chooses each character's set by the text's script: JIS X 0208 for text with kana, KS C 5601 with Hangul, else GB 2312, where Emacs writes kana alone in GB 2312's set ([ADR 0035](adr/0035-coding-systems-and-charsets.md)).
- **Japanese files without a cookie** (not yet): Shift_JIS and EUC-JP open as Latin-1, as there are no language environments to prefer them; Emacs without a Japanese one opens Shift_JIS as `emacs-mule`, which Ember does not have ([ADR 0035](adr/0035-coding-systems-and-charsets.md)).
- **Saving text the coding cannot write** (not yet) asks for a coding without the `*Warning*` buffer Emacs shows listing the characters; written without asking, from code, it is saved as UTF-8.
- **Imenu** (not yet) makes the index afresh each time, so there is no `*Rescan*` item, and there is no menu bar index ([ADR 0039](adr/0039-imenu.md)).
- **Comint** (not yet) has no prompt regexps (`comint-use-prompt-regexp`) or completion at the prompt, and ANSI colours other than the 256-colour and RGB ones are faces of Ember's own rather than face attribute lists ([ADR 0038](adr/0038-comint-and-shell.md)).
- **Network connections** (not yet) connect while the command waits; `:nowait`, TLS and datagrams are not there ([ADR 0037](adr/0037-terminals-sockets-and-process-codings.md)).
- **Connecting or listening** (deliberate) asks the agent's permission while it acts, as running a program does.
- **Changing a file's modes or times** (deliberate) asks the agent's permission while it acts, as writing files does; Emacs has no agent to ask.

## Invisible differences

Kept for completeness, as they cannot be seen:

- Show Paren mode's idle timer exists only while the mode is on.
- The standard case and category tables are made as char-tables only when code asks for them.
- An indirect buffer keeps a copy of its base's text, which the editor keeps the same after every change, where Emacs keeps one copy ([ADR 0034](adr/0034-buffer-and-text-property-primitives.md)).
- Fields compare `field` values with `equal`, where Emacs uses `eq`; only two distinct strings with the same text tell them apart.
- **Isearch** (not yet) has no `M-p` and `M-n` through the search ring, `isearch-edit-string`, word, symbol or lax-whitespace search, lazy count, opening of invisible text as it passes, or scrolling while searching; its prompt shows no `isearch-fail` face on what fails to match ([ADR 0042](adr/0042-isearch-state-and-comint-history-search.md)).
